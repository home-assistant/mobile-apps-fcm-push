'use strict';

const Redis = require('ioredis');
const { getToday } = require('../../rate-limiter/util');

jest.mock('ioredis');

const RedisRateLimiter = require('../../rate-limiter/redis-rate-limiter');

describe('RedisRateLimiter', () => {
  let mockRedis;
  let rateLimiter;
  let retryStrategyFn;
  const testToken = 'test-token-123';
  const maxNotificationsPerDay = 150;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up fake timers starting at a specific date
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T10:00:00Z'));

    // Mock Redis instance
    mockRedis = {
      hgetall: jest.fn(),
      pipeline: jest.fn(),
      hincrby: jest.fn(),
      expire: jest.fn(),
      quit: jest.fn(),
    };

    // Mock pipeline execution
    const mockPipeline = {
      hincrby: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      hgetall: jest.fn().mockReturnThis(),
      exec: jest.fn(),
    };

    mockRedis.pipeline.mockReturnValue(mockPipeline);

    // Capture the retry strategy function
    Redis.mockImplementation((config) => {
      retryStrategyFn = config.retryStrategy;
      return mockRedis;
    });

    rateLimiter = new RedisRateLimiter(maxNotificationsPerDay);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Basic functionality', () => {
    test('should initialize with zero counts', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.isRateLimited).toBe(false);
      expect(status.shouldSendRateLimitNotification).toBe(false);
      expect(status.rateLimits).toEqual({
        attempts: 0,
        successful: 0,
        errors: 0,
        total: 0,
        maximum: maxNotificationsPerDay,
        remaining: maxNotificationsPerDay,
        resetsAt: new Date('2024-01-02T00:00:00.000Z'),
      });
    });

    test('should increment attempts counter', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 'OK'],
        [null, { attemptsCount: '1', deliveredCount: '0', errorCount: '0', totalCount: '0' }],
      ]);

      const status = await rateLimiter.recordAttempt(testToken);

      expect(mockPipeline.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'attemptsCount',
        1,
      );
      expect(mockPipeline.expire).toHaveBeenCalled();
      expect(status.rateLimits.attempts).toBe(1);
    });

    test('should increment success counters', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 1],
        [null, 'OK'],
        [null, { attemptsCount: '1', deliveredCount: '1', errorCount: '0', totalCount: '1' }],
      ]);

      const rateLimits = await rateLimiter.recordSuccess(testToken);

      expect(mockPipeline.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'deliveredCount',
        1,
      );
      expect(mockPipeline.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'totalCount',
        1,
      );
      expect(rateLimits.successful).toBe(1);
      expect(rateLimits.total).toBe(1);
    });

    test('should increment error counters', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 1],
        [null, 'OK'],
        [null, { attemptsCount: '1', deliveredCount: '0', errorCount: '1', totalCount: '1' }],
      ]);

      const rateLimits = await rateLimiter.recordError(testToken);

      expect(mockPipeline.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'errorCount',
        1,
      );
      expect(mockPipeline.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'totalCount',
        1,
      );
      expect(rateLimits.errors).toBe(1);
      expect(rateLimits.total).toBe(1);
    });

    test('should enforce rate limit', async () => {
      const lowLimitRateLimiter = new RedisRateLimiter(5); // Low limit for testing

      mockRedis.hgetall.mockResolvedValue({
        attemptsCount: '5',
        deliveredCount: '5',
        errorCount: '0',
        totalCount: '5',
      });

      const status = await lowLimitRateLimiter.checkRateLimit(testToken);

      expect(status.isRateLimited).toBe(true);
      expect(status.shouldSendRateLimitNotification).toBe(true);
      expect(status.rateLimits.remaining).toBe(0);
    });
  });

  describe('Redis key generation', () => {
    test('should use correct Redis key format', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      await rateLimiter.checkRateLimit(testToken);

      expect(mockRedis.hgetall).toHaveBeenCalledWith(`rate_limit:${testToken}:${getToday()}`);
    });

    test('should set correct TTL for keys', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 'OK'],
        [null, { attemptsCount: '1', deliveredCount: '0', errorCount: '0', totalCount: '0' }],
      ]);

      await rateLimiter.recordAttempt(testToken);

      // At 10:00 UTC, TTL should be 14 hours (50400 seconds) until end of day
      expect(mockPipeline.expire).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        50400,
      );
    });
  });

  describe('Data parsing', () => {
    test('should handle missing fields in Redis data', async () => {
      mockRedis.hgetall.mockResolvedValue({
        attemptsCount: '5',
        // missing other fields
      });

      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.rateLimits.attempts).toBe(5);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.total).toBe(0);
    });

    test('should handle non-numeric values gracefully', async () => {
      mockRedis.hgetall.mockResolvedValue({
        attemptsCount: 'invalid',
        deliveredCount: 'abc',
        errorCount: null,
        totalCount: undefined,
      });

      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.total).toBe(0);
    });

    test('should handle all fields present in Redis data', async () => {
      mockRedis.hgetall.mockResolvedValue({
        attemptsCount: '10',
        deliveredCount: '8',
        errorCount: '2',
        totalCount: '10',
      });

      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.rateLimits.attempts).toBe(10);
      expect(status.rateLimits.successful).toBe(8);
      expect(status.rateLimits.errors).toBe(2);
      expect(status.rateLimits.total).toBe(10);
    });

    test('should handle completely empty Redis response', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.total).toBe(0);
    });

    test('should handle data fields in recordAttempt response', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 6],
        [null, 'OK'],
        [
          null,
          {
            attemptsCount: '6',
            deliveredCount: '5',
            errorCount: '1',
            totalCount: '6',
          },
        ],
      ]);

      const status = await rateLimiter.recordAttempt(testToken);

      expect(status.rateLimits.attempts).toBe(6);
      expect(status.rateLimits.successful).toBe(5);
      expect(status.rateLimits.errors).toBe(1);
      expect(status.rateLimits.total).toBe(6);
    });

    test('should handle data fields in recordSuccess response', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 6],
        [null, 11],
        [null, 'OK'],
        [
          null,
          {
            attemptsCount: '10',
            deliveredCount: '6',
            errorCount: '5',
            totalCount: '11',
          },
        ],
      ]);

      const rateLimits = await rateLimiter.recordSuccess(testToken);

      expect(rateLimits.attempts).toBe(10);
      expect(rateLimits.successful).toBe(6);
      expect(rateLimits.errors).toBe(5);
      expect(rateLimits.total).toBe(11);
    });

    test('should handle data fields in recordError response', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 3],
        [null, 8],
        [null, 'OK'],
        [
          null,
          {
            attemptsCount: '8',
            deliveredCount: '5',
            errorCount: '3',
            totalCount: '8',
          },
        ],
      ]);

      const rateLimits = await rateLimiter.recordError(testToken);

      expect(rateLimits.attempts).toBe(8);
      expect(rateLimits.successful).toBe(5);
      expect(rateLimits.errors).toBe(3);
      expect(rateLimits.total).toBe(8);
    });
  });

  describe('Error handling', () => {
    test('should handle Redis connection errors', async () => {
      mockRedis.hgetall.mockRejectedValue(new Error('Redis connection failed'));

      await expect(rateLimiter.checkRateLimit(testToken)).rejects.toThrow(
        'Redis connection failed',
      );
    });

    test('should handle pipeline execution errors', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockRejectedValue(new Error('Pipeline execution failed'));

      await expect(rateLimiter.recordAttempt(testToken)).rejects.toThrow(
        'Pipeline execution failed',
      );
    });
  });

  describe('Connection management', () => {
    test('should close Redis connection', async () => {
      mockRedis.quit.mockResolvedValue('OK');

      await rateLimiter.close();

      expect(mockRedis.quit).toHaveBeenCalled();
    });
  });

  describe('Rate limit edge cases', () => {
    test('should handle negative remaining count', async () => {
      mockRedis.hgetall.mockResolvedValue({
        attemptsCount: '10',
        deliveredCount: '200', // More than max allowed
        errorCount: '0',
        totalCount: '200',
      });

      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.rateLimits.remaining).toBe(0);
      expect(status.isRateLimited).toBe(true);
    });

    test('should calculate positive remaining count correctly', async () => {
      mockRedis.hgetall.mockResolvedValue({
        attemptsCount: '50',
        deliveredCount: '50',
        errorCount: '0',
        totalCount: '50',
      });

      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.rateLimits.remaining).toBe(100); // 150 - 50 = 100
      expect(status.isRateLimited).toBe(false);
    });

    test('resetsAt should show next day midnight', async () => {
      mockRedis.hgetall.mockResolvedValue({});

      const status = await rateLimiter.checkRateLimit(testToken);

      // We're at 2024-01-01T10:00:00Z, so reset should be at 2024-01-02T00:00:00Z
      expect(status.rateLimits.resetsAt).toEqual(new Date('2024-01-02T00:00:00.000Z'));
    });
  });

  describe('Multiple tokens', () => {
    test('should handle multiple different tokens independently', async () => {
      const token1 = 'token-1';
      const token2 = 'token-2';

      // Set up different responses for different tokens
      mockRedis.hgetall.mockImplementation((key) => {
        if (key.includes(token1)) {
          return Promise.resolve({
            attemptsCount: '5',
            deliveredCount: '3',
            errorCount: '2',
            totalCount: '5',
          });
        } else if (key.includes(token2)) {
          return Promise.resolve({
            attemptsCount: '10',
            deliveredCount: '8',
            errorCount: '2',
            totalCount: '10',
          });
        }
        return Promise.resolve({});
      });

      const status1 = await rateLimiter.checkRateLimit(token1);
      const status2 = await rateLimiter.checkRateLimit(token2);

      expect(status1.rateLimits.attempts).toBe(5);
      expect(status1.rateLimits.successful).toBe(3);
      expect(status2.rateLimits.attempts).toBe(10);
      expect(status2.rateLimits.successful).toBe(8);
    });
  });

  describe('Date boundary handling', () => {
    test('should use correct date at year boundary', async () => {
      jest.setSystemTime(new Date('2023-12-31T23:59:59Z'));
      mockRedis.hgetall.mockResolvedValue({});

      await rateLimiter.checkRateLimit(testToken);

      expect(mockRedis.hgetall).toHaveBeenCalledWith(`rate_limit:${testToken}:20231231`);
    });

    test('should calculate correct TTL near midnight', async () => {
      jest.setSystemTime(new Date('2024-01-01T23:59:00Z'));

      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 'OK'],
        [null, { attemptsCount: '1', deliveredCount: '0', errorCount: '0', totalCount: '0' }],
      ]);

      await rateLimiter.recordAttempt(testToken);

      // 1 minute until midnight = 60 seconds
      expect(mockPipeline.expire).toHaveBeenCalledWith(`rate_limit:${testToken}:${getToday()}`, 60);
    });
  });

  describe('Redis connection and retry strategy', () => {
    test('should initialize with custom Redis host and port', () => {
      const customHost = 'redis.example.com';
      const customPort = 6380;

      // Create a new instance with custom host and port
      new RedisRateLimiter(maxNotificationsPerDay, false, customHost, customPort);

      expect(Redis).toHaveBeenCalledWith({
        host: customHost,
        port: customPort,
        retryStrategy: expect.any(Function),
      });
    });

    test('should have proper retry strategy', () => {
      // retryStrategyFn was captured during beforeEach
      expect(retryStrategyFn).toBeDefined();

      // Test retry strategy with different attempt counts
      expect(retryStrategyFn(1)).toBe(50); // 1 * 50 = 50
      expect(retryStrategyFn(10)).toBe(500); // 10 * 50 = 500
      expect(retryStrategyFn(40)).toBe(2000); // 40 * 50 = 2000 (capped)
      expect(retryStrategyFn(50)).toBe(2000); // 50 * 50 = 2500 -> capped at 2000
      expect(retryStrategyFn(100)).toBe(2000); // 100 * 50 = 5000 -> capped at 2000
    });

    test('should handle debug parameter', () => {
      // Create instance with debug enabled
      const debugRateLimiter = new RedisRateLimiter(maxNotificationsPerDay, true);
      expect(debugRateLimiter.debug).toBe(true);

      // Default instance should have debug disabled
      expect(rateLimiter.debug).toBe(false);
    });
  });

  describe('Constructor defaults', () => {
    test('should use default Redis connection parameters', () => {
      // Clear previous mock calls
      Redis.mockClear();

      // Create instance without specifying host/port
      new RedisRateLimiter(maxNotificationsPerDay);

      expect(Redis).toHaveBeenCalledWith({
        host: 'localhost',
        port: 6379,
        retryStrategy: expect.any(Function),
      });
    });
  });

  describe('_getRateLimitsObject edge cases', () => {
    test('should handle doc with zero values', async () => {
      // Create a scenario where _getRateLimitsObject is called with all zeros
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 'OK'],
        [
          null,
          {
            attemptsCount: '0',
            deliveredCount: '0',
            errorCount: '0',
            totalCount: '0',
          },
        ],
      ]);

      const status = await rateLimiter.recordAttempt(testToken);

      // The values should be parsed correctly even with zeros
      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.total).toBe(0);
    });

    test('should handle empty strings in pipeline results', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 1],
        [null, 'OK'],
        [
          null,
          {
            attemptsCount: '',
            deliveredCount: '',
            errorCount: '',
            totalCount: '',
          },
        ],
      ]);

      const rateLimits = await rateLimiter.recordSuccess(testToken);

      expect(rateLimits.attempts).toBe(0);
      expect(rateLimits.successful).toBe(0);
      expect(rateLimits.errors).toBe(0);
      expect(rateLimits.total).toBe(0);
    });

    test('should handle missing fields in recordAttempt pipeline result', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 'OK'],
        [
          null,
          {
            // All fields missing - tests the || '0' branches
          },
        ],
      ]);

      const status = await rateLimiter.recordAttempt(testToken);

      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.total).toBe(0);
    });

    test('should handle missing fields in recordError pipeline result', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 1],
        [null, 'OK'],
        [
          null,
          {
            // All fields missing - tests the || '0' branches
          },
        ],
      ]);

      const rateLimits = await rateLimiter.recordError(testToken);

      expect(rateLimits.attempts).toBe(0);
      expect(rateLimits.successful).toBe(0);
      expect(rateLimits.errors).toBe(0);
      expect(rateLimits.total).toBe(0);
    });

    test('should handle undefined values in recordSuccess pipeline result', async () => {
      const mockPipeline = mockRedis.pipeline();
      mockPipeline.exec.mockResolvedValue([
        [null, 1],
        [null, 1],
        [null, 'OK'],
        [
          null,
          {
            attemptsCount: undefined,
            deliveredCount: undefined,
            errorCount: undefined,
            totalCount: undefined,
          },
        ],
      ]);

      const rateLimits = await rateLimiter.recordSuccess(testToken);

      expect(rateLimits.attempts).toBe(0);
      expect(rateLimits.successful).toBe(0);
      expect(rateLimits.errors).toBe(0);
      expect(rateLimits.total).toBe(0);
    });
  });
});
