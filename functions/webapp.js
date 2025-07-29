'use strict';

const { initializeApp } = require('firebase-admin/app');
// We need to initialize the app before importing modules that want Firestore or Messaging.
initializeApp();

const { loggerConfig } = require('./fastify-logger');
const fastify = require('fastify')({ logger: loggerConfig, trustProxy: true });

// Import the functions from index.js
const { handleRequest, handleCheckRateLimits } = require('./handlers');

const android = require('./android');
const ios = require('./ios');
const legacy = require('./legacy');

// Cloud Functions adapter
function createCloudFunctionsAdapter(request, reply) {
  return {
    req: {
      body: request.body,
      method: request.method,
      originalUrl: request.url,
      ip: request.ip,
      get: (header) => request.headers[header.toLowerCase()],
    },
    res: {
      status: (code) => ({
        send: (data) => reply.code(code).send(data),
      }),
    },
  };
}

// Route handlers
async function handleAndroidV1(request, reply) {
  const { req, res } = createCloudFunctionsAdapter(request, reply);
  handleRequest(req, res, android.createPayload);
}

async function handleIOSV1(request, reply) {
  const { req, res } = createCloudFunctionsAdapter(request, reply);
  handleRequest(req, res, ios.createPayload);
}

async function handleSendPushNotification(request, reply) {
  const { req, res } = createCloudFunctionsAdapter(request, reply);
  handleRequest(req, res, legacy.createPayload);
}

async function checkRateLimits(request, reply) {
  const { req, res } = createCloudFunctionsAdapter(request, reply);
  handleCheckRateLimits(req, res);
}

// Register routes
fastify.post('/androidV1', handleAndroidV1);
fastify.post('/iOSV1', handleIOSV1);
fastify.post('/sendPushNotification', handleSendPushNotification);
fastify.post('/checkRateLimits', checkRateLimits);

// Health check endpoint
fastify.get('/health', async (request, reply) => {
  return { status: 'ok' };
});

// Start server
const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '8080', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  fastify.log.info('SIGTERM signal received: closing HTTP server');
  await fastify.close();
  process.exit(0);
});

start();
