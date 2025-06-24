const assert = require('assert');
const sinon = require('sinon');

describe('handleRequest', function() {
  let indexModule;
  let req, res, payloadHandler;
  let firestoreStub, messagingStub, functionsStub;
  let docRef, docSnapshot;

  before(function() {
    // Set up core stubs that will be used throughout
    messagingStub = {
      send: sinon.stub()
    };

    firestoreStub = {
      collection: sinon.stub()
    };

    functionsStub = {
      config: sinon.stub().returns({}),
      logger: {
        info: sinon.stub(),
        warn: sinon.stub()
      },
      region: sinon.stub().returnsThis(),
      runWith: sinon.stub().returnsThis(),
      https: {
        onRequest: sinon.stub()
      }
    };

    const loggingStub = {
      log: sinon.stub().returns({
        write: sinon.stub().callsArg(1), // Call the callback with no error
        entry: sinon.stub().returns({})
      })
    };

    // Mock all Firebase dependencies
    const mockRequire = require('mock-require');
    mockRequire('firebase-functions', functionsStub);
    mockRequire('@google-cloud/logging', { Logging: sinon.stub().returns(loggingStub) });
    mockRequire('firebase-admin/app', { initializeApp: sinon.stub() });
    mockRequire('firebase-admin/firestore', { 
      getFirestore: sinon.stub().returns(firestoreStub),
      Timestamp: {
        fromDate: sinon.stub().returns('mock-timestamp')
      }
    });
    mockRequire('firebase-admin/messaging', { getMessaging: sinon.stub().returns(messagingStub) });

    // Require the index module after mocking
    indexModule = require('../index.js');
  });

  beforeEach(function() {
    // Reset messaging stub
    messagingStub.send.reset();
    messagingStub.send.resolves('mock-message-id');

    // Set up request and response mock objects
    req = {
      body: {
        push_token: 'test:token123',
        message: 'Test message',
        title: 'Test title',
        registration_info: {
          app_id: 'com.test.app',
          app_version: '1.0.0',
          os_version: '14.0'
        }
      },
      method: 'POST',
      originalUrl: '/test',
      get: sinon.stub().returns('test-user-agent'),
      ip: '127.0.0.1'
    };

    res = {
      status: sinon.stub().returnsThis(),
      send: sinon.stub()
    };

    payloadHandler = sinon.stub().returns({
      updateRateLimits: true,
      payload: {
        notification: { body: 'Test message' }
      }
    });

    // Set up Firestore document mocks
    docSnapshot = {
      exists: false,
      data: sinon.stub().returns({
        attemptsCount: 0,
        deliveredCount: 0,
        errorCount: 0,
        totalCount: 0
      })
    };

    docRef = {
      get: sinon.stub().resolves(docSnapshot),
      set: sinon.stub().resolves(),
      update: sinon.stub().resolves()
    };

    // Set up Firestore collection chain
    const collectionRef = {
      doc: sinon.stub().returns(docRef)
    };

    const dateRef = {
      collection: sinon.stub().returns(collectionRef)
    };

    firestoreStub.collection.returns({
      doc: sinon.stub().returns(dateRef)
    });
  });

  after(function() {
    require('mock-require').stopAll();
  });

  it('should handle successful notification send and create new doc', async function() {
    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify payload handler was called
    assert(payloadHandler.calledOnce, 'Payload handler should be called once');
    assert(payloadHandler.calledWith(req), 'Payload handler should be called with request');

    // Verify messaging.send was called
    assert(messagingStub.send.calledOnce, 'messaging.send should be called once');
    const sentPayload = messagingStub.send.firstCall.args[0];
    assert.equal(sentPayload.token, 'test:token123', 'Token should be added to payload');

    // Verify Firestore doc was created
    assert(docRef.set.calledOnce, 'doc.set should be called for new document');
    const savedData = docRef.set.firstCall.args[0];
    assert.equal(savedData.attemptsCount, 1, 'Attempts count should be 1');
    assert.equal(savedData.deliveredCount, 1, 'Delivered count should be 1');
    assert.equal(savedData.totalCount, 1, 'Total count should be 1');
    assert.equal(savedData.errorCount, 0, 'Error count should be 0');

    // Verify successful response
    assert(res.status.calledWith(201), 'Should return 201 status');
    const responseData = res.send.firstCall.args[0];
    assert.equal(responseData.messageId, 'mock-message-id', 'Should return message ID');
    assert.equal(responseData.target, 'test:token123', 'Should return target token');
    assert(responseData.rateLimits, 'Should include rate limits');
  });

  it('should handle successful notification send and update existing doc', async function() {
    // Set up existing document
    docSnapshot.exists = true;
    docSnapshot.data.returns({
      attemptsCount: 10,
      deliveredCount: 5,
      errorCount: 2,
      totalCount: 7
    });

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify Firestore doc was updated
    assert(docRef.update.calledOnce, 'doc.update should be called for existing document');
    assert(docRef.set.notCalled, 'doc.set should not be called for existing document');
    
    const updatedData = docRef.update.firstCall.args[0];
    assert.equal(updatedData.attemptsCount, 11, 'Attempts count should be incremented');
    assert.equal(updatedData.deliveredCount, 6, 'Delivered count should be incremented');
    assert.equal(updatedData.totalCount, 8, 'Total count should be incremented');
    assert.equal(updatedData.errorCount, 2, 'Error count should remain the same');

    // Verify response
    assert(res.status.calledWith(201), 'Should return 201 status');
  });

  it('should handle notification send failure and update error count', async function() {
    // Make messaging.send fail
    messagingStub.send.rejects(new Error('FCM send failed'));

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify Firestore doc was created with error count
    assert(docRef.set.calledOnce, 'doc.set should be called');
    const savedData = docRef.set.firstCall.args[0];
    assert.equal(savedData.attemptsCount, 1, 'Attempts count should be 1');
    assert.equal(savedData.deliveredCount, 0, 'Delivered count should be 0');
    assert.equal(savedData.errorCount, 1, 'Error count should be 1');
    assert.equal(savedData.totalCount, 1, 'Total count should be 1');

    // Verify error response
    assert(res.status.calledWith(500), 'Should return 500 status for send failure');
    const responseData = res.send.firstCall.args[0];
    assert.equal(responseData.errorType, 'InternalError', 'Should return internal error');
    assert.equal(responseData.errorStep, 'sendNotification', 'Should indicate send notification step');
  });

  it('should reject notifications over rate limit', async function() {
    // Set up doc over rate limit
    docSnapshot.exists = true;
    docSnapshot.data.returns({
      attemptsCount: 501,
      deliveredCount: 501, // Over MAX_NOTIFICATIONS_PER_DAY (500)
      errorCount: 0,
      totalCount: 501
    });

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify notification was not sent (only rate limit doc update)
    assert(messagingStub.send.notCalled, 'messaging.send should not be called when over rate limit');

    // Verify doc was still updated with attempt
    assert(docRef.update.calledOnce, 'doc.update should be called');
    const updatedData = docRef.update.firstCall.args[0];
    assert.equal(updatedData.attemptsCount, 502, 'Attempts count should be incremented');

    // Verify rate limit response
    assert(res.status.calledWith(429), 'Should return 429 status for rate limit');
    const responseData = res.send.firstCall.args[0];
    assert.equal(responseData.errorType, 'RateLimited', 'Should return rate limited error');
    assert(responseData.message.includes('maximum number of notifications'), 'Should include rate limit message');
  });

  it('should not update rate limits for critical notifications', async function() {
    // Set payload handler to return updateRateLimits: false
    payloadHandler.returns({
      updateRateLimits: false,
      payload: {
        notification: { body: 'Critical message' }
      }
    });

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify messaging.send was called
    assert(messagingStub.send.calledOnce, 'messaging.send should be called');

    // Verify Firestore doc was NOT updated for rate limits
    assert(docRef.set.notCalled, 'doc.set should not be called for critical notifications');
    assert(docRef.update.notCalled, 'doc.update should not be called for critical notifications');

    // Verify response still returns rate limit info
    assert(res.status.calledWith(201), 'Should return 201 status');
    const responseData = res.send.firstCall.args[0];
    assert(responseData.rateLimits, 'Should still include rate limits in response');
  });

  it('should handle invalid token format', async function() {
    req.body.push_token = 'invalid-token-without-colon';

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify error response
    assert(res.status.calledWith(403), 'Should return 403 for invalid token');
    const responseData = res.send.firstCall.args[0];
    assert.equal(responseData.errorMessage, 'That is not a valid FCM token');

    // Verify nothing else was called
    assert(messagingStub.send.notCalled, 'messaging.send should not be called');
    assert(docRef.get.notCalled, 'Firestore should not be accessed');
  });

  it('should handle missing token', async function() {
    delete req.body.push_token;

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify error response
    assert(res.status.calledWith(403), 'Should return 403 for missing token');
    const responseData = res.send.firstCall.args[0];
    assert.equal(responseData.errorMessage, 'You did not send a token!');

    // Verify nothing else was called
    assert(messagingStub.send.notCalled, 'messaging.send should not be called');
    assert(docRef.get.notCalled, 'Firestore should not be accessed');
  });

  it('should handle Firestore read errors', async function() {
    // Make Firestore get fail
    docRef.get.rejects(new Error('Firestore read failed'));

    await indexModule.handleRequest(req, res, payloadHandler);

    // Verify error response
    assert(res.status.calledWith(500), 'Should return 500 for Firestore error');
    const responseData = res.send.firstCall.args[0];
    assert.equal(responseData.errorType, 'InternalError');
    assert.equal(responseData.errorStep, 'getRateLimitDoc');
  });
});