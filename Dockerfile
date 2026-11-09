# Synteel for local runs and self-hosting: one container serves the API and the built app on port 8787.
# eel.synt.fun does not use this image (systemd + Caddy there). Usage: compose.yaml, or README "Run with Docker".

# 1. Build the phone app and the team dashboard (web/dist, web/dist/admin).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY admin/package.json admin/
RUN npm ci --no-audit --no-fund
# The app imports types from server/src, so the whole source goes in (.dockerignore keeps secrets and data out).
COPY . .
RUN npm run build

# 2. Runtime dependencies only.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
COPY admin/package.json admin/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 3. The server, running TypeScript directly (Node 24 strips the types), as an unprivileged user.
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    SYNTEEL_WEB_DIR=/app/web/dist \
    SYNTEEL_DB=/app/data/synteel.sqlite \
    SYNTEEL_CAPTURES=/app/data/captures/
WORKDIR /app
COPY --from=deps /app ./
COPY server server
COPY knowledge knowledge
COPY scripts scripts
COPY docker/start.sh docker/start.sh
COPY --from=build /app/web/dist web/dist
# The database and photos live in /app/data, a volume (compose.yaml). Keys come from the environment, never the image.
RUN mkdir -p /app/data/captures && chown -R node:node /app/data
USER node
VOLUME /app/data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["sh", "docker/start.sh"]
