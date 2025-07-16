'use strict';

/**
 * Shared Firebase mock utilities for tests
 */

const setupFirebaseMocks = () => {
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
      write: jest.fn((_, callback) => callback()),
      entry: jest.fn(() => ({})),
    })),
  };

  const mockTimestamp = {
    fromDate: jest.fn((date) => ({ toDate: () => date })),
  };

  // Set up Jest mocks
  jest.mock('firebase-functions', () => mockFunctions);
  jest.mock('@google-cloud/logging', () => ({
    Logging: jest.fn(() => mockLogging),
  }));
  jest.mock('firebase-admin/app', () => ({
    initializeApp: jest.fn(),
  }));
  jest.mock('firebase-admin/firestore', () => ({
    getFirestore: jest.fn(() => mockFirestore),
    Timestamp: mockTimestamp,
  }));
  jest.mock('firebase-admin/messaging', () => ({
    getMessaging: jest.fn(() => mockMessaging),
  }));

  return {
    mockMessaging,
    mockFirestore,
    mockFunctions,
    mockLogging,
    mockTimestamp,
  };
};

const resetAllMocks = (mocks) => {
  jest.clearAllMocks();
  Object.values(mocks).forEach((mock) => {
    if (mock && typeof mock.mockReset === 'function') {
      mock.mockReset();
    }
  });
};

module.exports = {
  setupFirebaseMocks,
  resetAllMocks,
};
