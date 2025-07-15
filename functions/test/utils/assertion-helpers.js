'use strict';

/**
 * Shared assertion helpers for common test patterns
 */

/**
 * Assertion helpers for Firestore operations
 */
const assertFirestoreOps = {
  expectDocCreated: (mockDocRef, expectedData) => {
    expect(mockDocRef.set).toHaveBeenCalledTimes(1);
    const actualData = mockDocRef.set.mock.calls[0][0];
    expect(actualData).toMatchObject(expectedData);
  },

  expectDocUpdated: (mockDocRef, expectedData, callIndex = 0) => {
    expect(mockDocRef.update).toHaveBeenCalled();
    const actualData = mockDocRef.update.mock.calls[callIndex][0];
    expect(actualData).toMatchObject(expectedData);
  },

  expectNoFirestoreOps: (mockDocRef) => {
    expect(mockDocRef.set).not.toHaveBeenCalled();
    expect(mockDocRef.update).not.toHaveBeenCalled();
  },
};

/**
 * Assertion helpers for messaging operations
 */
const assertMessaging = {
  expectMessageSent: (mockMessaging, expectedPayload = {}) => {
    expect(mockMessaging.send).toHaveBeenCalledTimes(1);
    const sentPayload = mockMessaging.send.mock.calls[0][0];
    if (Object.keys(expectedPayload).length > 0) {
      expect(sentPayload).toMatchObject(expectedPayload);
    }
    return sentPayload;
  },

  expectNoMessageSent: (mockMessaging) => {
    expect(mockMessaging.send).not.toHaveBeenCalled();
  },

  expectTokenInPayload: (mockMessaging, expectedToken) => {
    expect(mockMessaging.send).toHaveBeenCalledTimes(1);
    const sentPayload = mockMessaging.send.mock.calls[0][0];
    expect(sentPayload.token).toBe(expectedToken);
  },
};

/**
 * Assertion helpers for HTTP responses
 */
const assertResponse = {
  expectSuccessResponse: (mockRes, expectedData = {}) => {
    expect(mockRes.status).toHaveBeenCalledWith(201);
    const responseData = mockRes.send.mock.calls[0][0];
    expect(responseData).toMatchObject(expectedData);
    return responseData;
  },

  expectErrorResponse: (mockRes, expectedStatus, expectedError = {}) => {
    expect(mockRes.status).toHaveBeenCalledWith(expectedStatus);
    const responseData = mockRes.send.mock.calls[0][0];
    expect(responseData).toMatchObject(expectedError);
    return responseData;
  },

  expectRateLimitResponse: (mockRes, expectedToken) => {
    expect(mockRes.status).toHaveBeenCalledWith(429);
    const responseData = mockRes.send.mock.calls[0][0];
    expect(responseData.errorType).toBe('RateLimited');
    expect(responseData.target).toBe(expectedToken);
    expect(responseData.message).toContain('maximum number of notifications');
    return responseData;
  },

  expectForbiddenResponse: (mockRes, expectedMessage) => {
    expect(mockRes.status).toHaveBeenCalledWith(403);
    const responseData = mockRes.send.mock.calls[0][0];
    expect(responseData.errorMessage).toBe(expectedMessage);
    return responseData;
  },
};

/**
 * Assertion helpers for rate limit data
 */
const assertRateLimits = {
  expectRateLimitCounts: (rateLimits, expected) => {
    if (expected.attempts !== undefined) {
      expect(rateLimits.attempts).toBe(expected.attempts);
    }
    if (expected.successful !== undefined) {
      expect(rateLimits.successful).toBe(expected.successful);
    }
    if (expected.errors !== undefined) {
      expect(rateLimits.errors).toBe(expected.errors);
    }
    if (expected.total !== undefined) {
      expect(rateLimits.total).toBe(expected.total);
    }
    if (expected.remaining !== undefined) {
      expect(rateLimits.remaining).toBe(expected.remaining);
    }
  },

  expectNotRateLimited: (status) => {
    expect(status.isRateLimited).toBe(false);
    expect(status.shouldSendRateLimitNotification).toBe(false);
  },

  expectRateLimited: (status, shouldNotify = false) => {
    expect(status.isRateLimited).toBe(true);
    expect(status.shouldSendRateLimitNotification).toBe(shouldNotify);
  },

  expectRateLimitNotification: (status) => {
    expect(status.isRateLimited).toBe(true);
    expect(status.shouldSendRateLimitNotification).toBe(true);
  },
};

/**
 * Assertion helpers for function calls
 */
const assertCalls = {
  expectCalledWith: (mockFn, expectedArgs, callIndex = 0) => {
    expect(mockFn).toHaveBeenCalled();
    const actualArgs = mockFn.mock.calls[callIndex];
    expect(actualArgs).toEqual(expectedArgs);
  },

  expectCalledTimes: (mockFn, expectedTimes) => {
    expect(mockFn).toHaveBeenCalledTimes(expectedTimes);
  },

  expectNotCalled: (mockFn) => {
    expect(mockFn).not.toHaveBeenCalled();
  },
};

/**
 * Combined assertion for successful request flow
 */
const assertSuccessfulFlow = (mocks, expectedCounts) => {
  const { mockMessaging, mockDocRef, mockRes } = mocks;
  
  // Message should be sent
  assertMessaging.expectMessageSent(mockMessaging);
  
  // Response should be successful
  const response = assertResponse.expectSuccessResponse(mockRes);
  
  // Rate limits should be present
  expect(response.rateLimits).toBeDefined();
  if (expectedCounts) {
    assertRateLimits.expectRateLimitCounts(response.rateLimits, expectedCounts);
  }
  
  return response;
};

/**
 * Combined assertion for rate limited flow
 */
const assertRateLimitedFlow = (mocks, expectedToken) => {
  const { mockMessaging, mockRes } = mocks;
  
  // No message should be sent
  assertMessaging.expectNoMessageSent(mockMessaging);
  
  // Response should indicate rate limiting
  const response = assertResponse.expectRateLimitResponse(mockRes, expectedToken);
  
  return response;
};

module.exports = {
  assertFirestoreOps,
  assertMessaging,
  assertResponse,
  assertRateLimits,
  assertCalls,
  assertSuccessfulFlow,
  assertRateLimitedFlow,
};