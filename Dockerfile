FROM node:22-alpine

WORKDIR /app

# Install deps first (layer cache optimization)
COPY package.json ./
RUN npm install --omit=dev

COPY tracker.js ./

# Non-root user for security
RUN addgroup -S tracker && adduser -S tracker -G tracker
USER tracker

CMD ["node", "tracker.js"]
