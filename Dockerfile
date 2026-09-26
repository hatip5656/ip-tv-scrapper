FROM node:22-slim

# Install Playwright system dependencies
RUN npx playwright install-deps chromium

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci
RUN npx playwright install chromium

COPY src/ ./src/

EXPOSE 7778

CMD ["node", "src/index.js"]
