# Packages the Mr. White server for Cloud Run.
#
# There is no build step — the client in public/ is plain JS and the server
# is plain Node ESM — so this is a single stage: install, copy, run.
#
# Cloud Run injects PORT itself (8080 by default) and requires the process to
# bind 0.0.0.0; server/index.js already does both via config already used for
# local dev (`HOST`/`PORT` env vars), so nothing here is Cloud-Run-specific.
FROM node:20-slim

WORKDIR /app

# Installed before the rest of the source, so this layer is cached across
# rebuilds that only change game code, not dependencies.
COPY package.json package-lock.json ./
# --omit=optional skips playwright (a multi-hundred-MB browser download, only
# ever used by tools/smoke.js) and ws's own optional native accelerators —
# ws falls back to a pure-JS path without them, which is fine at the message
# sizes this protocol ever sends (capped at 16 KB).
RUN npm ci --omit=optional

COPY server ./server
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server/index.js"]
