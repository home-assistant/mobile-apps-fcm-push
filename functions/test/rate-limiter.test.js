'use strict';

// Mock Firebase Admin
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

const RateLimiter = require('../rate-limiter');

describe('RateLimiter', () => {
  let mockData = {};
  const testToken = 'test-token-123';
  const maxNotificationsPerDay = 150;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset mock data
    mockData = {};

    // Set up fake timers starting at a specific date
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2024-01-01T10:00:00Z'));

    // Configure mock document behavior
    mockDoc.mockImplementation((tokenId) => ({
      path: `rateLimits/${getToday()}/tokens/${tokenId}`,
      get: mockGet.mockImplementation(async () => {
        const collectionName = 'rateLimits';
        const docId = getToday();
        const subCollectionName = 'tokens';
        const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
        return {
          exists: Boolean(mockData[key]),
          data: () => mockData[key],
        };
      }),
      set: mockSet.mockImplementation(async (data) => {
        const collectionName = 'rateLimits';
        const docId = getToday();
        const subCollectionName = 'tokens';
        const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
        mockData[key] = data;
      }),
      update: mockUpdate.mockImplementation(async (data) => {
        const collectionName = 'rateLimits';
        const docId = getToday();
        const subCollectionName = 'tokens';
        const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
        mockData[key] = Object.assign({}, mockData[key], data);
      }),
    }));

    // Configure transaction mock
    mockRunTransaction.mockImplementation(async (callback) => {
      const mockTransaction = {
        get: async (docRef) => {
          // Use testToken for consistency
          const tokenId = testToken;
          
          const collectionName = 'rateLimits';
          const docId = getToday();
          const subCollectionName = 'tokens';
          const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
          
          return {
            exists: Boolean(mockData[key]),
            data: () => mockData[key],
          };
        },
        set: async (docRef, data) => {
          const tokenId = testToken;
          
          const collectionName = 'rateLimits';
          const docId = getToday();
          const subCollectionName = 'tokens';
          const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
          
          mockData[key] = data;
          mockSet(data);
        },
        update: async (docRef, data) => {
          const tokenId = testToken;
          
          const collectionName = 'rateLimits';
          const docId = getToday();
          const subCollectionName = 'tokens';
          const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
          
          mockData[key] = Object.assign({}, mockData[key], data);
          mockUpdate(data);
        },
      };
      
      return await callback(mockTransaction);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Helper function to get today's date in YYYYMMDD format
  function getToday() {
    const today = new Date();
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yyyy = today.getFullYear();
    return yyyy + mm + dd;
  }

  describe('Basic functionality', () => {
    test('should initialize with zero counts', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      const status = await rateLimiter.checkRateLimit(testToken);

      expect(status.isRateLimited).toBe(false);
      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.remaining).toBe(maxNotificationsPerDay);
    });

    test('should increment counters on success', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);

      await rateLimiter.recordAttempt(testToken);
      await rateLimiter.recordSuccess(testToken);

      const status = await rateLimiter.checkRateLimit(testToken);
      expect(status.rateLimits.attempts).toBe(1);
      expect(status.rateLimits.successful).toBe(1);
      expect(status.rateLimits.total).toBe(1);
      expect(status.rateLimits.remaining).toBe(maxNotificationsPerDay - 1);
    });

    test('should increment counters on error', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);

      await rateLimiter.recordAttempt(testToken);
      await rateLimiter.recordError(testToken);

      const status = await rateLimiter.checkRateLimit(testToken);
      expect(status.rateLimits.attempts).toBe(1);
      expect(status.rateLimits.errors).toBe(1);
      expect(status.rateLimits.total).toBe(1);
      expect(status.rateLimits.remaining).toBe(maxNotificationsPerDay);
    });

    test('should enforce rate limit', async () => {
      const rateLimiter = new RateLimiter(5); // Low limit for testing

      // Send 5 successful notifications
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await rateLimiter.recordAttempt(testToken);
        // eslint-disable-next-line no-await-in-loop
        await rateLimiter.recordSuccess(testToken);
      }

      // Check rate limit status after exactly reaching the limit
      let status = await rateLimiter.checkRateLimit(testToken);
      expect(status.isRateLimited).toBe(true); // >= max means rate limited
      expect(status.shouldSendRateLimitNotification).toBe(true); // Exactly at limit
      expect(status.rateLimits.remaining).toBe(0);

      // Try one more to go over the limit
      await rateLimiter.recordAttempt(testToken);
      await rateLimiter.recordSuccess(testToken);

      status = await rateLimiter.checkRateLimit(testToken);
      expect(status.isRateLimited).toBe(true); // Still rate limited
      expect(status.shouldSendRateLimitNotification).toBe(false); // Only true when exactly at limit
      expect(status.rateLimits.remaining).toBe(0);
    });

    test('should call Firestore operations correctly', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);

      // First operation should call get
      await rateLimiter.checkRateLimit(testToken);
      expect(mockGet).toHaveBeenCalledTimes(1);

      // Recording attempt should use transaction
      await rateLimiter.recordAttempt(testToken);
      expect(mockSet).toHaveBeenCalledTimes(1);

      // Recording success should use transaction
      await rateLimiter.recordSuccess(testToken);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('Document storage functionality', () => {
    test('should store data for current date', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);

      await rateLimiter.recordAttempt(testToken);
      await rateLimiter.recordSuccess(testToken);

      // Check that data is stored under today's date
      const today = getToday();
      const key = `rateLimits/${today}/tokens/${testToken}`;
      expect(mockData[key]).toBeDefined();
      expect(mockData[key].deliveredCount).toBe(1);
      expect(mockData[key].attemptsCount).toBe(1);
    });

    test('resetsAt should show next day midnight', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
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
      const rateLimiter1 = new RateLimiter(maxNotificationsPerDay);
      const rateLimiter2 = new RateLimiter(maxNotificationsPerDay);

      // First instance records activity
      await rateLimiter1.recordAttempt(testToken);
      await rateLimiter1.recordSuccess(testToken);

      // Second instance should see the same data (since it queries Firestore)
      const status = await rateLimiter2.checkRateLimit(testToken);
      expect(status.rateLimits.successful).toBe(1);
    });
  });

  describe('Debug mode', () => {
    test('should not log in debug mode (removed debug logging)', async () => {
      const functions = require('firebase-functions');
      const rateLimiter = new RateLimiter(maxNotificationsPerDay, true);

      await rateLimiter.recordAttempt(testToken);
      await rateLimiter.recordSuccess(testToken);

      // Debug logging was removed in the refactor
      expect(functions.logger.info).not.toHaveBeenCalled();
    });
  });

  describe('Edge cases and error handling', () => {
    test('should handle recordSuccess without prior recordAttempt', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // Call recordSuccess without recordAttempt - should create document
      const result = await rateLimiter.recordSuccess(testToken);
      
      expect(result.attempts).toBe(0);
      expect(result.successful).toBe(1);
      expect(result.total).toBe(1);
      expect(result.errors).toBe(0);
      
      // Verify document was created with set
      expect(mockSet).toHaveBeenCalledTimes(1);
    });

    test('should handle recordError without prior recordAttempt', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // Call recordError without recordAttempt - should create document
      const result = await rateLimiter.recordError(testToken);
      
      expect(result.attempts).toBe(0);
      expect(result.successful).toBe(0);
      expect(result.total).toBe(1);
      expect(result.errors).toBe(1);
      
      // Verify document was created with set
      expect(mockSet).toHaveBeenCalledTimes(1);
    });

    test('should handle negative remaining count', async () => {
      const rateLimiter = new RateLimiter(5);
      
      // Create a doc with more delivered than max allowed
      const key = `rateLimits/${getToday()}/tokens/${testToken}`;
      mockData[key] = {
        attemptsCount: 10,
        deliveredCount: 10, // More than max (5)
        errorCount: 0,
        totalCount: 10,
        expiresAt: { toDate: () => new Date() },
      };
      
      const status = await rateLimiter.checkRateLimit(testToken);
      expect(status.rateLimits.remaining).toBe(0); // Should be 0, not negative
      expect(status.isRateLimited).toBe(true);
    });

    test('should handle missing fields in document data', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // Create a doc with missing fields
      const key = `rateLimits/${getToday()}/tokens/${testToken}`;
      mockData[key] = {
        // Missing attemptsCount, errorCount, etc.
        deliveredCount: 5,
        totalCount: 5,
        expiresAt: { toDate: () => new Date() },
      };
      
      const status = await rateLimiter.checkRateLimit(testToken);
      // Should handle missing fields gracefully with || 0
      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.successful).toBe(5);
      expect(status.rateLimits.total).toBe(5);
    });

    test('should handle transaction errors', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // Make transaction throw an error
      mockRunTransaction.mockRejectedValueOnce(new Error('Transaction failed'));
      
      // Should propagate the error
      await expect(rateLimiter.recordAttempt(testToken)).rejects.toThrow('Transaction failed');
    });

    test('should handle Firestore get errors', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // Make get throw an error
      mockGet.mockRejectedValueOnce(new Error('Firestore unavailable'));
      
      // Should propagate the error
      await expect(rateLimiter.checkRateLimit(testToken)).rejects.toThrow('Firestore unavailable');
    });
  });

  describe('Concurrent operations', () => {
    test('should handle concurrent recordAttempt calls', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // In real Firestore, transactions would serialize these operations
      // For this test, we'll verify that multiple calls work correctly
      // even if our mock doesn't perfectly simulate transaction isolation
      
      // Make 5 sequential calls (since our mock doesn't handle true concurrency)
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await rateLimiter.recordAttempt(testToken);
      }
      
      // Check final state
      const status = await rateLimiter.checkRateLimit(testToken);
      expect(status.rateLimits.attempts).toBe(5);
    });

    test('should handle mixed concurrent operations', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // Create initial document
      await rateLimiter.recordAttempt(testToken);
      
      // Simulate concurrent success and error calls
      const promises = [
        rateLimiter.recordSuccess(testToken),
        rateLimiter.recordError(testToken),
        rateLimiter.recordSuccess(testToken),
      ];
      
      await Promise.all(promises);
      
      // Check final state
      const status = await rateLimiter.checkRateLimit(testToken);
      expect(status.rateLimits.successful).toBe(2);
      expect(status.rateLimits.errors).toBe(1);
      expect(status.rateLimits.total).toBe(3);
    });
  });

  describe('Different token scenarios', () => {
    test('should handle multiple different tokens independently', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      const token1 = 'token-1';
      const token2 = 'token-2';
      
      // Update mock to handle different tokens
      mockRunTransaction.mockImplementation(async (callback) => {
        const mockTransaction = {
          get: async (docRef) => {
            // Extract token from docRef path
            const tokenMatch = docRef.path ? docRef.path.match(/tokens\/([^/]+)$/) : null;
            const tokenId = tokenMatch ? tokenMatch[1] : testToken;
            
            const collectionName = 'rateLimits';
            const docId = getToday();
            const subCollectionName = 'tokens';
            const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
            
            return {
              exists: Boolean(mockData[key]),
              data: () => mockData[key],
            };
          },
          set: async (docRef, data) => {
            const tokenMatch = docRef.path ? docRef.path.match(/tokens\/([^/]+)$/) : null;
            const tokenId = tokenMatch ? tokenMatch[1] : testToken;
            
            const collectionName = 'rateLimits';
            const docId = getToday();
            const subCollectionName = 'tokens';
            const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
            
            mockData[key] = data;
          },
          update: async (docRef, data) => {
            const tokenMatch = docRef.path ? docRef.path.match(/tokens\/([^/]+)$/) : null;
            const tokenId = tokenMatch ? tokenMatch[1] : testToken;
            
            const collectionName = 'rateLimits';
            const docId = getToday();
            const subCollectionName = 'tokens';
            const key = `${collectionName}/${docId}/${subCollectionName}/${tokenId}`;
            
            mockData[key] = Object.assign({}, mockData[key], data);
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
      
      expect(status1.rateLimits.successful).toBe(1);
      expect(status1.rateLimits.errors).toBe(0);
      
      expect(status2.rateLimits.successful).toBe(0);
      expect(status2.rateLimits.errors).toBe(1);
    });

    test('should handle tokens with special characters', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      const specialToken = 'token:with/special@chars#123';
      
      await rateLimiter.recordAttempt(specialToken);
      await rateLimiter.recordSuccess(specialToken);
      
      const status = await rateLimiter.checkRateLimit(specialToken);
      expect(status.rateLimits.successful).toBe(1);
    });
  });

  describe('Timestamp and date handling', () => {
    test('should correctly calculate end of day timestamp', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // Set time to 3 PM UTC
      jest.setSystemTime(new Date('2024-01-01T15:00:00Z'));
      
      await rateLimiter.recordAttempt(testToken);
      
      // Check the expiresAt timestamp
      const key = `rateLimits/${getToday()}/tokens/${testToken}`;
      expect(mockData[key]).toBeDefined();
      
      // Verify Timestamp.fromDate was called with end of day
      expect(mockTimestamp.fromDate).toHaveBeenCalled();
      const endOfDayCall = mockTimestamp.fromDate.mock.calls[0][0];
      
      // The timestamp should be for midnight of the next day
      // The actual calculation in getFirestoreTimestamp adds 24 hours and rounds to midnight
      const expectedEndOfDay = new Date('2024-01-02T00:00:00Z');
      expect(endOfDayCall.getTime()).toBe(expectedEndOfDay.getTime());
    });

    test('should use correct date for document path', async () => {
      const rateLimiter = new RateLimiter(maxNotificationsPerDay);
      
      // Test at year boundary
      jest.setSystemTime(new Date('2023-12-31T23:59:59Z'));
      
      await rateLimiter.recordAttempt(testToken);
      
      // Should use 20231231 as the date
      const expectedKey = `rateLimits/20231231/tokens/${testToken}`;
      expect(mockData[expectedKey]).toBeDefined();
    });
  });
});
