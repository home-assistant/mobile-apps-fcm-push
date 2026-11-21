FROM node:24-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy all application JS files in one layer
COPY *.js ./

COPY rate-limiter/ ./rate-limiter/

# Start the application
CMD ["node", "webapp.js"]