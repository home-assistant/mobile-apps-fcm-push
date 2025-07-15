'use strict';

/**
 * Mock data factories for creating consistent test objects
 */

/**
 * Creates a mock request object
 */
const createMockRequest = (overrides = {}) => ({
  body: {
    push_token: 'test:token123',
    message: 'Test message',
    title: 'Test title',
    registration_info: {
      app_id: 'com.test.app',
      app_version: '1.0.0',
      os_version: '14.0',
    },
    ...overrides.body,
  },
  method: 'POST',
  originalUrl: '/test',
  get: jest.fn(() => 'test-user-agent'),
  ip: '127.0.0.1',
  ...overrides,
});

/**
 * Creates a mock response object
 */
const createMockResponse = () => ({
  status: jest.fn().mockReturnThis(),
  send: jest.fn(),
});

/**
 * Creates a mock payload handler
 */
const createMockPayloadHandler = (overrides = {}) => jest.fn(() => ({
  updateRateLimits: true,
  payload: {
    notification: { body: 'Test message' },
  },
  ...overrides,
}));

/**
 * Creates a mock Firestore document snapshot
 */
const createMockDocSnapshot = (exists = false, data = {}) => ({
  exists,
  data: jest.fn(() => data),
});

/**
 * Creates a mock Firestore document reference
 */
const createMockDocRef = (initialSnapshot = null) => {
  const snapshot = initialSnapshot || createMockDocSnapshot();
  
  return {
    get: jest.fn().mockResolvedValue(snapshot),
    set: jest.fn().mockResolvedValue(),
    update: jest.fn().mockResolvedValue(),
    path: 'rateLimits/20240101/tokens/test:token123',
  };
};

/**
 * Creates a mock Firestore transaction
 */
const createMockTransaction = (mockData = {}) => ({
  get: jest.fn().mockImplementation(async (docRef) => {
    const key = docRef.path || 'default';
    return {
      exists: Boolean(mockData[key]),
      data: () => mockData[key] || {},
    };
  }),
  set: jest.fn().mockImplementation(async (docRef, data) => {
    const key = docRef.path || 'default';
    mockData[key] = data;
  }),
  update: jest.fn().mockImplementation(async (docRef, data) => {
    const key = docRef.path || 'default';
    mockData[key] = Object.assign({}, mockData[key] || {}, data);
  }),
});

/**
 * Creates mock rate limit data
 */
const createMockRateLimitData = (overrides = {}) => ({
  attemptsCount: 0,
  deliveredCount: 0,
  errorCount: 0,
  totalCount: 0,
  expiresAt: 'mock-timestamp',
  ...overrides,
});

/**
 * Sets up Firestore collection chain mock
 */
const setupFirestoreCollectionChain = (mockFirestore, docRef) => {
  const collectionRef = {
    doc: jest.fn(() => docRef),
  };

  const dateRef = {
    collection: jest.fn(() => collectionRef),
  };

  mockFirestore.collection.mockReturnValue({
    doc: jest.fn(() => dateRef),
  });

  return { collectionRef, dateRef };
};

/**
 * Mock data manager for rate limiter tests
 */
class MockDataManager {
  constructor() {
    this.data = {};
  }

  setRateLimitData(token, date, data) {
    const key = `rateLimits/${date}/tokens/${token}`;
    this.data[key] = data;
  }

  getRateLimitData(token, date) {
    const key = `rateLimits/${date}/tokens/${token}`;
    return this.data[key];
  }

  hasRateLimitData(token, date) {
    const key = `rateLimits/${date}/tokens/${token}`;
    return Boolean(this.data[key]);
  }

  clear() {
    this.data = {};
  }

  generateKey(token, date) {
    return `rateLimits/${date}/tokens/${token}`;
  }
}

/**
 * Gets today's date in YYYYMMDD format
 */
const getToday = () => {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  return yyyy + mm + dd;
};

module.exports = {
  createMockRequest,
  createMockResponse,
  createMockPayloadHandler,
  createMockDocSnapshot,
  createMockDocRef,
  createMockTransaction,
  createMockRateLimitData,
  setupFirestoreCollectionChain,
  MockDataManager,
  getToday,
};