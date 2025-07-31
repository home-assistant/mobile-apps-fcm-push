FROM node:24-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy all necessary application files in one layer
COPY \
    webapp.js \
    index.js \
    android.js \
    ios.js \
    legacy.js \
    handlers.js \
    fastify-logger.js \
    ./

COPY rate-limiter/ ./rate-limiter/

# Start the application
CMD ["node", "webapp.js"]