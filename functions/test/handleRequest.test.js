'use strict';

const {
  createMockRequest,
  createMockResponse,
  createMockPayloadHandler,
  createMockDocRef,
  createMockRateLimitData,
  setupFirestoreCollectionChain,
} = require('./utils/mock-factories');

const {
  assertFirestoreOps,
  assertMessaging,
  assertResponse,
  assertSuccessfulFlow,
  assertRateLimitedFlow,
} = require('./utils/assertion-helpers');

// Mock Firebase Admin and other dependencies
const mockMessaging = {
  send: jest.fn(),
};

const mockFirestore = {
  collection: jest.fn(),
  runTransaction: jest.fn(),
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
  let req, res, payloadHandler, docRef, docSnapshot;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Reset messaging stub
    mockMessaging.send.mockResolvedValue('mock-message-id');

    // Set up mock objects using factories
    req = createMockRequest();
    res = createMockResponse();
    payloadHandler = createMockPayloadHandler();

    // Set up Firestore document mocks
    docSnapshot = { exists: false, data: jest.fn(() => createMockRateLimitData()) };
    docRef = createMockDocRef(docSnapshot);

    // Set up Firestore collection chain
    setupFirestoreCollectionChain(mockFirestore, docRef);

    // Set up transaction mock that maintains state across transactions
    mockFirestore.runTransaction.mockImplementation(async (callback) => {
      let transactionDocExists = docSnapshot.exists;
      let transactionCurrentData = null;
      if (docSnapshot.exists && docSnapshot.data()) {
        transactionCurrentData = Object.assign({}, docSnapshot.data());
      }

      const mockTransaction = {
        get: jest.fn().mockImplementation(() => ({
          exists: transactionDocExists,
          data: () => transactionCurrentData || {},
        })),
        set: jest.fn().mockImplementation((ref, data) => {
          transactionDocExists = true;
          transactionCurrentData = Object.assign({}, data);
          docSnapshot.exists = true;
          docSnapshot.data = jest.fn(() => transactionCurrentData);
          docRef.set(data);
        }),
        update: jest.fn().mockImplementation((ref, data) => {
          if (transactionCurrentData) {
            transactionCurrentData = Object.assign({}, transactionCurrentData, data);
            docSnapshot.data = jest.fn(() => transactionCurrentData);
          }
          docRef.update(data);
        }),
      };

      return await callback(mockTransaction);
    });
  });

  test('should handle successful notification send and create new doc', async () => {
    await indexModule.handleRequest(req, res, payloadHandler);

    expect(payloadHandler).toHaveBeenCalledWith(req);
    assertMessaging.expectTokenInPayload(mockMessaging, 'test:token123');

    // Verify Firestore operations: recordAttempt creates doc, recordSuccess updates it
    assertFirestoreOps.expectDocCreated(docRef, {
      attemptsCount: 1,
      deliveredCount: 0,
      totalCount: 0,
      errorCount: 0,
    });

    assertFirestoreOps.expectDocUpdated(docRef, {
      deliveredCount: 1,
      totalCount: 1,
    });

    assertSuccessfulFlow(
      { mockMessaging, mockRes: res },
      {
        attempts: 1,
        successful: 1,
        total: 1,
        errors: 0,
      },
    );
  });

  test('should handle successful notification send and update existing doc', async () => {
    // Set up existing document
    docSnapshot.exists = true;
    docSnapshot.data.mockReturnValue(
      createMockRateLimitData({
        attemptsCount: 10,
        deliveredCount: 5,
        errorCount: 2,
        totalCount: 7,
      }),
    );

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify Firestore operations: recordAttempt updates, recordSuccess updates
    expect(docRef.update).toHaveBeenCalledTimes(2);
    expect(docRef.set).not.toHaveBeenCalled();

    assertFirestoreOps.expectDocUpdated(docRef, { attemptsCount: 11 }, 0);
    assertFirestoreOps.expectDocUpdated(docRef, { deliveredCount: 6, totalCount: 8 }, 1);

    assertResponse.expectSuccessResponse(res);
  });

  test('should handle notification send failure and update error count', async () => {
    mockMessaging.send.mockRejectedValue(new Error('FCM send failed'));

    await indexModule.handleRequest(req, res, payloadHandler);

    assertFirestoreOps.expectDocCreated(docRef, {
      attemptsCount: 1,
      deliveredCount: 0,
      totalCount: 0,
      errorCount: 0,
    });

    assertFirestoreOps.expectDocUpdated(docRef, {
      errorCount: 1,
      totalCount: 1,
    });

    assertResponse.expectErrorResponse(res, 500, {
      errorType: 'InternalError',
      errorStep: 'sendNotification',
    });
  });

  test('should reject notifications over rate limit', async () => {
    // Set up doc over rate limit
    docSnapshot.exists = true;
    docSnapshot.data.mockReturnValue(
      createMockRateLimitData({
        attemptsCount: 501,
        deliveredCount: 501, // Over MAX_NOTIFICATIONS_PER_DAY (500)
        errorCount: 0,
        totalCount: 501,
      }),
    );

    await indexModule.handleRequest(req, res, payloadHandler);

    assertRateLimitedFlow({ mockMessaging, mockRes: res }, 'test:token123');

    // Verify only attempt was recorded (not success, since rate limited)
    assertFirestoreOps.expectDocUpdated(docRef, { attemptsCount: 502 });
  });

  test('should not update rate limits for critical notifications', async () => {
    // Set payload handler to return updateRateLimits: false
    payloadHandler.mockReturnValue({
      updateRateLimits: false,
      payload: { notification: { body: 'Critical message' } },
    });

    await indexModule.handleRequest(req, res, payloadHandler);

    assertMessaging.expectMessageSent(mockMessaging);
    assertFirestoreOps.expectNoFirestoreOps(docRef);

    const response = assertResponse.expectSuccessResponse(res);
    expect(response.rateLimits).toBeDefined();
  });

  test('should handle invalid token format', async () => {
    const testReq = createMockRequest({
      body: { push_token: 'invalid-token-without-colon' },
    });

    await indexModule.handleRequest(testReq, res, payloadHandler);

    assertResponse.expectForbiddenResponse(res, 'That is not a valid FCM token');
    assertMessaging.expectNoMessageSent(mockMessaging);
    expect(docRef.get).not.toHaveBeenCalled();
  });

  test('should handle missing token', async () => {
    const testReq = createMockRequest();
    delete testReq.body.push_token;

    await indexModule.handleRequest(testReq, res, payloadHandler);

    assertResponse.expectForbiddenResponse(res, 'You did not send a token!');
    assertMessaging.expectNoMessageSent(mockMessaging);
    expect(docRef.get).not.toHaveBeenCalled();
  });

  test('should handle Firestore read errors', async () => {
    docRef.get.mockRejectedValue(new Error('Firestore read failed'));

    await indexModule.handleRequest(req, res, payloadHandler);

    assertResponse.expectErrorResponse(res, 500, {
      errorType: 'InternalError',
      errorStep: 'getRateLimitDoc',
    });
  });
});
