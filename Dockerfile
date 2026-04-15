# syntax=docker/dockerfile:1.7

########################
# Stage 1 — build TS
########################
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

########################
# Stage 2 — prod deps
########################
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

########################
# Stage 3 — runtime
########################
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    YTDLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    LOG_FILE=true

# Install ffmpeg + fetch static yt-dlp binary
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl python3 tini \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY package.json ./

RUN useradd --system --uid 1001 --home /app bot \
 && mkdir -p /app/logs \
 && chown -R bot:bot /app

USER bot

# tini for proper PID 1 signal handling (SIGTERM → graceful shutdown)
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
