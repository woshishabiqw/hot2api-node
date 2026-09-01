# Admin Frontend - static serve without Nginx
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:20-alpine
RUN npm install -g serve
WORKDIR /app
COPY --from=builder /app/dist /app/dist

EXPOSE 80
CMD ["serve", "-s", "dist", "-l", "80"]
