# Warm Playwright worker for on-demand price refresh (Cloud Run).
# Build context: repository root.
FROM mcr.microsoft.com/playwright:v1.52.0-jammy

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
# Need playwright package (devDependency in root) + runtime deps.
# Browsers already ship in the Playwright base image.
RUN npm ci

COPY scripts/bricklink-parser ./scripts/bricklink-parser
COPY functions/priceStructure.js ./functions/priceStructure.js
COPY functions/cmfCatalog.js ./functions/cmfCatalog.js

ENV NODE_ENV=production
ENV PORT=8080
ENV BL_PARSE_TIMEOUT_MS=90000

EXPOSE 8080
CMD ["node", "scripts/bricklink-parser/worker/server.js"]
