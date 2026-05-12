FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p /app/backend/data
EXPOSE 3001
CMD ["node", "backend/server.js"]
