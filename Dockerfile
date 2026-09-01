# Backend Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY backend/package*.json ./
RUN npm ci --only=production

# Copy source
COPY backend/src ./src
COPY backend/prisma ./prisma
COPY backend/.env ./.env

# Create database directory
RUN mkdir -p database

# Generate Prisma Client
RUN npx prisma generate

EXPOSE 3000

CMD ["node", "src/index.js"]
