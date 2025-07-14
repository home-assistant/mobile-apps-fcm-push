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

const mockGetFirestore = jest.fn(() => ({
  collection: mockCollection,
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
      const rateLimiter = new RateLimiter(testToken, maxNotificationsPerDay);
      const status = await rateLimiter.checkRateLimit();
      
      expect(status.isRateLimited).toBe(false);
      expect(status.rateLimits.attempts).toBe(0);
      expect(status.rateLimits.successful).toBe(0);
      expect(status.rateLimits.errors).toBe(0);
      expect(status.rateLimits.remaining).toBe(maxNotificationsPerDay);
    });

    test('should increment counters on success', async () => {
      const rateLimiter = new RateLimiter(testToken, maxNotificationsPerDay);
      
      await rateLimiter.recordAttempt();
      await rateLimiter.recordSuccess();
      
      const status = await rateLimiter.checkRateLimit();
      expect(status.rateLimits.attempts).toBe(1);
      expect(status.rateLimits.successful).toBe(1);
      expect(status.rateLimits.total).toBe(1);
      expect(status.rateLimits.remaining).toBe(maxNotificationsPerDay - 1);
    });

    test('should increment counters on error', async () => {
      const rateLimiter = new RateLimiter(testToken, maxNotificationsPerDay);
      
      await rateLimiter.recordAttempt();
      await rateLimiter.recordError();
      
      const status = await rateLimiter.checkRateLimit();
      expect(status.rateLimits.attempts).toBe(1);
      expect(status.rateLimits.errors).toBe(1);
      expect(status.rateLimits.total).toBe(1);
      expect(status.rateLimits.remaining).toBe(maxNotificationsPerDay);
    });

    test('should enforce rate limit', async () => {
      const rateLimiter = new RateLimiter(testToken, 5); // Low limit for testing
      
      // Send 5 successful notifications
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(rateLimiter.recordAttempt().then(() => rateLimiter.recordSuccess()));
      }
      await Promise.all(promises);
      
      // Check rate limit status after exactly reaching the limit
      let status = await rateLimiter.checkRateLimit();
      expect(status.isRateLimited).toBe(true); // >= max means rate limited
      expect(status.shouldSendRateLimitNotification).toBe(true); // Exactly at limit
      expect(status.rateLimits.remaining).toBe(0);
      
      // Try one more to go over the limit
      await rateLimiter.recordAttempt();
      await rateLimiter.recordSuccess();
      
      status = await rateLimiter.checkRateLimit();
      expect(status.isRateLimited).toBe(true); // Still rate limited
      expect(status.shouldSendRateLimitNotification).toBe(false); // Only true when exactly at limit
      expect(status.rateLimits.remaining).toBe(0);
    });

    test('should call Firestore operations correctly', async () => {
      const rateLimiter = new RateLimiter(testToken, maxNotificationsPerDay);
      
      // First operation should call get
      await rateLimiter.checkRateLimit();
      expect(mockGet).toHaveBeenCalledTimes(1);
      
      // Recording success should call set for new document
      await rateLimiter.recordAttempt();
      await rateLimiter.recordSuccess();
      expect(mockSet).toHaveBeenCalledTimes(1);
      
      // Another success should call set again since docExists is still false in our mock
      await rateLimiter.recordAttempt();
      await rateLimiter.recordSuccess();
      expect(mockSet).toHaveBeenCalledTimes(2);
    });
  });

  describe('Document storage functionality', () => {
    test('should store data for current date', async () => {
      const rateLimiter = new RateLimiter(testToken, maxNotificationsPerDay);
      
      await rateLimiter.recordAttempt();
      await rateLimiter.recordSuccess();
      
      // Check that data is stored under today's date
      const today = getToday();
      const key = `rateLimits/${today}/tokens/${testToken}`;
      expect(mockData[key]).toBeDefined();
      expect(mockData[key].deliveredCount).toBe(1);
      expect(mockData[key].attemptsCount).toBe(1);
    });

    test('resetsAt should show next day midnight', async () => {
      const rateLimiter = new RateLimiter(testToken, maxNotificationsPerDay);
      const status = await rateLimiter.checkRateLimit();
      
      const resetsAt = status.rateLimits.resetsAt;
      expect(resetsAt.getFullYear()).toBe(2024);
      expect(resetsAt.getMonth()).toBe(0); // January (0-indexed)
      expect(resetsAt.getDate()).toBe(2); // Next day
      expect(resetsAt.getHours()).toBe(0);
      expect(resetsAt.getMinutes()).toBe(0);
      expect(resetsAt.getSeconds()).toBe(0);
    });

    test('should handle multiple instances for same token', async () => {
      const rateLimiter1 = new RateLimiter(testToken, maxNotificationsPerDay);
      const rateLimiter2 = new RateLimiter(testToken, maxNotificationsPerDay);
      
      // First instance records activity
      await rateLimiter1.recordAttempt();
      await rateLimiter1.recordSuccess();
      
      // Second instance should see the same data (since it queries Firestore)
      const status = await rateLimiter2.checkRateLimit();
      expect(status.rateLimits.successful).toBe(1);
    });
  });

  describe('Debug mode', () => {
    test('should log when debug mode is enabled', async () => {
      const functions = require('firebase-functions');
      const rateLimiter = new RateLimiter(testToken, maxNotificationsPerDay, true);
      
      await rateLimiter.recordAttempt();
      await rateLimiter.recordSuccess();
      
      expect(functions.logger.info).toHaveBeenCalledWith('Creating new rate limit doc!');
      
      // In the current implementation, both operations create new docs since _docExists stays false
      await rateLimiter.recordAttempt();
      await rateLimiter.recordSuccess();
      
      expect(functions.logger.info).toHaveBeenCalledTimes(2);
      expect(functions.logger.info).toHaveBeenNthCalledWith(2, 'Creating new rate limit doc!');
    });
  });
});