# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# HMS backend (Express + TypeScript). Build from the REPO ROOT:
#   docker build -f backend/Dockerfile -t hms-backend .
# Multi-stage: install workspace deps -> compile -> slim runtime with prod deps only.
# ---------------------------------------------------------------------------
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace=backend --include-workspace-root=false --no-audit --no-fund

FROM deps AS build
COPY backend backend
RUN npm run build -w backend

FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace=backend --include-workspace-root=false --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production PORT=4000 STORAGE_PATH=/data/uploads BACKUP_PATH=/data/backups
WORKDIR /app/backend
RUN apk add --no-cache postgresql-client tini \
 && mkdir -p /data/uploads /data/backups && chown -R node:node /data /app
COPY --from=prod-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/package.json ./package.json
USER node
EXPOSE 4000
VOLUME ["/data/uploads", "/data/backups"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
# server.js applies pending migrations and permission bootstrap on start, then listens.
CMD ["node", "dist/server.js"]
