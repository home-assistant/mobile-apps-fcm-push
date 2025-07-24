'use strict';

const { GlideClusterClient, ClusterBatch } = require('@valkey/valkey-glide');
const { getToday } = require('../../rate-limiter/util');

jest.mock('@valkey/valkey-glide', () => ({
  GlideClusterClient: {
    createClient: jest.fn(),
  },
  ClusterBatch: jest.fn(),
}));

const ValkeyRateLimiter = require('../../rate-limiter/valkey-rate-limiter');

describe('ValkeyRateLimiter', () => {
  let mockClient;
  let mockBatch;
  let rateLimiter;
  const testToken = 'test-token-123';
  const maxNotificationsPerDay = 150;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up fake timers starting at a specific date
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T10:00:00Z'));

    // Mock Valkey client instance
    mockClient = {
      hgetall: jest.fn(),
      exec: jest.fn(),
      close: jest.fn(),
    };

    // Mock ClusterBatch
    mockBatch = {
      hincrby: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      hgetall: jest.fn().mockReturnThis(),
    };

    ClusterBatch.mockImplementation((isAtomic) => {
      // Verify that atomic batches are being used for rate limiting
      expect(isAtomic).toBe(true);
      return mockBatch;
    });

    // Mock the createClient method
    GlideClusterClient.createClient.mockResolvedValue(mockClient);

    rateLimiter = new ValkeyRateLimiter(maxNotificationsPerDay);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Basic functionality', () => {
    test('should initialize with zero counts', async () => {
      mockClient.hgetall.mockResolvedValue({});

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

    test('should atomically increment attempts counter', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        'OK',
        { attemptsCount: '1', deliveredCount: '0', errorCount: '0', totalCount: '0' },
      ]);

      const status = await rateLimiter.recordAttempt(testToken);

      expect(mockBatch.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'attemptsCount',
        1,
      );
      expect(mockBatch.expire).toHaveBeenCalled();
      expect(status.rateLimits.attempts).toBe(1);
    });

    test('should atomically increment success counters', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        1,
        'OK',
        { attemptsCount: '1', deliveredCount: '1', errorCount: '0', totalCount: '1' },
      ]);

      const rateLimits = await rateLimiter.recordSuccess(testToken);

      expect(mockBatch.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'deliveredCount',
        1,
      );
      expect(mockBatch.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'totalCount',
        1,
      );
      expect(rateLimits.successful).toBe(1);
      expect(rateLimits.total).toBe(1);
    });

    test('should atomically increment error counters', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        1,
        'OK',
        { attemptsCount: '1', deliveredCount: '0', errorCount: '1', totalCount: '1' },
      ]);

      const rateLimits = await rateLimiter.recordError(testToken);

      expect(mockBatch.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'errorCount',
        1,
      );
      expect(mockBatch.hincrby).toHaveBeenCalledWith(
        `rate_limit:${testToken}:${getToday()}`,
        'totalCount',
        1,
      );
      expect(rateLimits.errors).toBe(1);
      expect(rateLimits.total).toBe(1);
    });

    test('should enforce rate limit', async () => {
      const lowLimitRateLimiter = new ValkeyRateLimiter(5); // Low limit for testing

      mockClient.hgetall.mockResolvedValue({
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

  describe('Valkey key generation', () => {
    test('should use correct Valkey key format', async () => {
      mockClient.hgetall.mockResolvedValue({});

      await rateLimiter.checkRateLimit(testToken);

      expect(mockClient.hgetall).toHaveBeenCalledWith(`rate_limit:${testToken}:${getToday()}`);
    });

    test('should set correct TTL for keys', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        'OK',
        { attemptsCount: '1', deliveredCount: '0', errorCount: '0', totalCount: '0' },
      ]);

      await rateLimiter.recordAttempt(testToken);

      // At 10:00 UTC, TTL should be 14 hours (50400 seconds) until end of day
      expect(mockBatch.expire).toHaveBeenCalledWith(`rate_limit:${testToken}:${getToday()}`, 50400);
    });
  });

  describe('Data parsing', () => {
    test('should handle missing fields in Valkey data', async () => {
      mockClient.hgetall.mockResolvedValue({
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
      mockClient.hgetall.mockResolvedValue({
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

    test('should handle all fields present in Valkey data', async () => {
      mockClient.hgetall.mockResolvedValue({
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

    test('should handle completely empty Valkey response', async () => {
      mockClient.hgetall.mockResolvedValue({});

      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.total).toBe(0);
    });

    test('should handle data fields in recordAttempt response', async () => {
      mockClient.exec.mockResolvedValue([
        6,
        'OK',
        {
          attemptsCount: '6',
          deliveredCount: '5',
          errorCount: '1',
          totalCount: '6',
        },
      ]);

      const status = await rateLimiter.recordAttempt(testToken);

      expect(status.rateLimits.attempts).toBe(6);
      expect(status.rateLimits.successful).toBe(5);
      expect(status.rateLimits.errors).toBe(1);
      expect(status.rateLimits.total).toBe(6);
    });

    test('should handle data fields in recordSuccess response', async () => {
      mockClient.exec.mockResolvedValue([
        6,
        11,
        'OK',
        {
          attemptsCount: '10',
          deliveredCount: '6',
          errorCount: '5',
          totalCount: '11',
        },
      ]);

      const rateLimits = await rateLimiter.recordSuccess(testToken);

      expect(rateLimits.attempts).toBe(10);
      expect(rateLimits.successful).toBe(6);
      expect(rateLimits.errors).toBe(5);
      expect(rateLimits.total).toBe(11);
    });

    test('should handle data fields in recordError response', async () => {
      mockClient.exec.mockResolvedValue([
        3,
        8,
        'OK',
        {
          attemptsCount: '8',
          deliveredCount: '5',
          errorCount: '3',
          totalCount: '8',
        },
      ]);

      const rateLimits = await rateLimiter.recordError(testToken);

      expect(rateLimits.attempts).toBe(8);
      expect(rateLimits.successful).toBe(5);
      expect(rateLimits.errors).toBe(3);
      expect(rateLimits.total).toBe(8);
    });
  });

  describe('Error handling', () => {
    test('should handle Valkey connection errors', async () => {
      mockClient.hgetall.mockRejectedValue(new Error('Valkey connection failed'));

      await expect(rateLimiter.checkRateLimit(testToken)).rejects.toThrow(
        'Valkey connection failed',
      );
    });

    test('should handle atomic batch execution errors', async () => {
      mockClient.exec.mockRejectedValue(new Error('Atomic batch execution failed'));

      await expect(rateLimiter.recordAttempt(testToken)).rejects.toThrow(
        'Atomic batch execution failed',
      );
    });
  });

  describe('Atomic batch operations', () => {
    test('should use atomic ClusterBatch for rate limiting operations', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        'OK',
        { attemptsCount: '1', deliveredCount: '0', errorCount: '0', totalCount: '0' },
      ]);

      await rateLimiter.recordAttempt(testToken);

      // The ClusterBatch mock already verifies isAtomic is true in the beforeEach
      expect(ClusterBatch).toHaveBeenCalledWith(true);
    });
  });

  describe('Connection management', () => {
    test('should close Valkey connection', async () => {
      mockClient.close.mockResolvedValue();

      // Need to connect first before closing
      await rateLimiter.connect();
      await rateLimiter.close();

      expect(mockClient.close).toHaveBeenCalled();
    });

    test('should connect only once', async () => {
      await rateLimiter.connect();
      await rateLimiter.connect();

      expect(GlideClusterClient.createClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('Rate limit edge cases', () => {
    test('should handle negative remaining count', async () => {
      mockClient.hgetall.mockResolvedValue({
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
      mockClient.hgetall.mockResolvedValue({
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
      mockClient.hgetall.mockResolvedValue({});

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
      mockClient.hgetall.mockImplementation((key) => {
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
      mockClient.hgetall.mockResolvedValue({});

      await rateLimiter.checkRateLimit(testToken);

      expect(mockClient.hgetall).toHaveBeenCalledWith(`rate_limit:${testToken}:20231231`);
    });

    test('should calculate correct TTL near midnight', async () => {
      jest.setSystemTime(new Date('2024-01-01T23:59:00Z'));

      mockClient.exec.mockResolvedValue([
        1,
        'OK',
        { attemptsCount: '1', deliveredCount: '0', errorCount: '0', totalCount: '0' },
      ]);

      await rateLimiter.recordAttempt(testToken);

      // 1 minute until midnight = 60 seconds
      expect(mockBatch.expire).toHaveBeenCalledWith(`rate_limit:${testToken}:${getToday()}`, 60);
    });
  });

  describe('Valkey connection configuration', () => {
    test('should initialize with custom Valkey host and port', async () => {
      const customHost = 'valkey.example.com';
      const customPort = 6380;

      // Create a new instance with custom host and port
      const customRateLimiter = new ValkeyRateLimiter(
        maxNotificationsPerDay,
        false,
        customHost,
        customPort,
      );
      await customRateLimiter.connect();

      expect(GlideClusterClient.createClient).toHaveBeenCalledWith({
        addresses: [{ host: customHost, port: customPort }],
        requestTimeout: 500,
        clientName: 'RateLimiterClient',
      });
    });

    test('should handle debug parameter', () => {
      // Create instance with debug enabled
      const debugRateLimiter = new ValkeyRateLimiter(maxNotificationsPerDay, true);
      expect(debugRateLimiter.debug).toBe(true);

      // Default instance should have debug disabled
      expect(rateLimiter.debug).toBe(false);
    });
  });

  describe('Constructor defaults', () => {
    test('should use default Valkey connection parameters', async () => {
      // Clear previous mock calls
      GlideClusterClient.createClient.mockClear();

      // Create instance without specifying host/port
      const defaultRateLimiter = new ValkeyRateLimiter(maxNotificationsPerDay);
      await defaultRateLimiter.connect();

      expect(GlideClusterClient.createClient).toHaveBeenCalledWith({
        addresses: [{ host: 'localhost', port: 6379 }],
        requestTimeout: 500,
        clientName: 'RateLimiterClient',
      });
    });
  });

  describe('_getRateLimitsObject edge cases', () => {
    test('should handle doc with zero values', async () => {
      // Create a scenario where _getRateLimitsObject is called with all zeros
      mockClient.exec.mockResolvedValue([
        1,
        'OK',
        {
          attemptsCount: '0',
          deliveredCount: '0',
          errorCount: '0',
          totalCount: '0',
        },
      ]);

      const status = await rateLimiter.recordAttempt(testToken);

      // The values should be parsed correctly even with zeros
      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.total).toBe(0);
    });

    test('should handle empty strings in batch results', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        1,
        'OK',
        {
          attemptsCount: '',
          deliveredCount: '',
          errorCount: '',
          totalCount: '',
        },
      ]);

      const rateLimits = await rateLimiter.recordSuccess(testToken);

      expect(rateLimits.attempts).toBe(0);
      expect(rateLimits.successful).toBe(0);
      expect(rateLimits.errors).toBe(0);
      expect(rateLimits.total).toBe(0);
    });

    test('should handle missing fields in recordAttempt batch result', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        'OK',
        {
          // All fields missing - tests the || '0' branches
        },
      ]);

      const status = await rateLimiter.recordAttempt(testToken);

      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.total).toBe(0);
    });

    test('should handle missing fields in recordError batch result', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        1,
        'OK',
        {
          // All fields missing - tests the || '0' branches
        },
      ]);

      const rateLimits = await rateLimiter.recordError(testToken);

      expect(rateLimits.attempts).toBe(0);
      expect(rateLimits.successful).toBe(0);
      expect(rateLimits.errors).toBe(0);
      expect(rateLimits.total).toBe(0);
    });

    test('should handle undefined values in recordSuccess batch result', async () => {
      mockClient.exec.mockResolvedValue([
        1,
        1,
        'OK',
        {
          attemptsCount: undefined,
          deliveredCount: undefined,
          errorCount: undefined,
          totalCount: undefined,
        },
      ]);

      const rateLimits = await rateLimiter.recordSuccess(testToken);

      expect(rateLimits.attempts).toBe(0);
      expect(rateLimits.successful).toBe(0);
      expect(rateLimits.errors).toBe(0);
      expect(rateLimits.total).toBe(0);
    });
  });
});
