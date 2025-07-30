FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy only the necessary application files
COPY webapp.js ./
COPY index.js ./
COPY android.js ./
COPY ios.js ./
COPY legacy.js ./
COPY handlers.js ./
COPY fastify-logger.js ./

# Copy the rate-limiter directory
COPY rate-limiter/ ./rate-limiter/

# Start the application
CMD ["node", "webapp.js"]