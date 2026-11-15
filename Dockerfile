FROM node:22-alpine
# Patched Alpine packages even before the base tag is republished.
RUN apk upgrade --no-cache

WORKDIR /app

# Install deps first (layer cache optimization)
COPY package.json ./
RUN npm install --omit=dev
# The app runs with node (CMD); the bundled npm/npx/corepack are not needed at runtime and
# carry HIGH CVEs of their own (Trivy gate), so they are removed from the final image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY tracker.js ./

# Non-root user for security
RUN addgroup -S tracker && adduser -S tracker -G tracker
USER tracker

EXPOSE 3000

CMD ["node", "tracker.js"]