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
});
