'use strict';

// Mock Firebase Admin and other dependencies
const mockMessaging = {
  send: jest.fn(),
};

const mockFirestore = {
  collection: jest.fn(),
};

const mockFunctions = {
  config: jest.fn(() => ({})),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
  region: jest.fn().mockReturnThis(),
  runWith: jest.fn().mockReturnThis(),
  https: {
    onRequest: jest.fn(),
  },
};

const mockLogging = {
  log: jest.fn(() => ({
    write: jest.fn((entry, callback) => callback()),
    entry: jest.fn(() => ({})),
  })),
};

jest.mock('firebase-functions', () => mockFunctions);
jest.mock('@google-cloud/logging', () => ({
  Logging: jest.fn(() => mockLogging),
}));
jest.mock('firebase-admin/app', () => ({
  initializeApp: jest.fn(),
}));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(() => mockFirestore),
  Timestamp: {
    fromDate: jest.fn(() => 'mock-timestamp'),
  },
}));
jest.mock('firebase-admin/messaging', () => ({
  getMessaging: jest.fn(() => mockMessaging),
}));

const indexModule = require('../index.js');

describe('handleRequest', () => {
  let req, res, payloadHandler;
  let docRef, docSnapshot;

  // Factory function to create fresh request objects for each test
  function createMockRequest() {
    return {
      body: {
        push_token: 'test:token123',
        message: 'Test message',
        title: 'Test title',
        registration_info: {
          app_id: 'com.test.app',
          app_version: '1.0.0',
          os_version: '14.0',
        },
      },
      method: 'POST',
      originalUrl: '/test',
      get: jest.fn(() => 'test-user-agent'),
      ip: '127.0.0.1',
    };
  }

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset messaging stub
    mockMessaging.send.mockResolvedValue('mock-message-id');

    // Set up request and response mock objects
    req = createMockRequest();

    res = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };

    payloadHandler = jest.fn(() => ({
      updateRateLimits: true,
      payload: {
        notification: { body: 'Test message' },
      },
    }));

    // Set up Firestore document mocks
    docSnapshot = {
      exists: false,
      data: jest.fn(() => ({
        attemptsCount: 0,
        deliveredCount: 0,
        errorCount: 0,
        totalCount: 0,
      })),
    };

    docRef = {
      get: jest.fn().mockResolvedValue(docSnapshot),
      set: jest.fn().mockResolvedValue(),
      update: jest.fn().mockResolvedValue(),
    };

    // Set up Firestore collection chain
    const collectionRef = {
      doc: jest.fn(() => docRef),
    };

    const dateRef = {
      collection: jest.fn(() => collectionRef),
    };

    mockFirestore.collection.mockReturnValue({
      doc: jest.fn(() => dateRef),
    });
  });

  test('should handle successful notification send and create new doc', async () => {
    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify payload handler was called
    expect(payloadHandler).toHaveBeenCalledTimes(1);
    expect(payloadHandler).toHaveBeenCalledWith(req);

    // Verify messaging.send was called
    expect(mockMessaging.send).toHaveBeenCalledTimes(1);
    const sentPayload = mockMessaging.send.mock.calls[0][0];
    expect(sentPayload.token).toBe('test:token123');

    // Verify Firestore doc was created
    expect(docRef.set).toHaveBeenCalledTimes(1);
    expect(docRef.update).not.toHaveBeenCalled();
    
    const savedData = docRef.set.mock.calls[0][0];
    expect(savedData.attemptsCount).toBe(1);
    expect(savedData.deliveredCount).toBe(1);
    expect(savedData.totalCount).toBe(1);
    expect(savedData.errorCount).toBe(0);

    // Verify successful response
    expect(res.status).toHaveBeenCalledWith(201);
    const responseData = res.send.mock.calls[0][0];
    expect(responseData.messageId).toBe('mock-message-id');
    expect(responseData.target).toBe('test:token123');
    expect(responseData.rateLimits).toBeDefined();
  });

  test('should handle successful notification send and update existing doc', async () => {
    // Set up existing document
    docSnapshot.exists = true;
    docSnapshot.data.mockReturnValue({
      attemptsCount: 10,
      deliveredCount: 5,
      errorCount: 2,
      totalCount: 7,
    });

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify Firestore doc was updated
    expect(docRef.update).toHaveBeenCalledTimes(1);
    expect(docRef.set).not.toHaveBeenCalled();

    const updatedData = docRef.update.mock.calls[0][0];
    expect(updatedData.attemptsCount).toBe(11);
    expect(updatedData.deliveredCount).toBe(6);
    expect(updatedData.totalCount).toBe(8);
    expect(updatedData.errorCount).toBe(2);

    // Verify response
    expect(res.status).toHaveBeenCalledWith(201);
  });

  test('should handle notification send failure and update error count', async () => {
    // Make messaging.send fail
    mockMessaging.send.mockRejectedValue(new Error('FCM send failed'));

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify Firestore doc was created with error count
    expect(docRef.set).toHaveBeenCalledTimes(1);
    const savedData = docRef.set.mock.calls[0][0];
    expect(savedData.attemptsCount).toBe(1);
    expect(savedData.deliveredCount).toBe(0);
    expect(savedData.errorCount).toBe(1);
    expect(savedData.totalCount).toBe(1);

    // Verify error response
    expect(res.status).toHaveBeenCalledWith(500);
    const responseData = res.send.mock.calls[0][0];
    expect(responseData.errorType).toBe('InternalError');
    expect(responseData.errorStep).toBe('sendNotification');
  });

  test('should reject notifications over rate limit', async () => {
    // Set up doc over rate limit
    docSnapshot.exists = true;
    docSnapshot.data.mockReturnValue({
      attemptsCount: 501,
      deliveredCount: 501, // Over MAX_NOTIFICATIONS_PER_DAY (500)
      errorCount: 0,
      totalCount: 501,
    });

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify notification was not sent (only rate limit doc update)
    expect(mockMessaging.send).not.toHaveBeenCalled();

    // Verify doc was still updated with attempt
    expect(docRef.update).toHaveBeenCalledTimes(1);
    const updatedData = docRef.update.mock.calls[0][0];
    expect(updatedData.attemptsCount).toBe(502);
    expect(updatedData.deliveredCount).toBe(501);

    // Verify rate limit response
    expect(res.status).toHaveBeenCalledWith(429);
    const responseData = res.send.mock.calls[0][0];
    expect(responseData.errorType).toBe('RateLimited');
    expect(responseData.message).toContain('maximum number of notifications');
  });

  test('should not update rate limits for critical notifications', async () => {
    // Set payload handler to return updateRateLimits: false
    payloadHandler.mockReturnValue({
      updateRateLimits: false,
      payload: {
        notification: { body: 'Critical message' },
      },
    });

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify messaging.send was called
    expect(mockMessaging.send).toHaveBeenCalledTimes(1);

    // Verify Firestore doc was NOT updated for rate limits
    expect(docRef.set).not.toHaveBeenCalled();
    expect(docRef.update).not.toHaveBeenCalled();

    // Verify response still returns rate limit info
    expect(res.status).toHaveBeenCalledWith(201);
    const responseData = res.send.mock.calls[0][0];
    expect(responseData.rateLimits).toBeDefined();
  });

  test('should handle invalid token format', async () => {
    const testReq = createMockRequest();
    testReq.body.push_token = 'invalid-token-without-colon';

    await indexModule.handleRequest(testReq, res, payloadHandler);

    // Verify error response
    expect(res.status).toHaveBeenCalledWith(403);
    const responseData = res.send.mock.calls[0][0];
    expect(responseData.errorMessage).toBe('That is not a valid FCM token');

    // Verify nothing else was called
    expect(mockMessaging.send).not.toHaveBeenCalled();
    expect(docRef.get).not.toHaveBeenCalled();
  });

  test('should handle missing token', async () => {
    const testReq = createMockRequest();
    delete testReq.body.push_token;

    await indexModule.handleRequest(testReq, res, payloadHandler);

    // Verify error response
    expect(res.status).toHaveBeenCalledWith(403);
    const responseData = res.send.mock.calls[0][0];
    expect(responseData.errorMessage).toBe('You did not send a token!');

    // Verify nothing else was called
    expect(mockMessaging.send).not.toHaveBeenCalled();
    expect(docRef.get).not.toHaveBeenCalled();
  });

  test('should handle Firestore read errors', async () => {
    // Make Firestore get fail
    docRef.get.mockRejectedValue(new Error('Firestore read failed'));

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify error response
    expect(res.status).toHaveBeenCalledWith(500);
    const responseData = res.send.mock.calls[0][0];
    expect(responseData.errorType).toBe('InternalError');
    expect(responseData.errorStep).toBe('getRateLimitDoc');
  });
});