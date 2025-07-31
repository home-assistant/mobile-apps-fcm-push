'use strict';

const {
  createMockRequest,
  createMockResponse,
  createMockPayloadHandler,
  createMockDocRef,
  createMockRateLimitData,
  setupFirestoreCollectionChain,
} = require('./utils/mock-factories');

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

/**
 * Create a Firebase Messaging error
 */
function createFCMError(code, message) {
  const error = new Error(message);
  error.code = `messaging/${code}`;
  return error;
}

describe('FCM Error Handling', () => {
  let req, res, payloadHandler, docRef, docSnapshot;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set up mock objects
    req = createMockRequest();
    res = createMockResponse();
    payloadHandler = createMockPayloadHandler();

    // Set up Firestore document mocks
    docSnapshot = { exists: false, data: jest.fn(() => createMockRateLimitData()) };
    docRef = createMockDocRef(docSnapshot);

    // Set up Firestore collection chain
    setupFirestoreCollectionChain(mockFirestore, docRef);

    // Set up transaction mock
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

  test('should return 500 for invalid-registration-token error without logging', async () => {
    const error = createFCMError('invalid-registration-token', 'Invalid registration token');
    mockMessaging.send.mockRejectedValue(error);

    const mockLogInstance = {
      write: jest.fn((entry, callback) => callback()),
      entry: jest.fn(() => ({})),
      debug: jest.fn(),
      info: jest.fn(),
    };
    mockLogging.log.mockReturnValue(mockLogInstance);

    await indexModule.handleRequest(req, res, payloadHandler);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith({
      errorType: 'InvalidToken',
      errorCode: 'invalid-registration-token',
      errorStep: 'sendNotification',
      message: 'Invalid registration token',
    });

    // Verify error was NOT written to logs for token errors
    expect(mockLogInstance.write).not.toHaveBeenCalled();
  });

  test('should return 500 for registration-token-not-registered error without logging', async () => {
    const error = createFCMError(
      'registration-token-not-registered',
      'Requested entity was not found.',
    );
    mockMessaging.send.mockRejectedValue(error);

    const mockLogInstance = {
      write: jest.fn((entry, callback) => callback()),
      entry: jest.fn(() => ({})),
      debug: jest.fn(),
      info: jest.fn(),
    };
    mockLogging.log.mockReturnValue(mockLogInstance);

    await indexModule.handleRequest(req, res, payloadHandler);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith({
      errorType: 'InvalidToken',
      errorCode: 'registration-token-not-registered',
      errorStep: 'sendNotification',
      message: 'Requested entity was not found.',
    });

    // Verify error was NOT written to logs for token errors
    expect(mockLogInstance.write).not.toHaveBeenCalled();
  });

  test('should return 500 for other FCM errors and log them', async () => {
    const error = createFCMError('internal-error', 'Internal server error');
    mockMessaging.send.mockRejectedValue(error);

    const mockLogInstance = {
      write: jest.fn((entry, callback) => callback()),
      entry: jest.fn(() => ({})),
    };
    mockLogging.log.mockReturnValue(mockLogInstance);

    await indexModule.handleRequest(req, res, payloadHandler);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith({
      errorType: 'InternalError',
      errorStep: 'sendNotification',
      message: 'Internal server error',
    });

    // Verify error WAS logged for non-token errors
    expect(mockLogging.log).toHaveBeenCalledWith('errors-sendNotification');
    expect(mockLogInstance.write).toHaveBeenCalled();
  });
});
