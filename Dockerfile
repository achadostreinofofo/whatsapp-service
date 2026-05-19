FROM node:20-alpine

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    libc6-compat \
    curl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/sessions

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f -H "x-api-secret:${API_SECRET}" http://localhost:3001/health || exit 1

CMD ["node", "src/index.js"]
