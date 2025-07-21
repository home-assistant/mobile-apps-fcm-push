'use strict';

const { createMockRateLimitData, MockDataManager, getToday } = require('../utils/mock-factories');

const { assertRateLimits } = require('../utils/assertion-helpers');

const mockTimestamp = {
  fromDate: jest.fn((date) => ({ toDate: () => date })),
};

const mockDoc = jest.fn();
const mockSet = jest.fn();
const mockUpdate = jest.fn();
const mockGet = jest.fn();

const mockCollection = jest.fn(() => ({
  doc: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: mockDoc,
    })),
  })),
}));

const mockRunTransaction = jest.fn();

const mockGetFirestore = jest.fn(() => ({
  collection: mockCollection,
  runTransaction: mockRunTransaction,
}));

jest.mock('firebase-admin/firestore', () => ({
  getFirestore: mockGetFirestore,
  Timestamp: mockTimestamp,
}));

jest.mock('firebase-functions', () => ({
  logger: {
    info: jest.fn(),
  },
}));

const FirestoreRateLimiter = require('../../rate-limiter/firestore-rate-limiter');

describe('FirestoreRateLimiter', () => {
  let mockDataManager;
  let rateLimiter;
  const testToken = 'test-token-123';
  const maxNotificationsPerDay = 150;

  beforeEach(() => {
    jest.clearAllMocks();

    mockDataManager = new MockDataManager();

    // Set up fake timers starting at a specific date
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T10:00:00Z'));

    // Configure mock document behavior
    mockDoc.mockImplementation((tokenId) => ({
      path: `rateLimits/${getToday()}/tokens/${tokenId}`,
      get: mockGet.mockImplementation(async () => {
        return {
          exists: mockDataManager.hasRateLimitData(tokenId, getToday()),
          data: () => mockDataManager.getRateLimitData(tokenId, getToday()),
        };
      }),
      set: mockSet.mockImplementation(async (data) => {
        mockDataManager.setRateLimitData(tokenId, getToday(), data);
      }),
      update: mockUpdate.mockImplementation(async (data) => {
        const existing = mockDataManager.getRateLimitData(tokenId, getToday()) || {};
        mockDataManager.setRateLimitData(tokenId, getToday(), Object.assign({}, existing, data));
      }),
    }));

    // Configure transaction mock
    mockRunTransaction.mockImplementation(async (callback) => {
      const mockTransaction = {
        get: async () => {
          return {
            exists: mockDataManager.hasRateLimitData(testToken, getToday()),
            data: () => mockDataManager.getRateLimitData(testToken, getToday()),
          };
        },
        set: async (_, data) => {
          mockDataManager.setRateLimitData(testToken, getToday(), data);
          mockSet(data);
        },
        update: async (_, data) => {
          const existing = mockDataManager.getRateLimitData(testToken, getToday()) || {};
          const updated = Object.assign({}, existing, data);
          mockDataManager.setRateLimitData(testToken, getToday(), updated);
          mockUpdate(data);
        },
      };

      return await callback(mockTransaction);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Basic functionality', () => {
    test('should initialize with zero counts', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);
      const status = await rateLimiter.checkRateLimit(testToken);

      assertRateLimits.expectNotRateLimited(status);
      assertRateLimits.expectRateLimitCounts(status.rateLimits, {
        attempts: 0,
        successful: 0,
        errors: 0,
        remaining: maxNotificationsPerDay,
      });
    });

    // Parameterized tests for counter increments
    describe.each([
      ['success', 'recordSuccess', { successful: 1, total: 1, errors: 0 }],
      ['error', 'recordError', { successful: 0, total: 1, errors: 1 }],
    ])('%s counter increment', (type, method, expectedCounts) => {
      test(`should increment ${type} counter`, async () => {
        const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

        await rateLimiter.recordAttempt(testToken);
        await rateLimiter[method](testToken);

        const status = await rateLimiter.checkRateLimit(testToken);
        assertRateLimits.expectRateLimitCounts(
          status.rateLimits,
          Object.assign(
            {
              attempts: 1,
            },
            expectedCounts,
          ),
        );
      });
    });

    test('should enforce rate limit', async () => {
      const rateLimiter = new FirestoreRateLimiter(5); // Low limit for testing

      // Send 5 successful notifications
      const operations = [];
      for (let i = 0; i < 5; i++) {
        operations.push(async () => {
          await rateLimiter.recordAttempt(testToken);
          await rateLimiter.recordSuccess(testToken);
        });
      }

      // Execute operations sequentially
      await operations.reduce(async (prev, curr) => {
        await prev;
        return curr();
      }, Promise.resolve());

      // Check rate limit status after exactly reaching the limit
      let status = await rateLimiter.checkRateLimit(testToken);
      assertRateLimits.expectRateLimitNotification(status);
      assertRateLimits.expectRateLimitCounts(status.rateLimits, { remaining: 0 });

      // Try one more to go over the limit
      await rateLimiter.recordAttempt(testToken);
      await rateLimiter.recordSuccess(testToken);

      status = await rateLimiter.checkRateLimit(testToken);
      assertRateLimits.expectRateLimited(status, false); // Still rate limited, no notification
      assertRateLimits.expectRateLimitCounts(status.rateLimits, { remaining: 0 });
    });

    test('should call Firestore operations correctly', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

      await rateLimiter.checkRateLimit(testToken);
      expect(mockGet).toHaveBeenCalledTimes(1);

      await rateLimiter.recordAttempt(testToken);
      expect(mockSet).toHaveBeenCalledTimes(1);

      await rateLimiter.recordSuccess(testToken);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('Document storage functionality', () => {
    test('should store data for current date', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

      await rateLimiter.recordAttempt(testToken);
      await rateLimiter.recordSuccess(testToken);

      const storedData = mockDataManager.getRateLimitData(testToken, getToday());
      expect(storedData).toBeDefined();
      expect(storedData.deliveredCount).toBe(1);
      expect(storedData.attemptsCount).toBe(1);
    });

    test('resetsAt should show next day midnight', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);
      const status = await rateLimiter.checkRateLimit(testToken);

      const resetsAt = status.rateLimits.resetsAt;
      expect(resetsAt.getFullYear()).toBe(2024);
      expect(resetsAt.getMonth()).toBe(0); // January (0-indexed)
      expect(resetsAt.getDate()).toBe(2); // Next day
      expect(resetsAt.getHours()).toBe(0);
      expect(resetsAt.getMinutes()).toBe(0);
      expect(resetsAt.getSeconds()).toBe(0);
    });

    test('should handle multiple instances for same token', async () => {
      const rateLimiter1 = new FirestoreRateLimiter(maxNotificationsPerDay);
      const rateLimiter2 = new FirestoreRateLimiter(maxNotificationsPerDay);

      await rateLimiter1.recordAttempt(testToken);
      await rateLimiter1.recordSuccess(testToken);

      const status = await rateLimiter2.checkRateLimit(testToken);
      assertRateLimits.expectRateLimitCounts(status.rateLimits, { successful: 1 });
    });
  });

  describe('Debug mode', () => {
    test('should not log in debug mode (removed debug logging)', async () => {
      const functions = require('firebase-functions');
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay, true);

      await rateLimiter.recordAttempt(testToken);
      await rateLimiter.recordSuccess(testToken);

      expect(functions.logger.info).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases and error handling', () => {
    // Parameterized tests for edge cases
    describe.each([
      ['recordSuccess', { attempts: 0, successful: 1, total: 1, errors: 0 }],
      ['recordError', { attempts: 0, successful: 0, total: 1, errors: 1 }],
    ])('%s without prior recordAttempt', (method, expectedCounts) => {
      test(`should handle ${method} without prior recordAttempt`, async () => {
        const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

        const result = await rateLimiter[method](testToken);

        assertRateLimits.expectRateLimitCounts(result, expectedCounts);
        expect(mockSet).toHaveBeenCalledTimes(1);
      });
    });

    test('should handle negative remaining count', async () => {
      const rateLimiter = new FirestoreRateLimiter(5);

      // Create a doc with more delivered than max allowed
      mockDataManager.setRateLimitData(
        testToken,
        getToday(),
        createMockRateLimitData({
          attemptsCount: 10,
          deliveredCount: 10, // More than max (5)
          errorCount: 0,
          totalCount: 10,
        }),
      );

      const status = await rateLimiter.checkRateLimit(testToken);
      assertRateLimits.expectRateLimitCounts(status.rateLimits, { remaining: 0 });
      assertRateLimits.expectRateLimited(status);
    });

    test('should handle missing fields in document data', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

      // Create a doc with missing fields
      mockDataManager.setRateLimitData(testToken, getToday(), {
        deliveredCount: 5,
        totalCount: 5,
        // Missing attemptsCount, errorCount, etc.
      });

      const status = await rateLimiter.checkRateLimit(testToken);
      assertRateLimits.expectRateLimitCounts(status.rateLimits, {
        attempts: 0,
        errors: 0,
        successful: 5,
        total: 5,
      });
    });

    // Parameterized tests for error handling
    describe.each([
      [
        'transaction',
        'recordAttempt',
        () => mockRunTransaction.mockRejectedValueOnce(new Error('Transaction failed')),
      ],
      [
        'Firestore get',
        'checkRateLimit',
        () => mockGet.mockRejectedValueOnce(new Error('Firestore unavailable')),
      ],
    ])('%s errors', (errorType, method, setupError) => {
      test(`should handle ${errorType} errors`, async () => {
        const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

        setupError();

        await expect(rateLimiter[method](testToken)).rejects.toThrow();
      });
    });
  });

  describe('Concurrent operations', () => {
    test('should handle concurrent recordAttempt calls', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

      // Execute 5 recordAttempt operations sequentially using reduce
      await Array.from({ length: 5 }).reduce(async (prev) => {
        await prev;
        return rateLimiter.recordAttempt(testToken);
      }, Promise.resolve());

      const status = await rateLimiter.checkRateLimit(testToken);
      assertRateLimits.expectRateLimitCounts(status.rateLimits, { attempts: 5 });
    });

    test('should handle mixed concurrent operations', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

      await rateLimiter.recordAttempt(testToken);

      const promises = [
        rateLimiter.recordSuccess(testToken),
        rateLimiter.recordError(testToken),
        rateLimiter.recordSuccess(testToken),
      ];

      await Promise.all(promises);

      const status = await rateLimiter.checkRateLimit(testToken);
      assertRateLimits.expectRateLimitCounts(status.rateLimits, {
        successful: 2,
        errors: 1,
        total: 3,
      });
    });
  });

  describe('Different token scenarios', () => {
    test('should handle multiple different tokens independently', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);
      const token1 = 'token-1';
      const token2 = 'token-2';

      // Update mock to handle different tokens
      mockRunTransaction.mockImplementation(async (callback) => {
        const mockTransaction = {
          get: async (docRef) => {
            const tokenMatch = docRef.path ? docRef.path.match(/tokens\/([^/]+)$/) : null;
            const tokenId = tokenMatch ? tokenMatch[1] : testToken;

            return {
              exists: mockDataManager.hasRateLimitData(tokenId, getToday()),
              data: () => mockDataManager.getRateLimitData(tokenId, getToday()),
            };
          },
          set: async (docRef, data) => {
            const tokenMatch = docRef.path ? docRef.path.match(/tokens\/([^/]+)$/) : null;
            const tokenId = tokenMatch ? tokenMatch[1] : testToken;

            mockDataManager.setRateLimitData(tokenId, getToday(), data);
          },
          update: async (docRef, data) => {
            const tokenMatch = docRef.path ? docRef.path.match(/tokens\/([^/]+)$/) : null;
            const tokenId = tokenMatch ? tokenMatch[1] : testToken;

            const existing = mockDataManager.getRateLimitData(tokenId, getToday()) || {};
            mockDataManager.setRateLimitData(
              tokenId,
              getToday(),
              Object.assign({}, existing, data),
            );
          },
        };

        return await callback(mockTransaction);
      });

      // Record activity for token1
      await rateLimiter.recordAttempt(token1);
      await rateLimiter.recordSuccess(token1);

      // Record different activity for token2
      await rateLimiter.recordAttempt(token2);
      await rateLimiter.recordError(token2);

      // Check they are independent
      const status1 = await rateLimiter.checkRateLimit(token1);
      const status2 = await rateLimiter.checkRateLimit(token2);

      assertRateLimits.expectRateLimitCounts(status1.rateLimits, { successful: 1, errors: 0 });
      assertRateLimits.expectRateLimitCounts(status2.rateLimits, { successful: 0, errors: 1 });
    });

    test('should handle tokens with special characters', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);
      const specialToken = 'token:with/special@chars#123';

      await rateLimiter.recordAttempt(specialToken);
      await rateLimiter.recordSuccess(specialToken);

      const status = await rateLimiter.checkRateLimit(specialToken);
      assertRateLimits.expectRateLimitCounts(status.rateLimits, { successful: 1 });
    });
  });

  describe('Timestamp and date handling', () => {
    test('should correctly calculate end of day timestamp', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

      // Set time to 3 PM UTC
      jest.setSystemTime(new Date('2024-01-01T15:00:00Z'));

      await rateLimiter.recordAttempt(testToken);

      const storedData = mockDataManager.getRateLimitData(testToken, getToday());
      expect(storedData).toBeDefined();

      // Verify Timestamp.fromDate was called with end of day
      expect(mockTimestamp.fromDate).toHaveBeenCalled();
      const endOfDayCall = mockTimestamp.fromDate.mock.calls[0][0];

      const expectedEndOfDay = new Date('2024-01-02T00:00:00Z');
      expect(endOfDayCall.getTime()).toBe(expectedEndOfDay.getTime());
    });

    test('should use correct date for document path', async () => {
      const rateLimiter = new FirestoreRateLimiter(maxNotificationsPerDay);

      // Test at year boundary
      jest.setSystemTime(new Date('2023-12-31T23:59:59Z'));

      await rateLimiter.recordAttempt(testToken);

      // Should use 20231231 as the date
      const storedData = mockDataManager.getRateLimitData(testToken, '20231231');
      expect(storedData).toBeDefined();
    });
  });
});
