# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# HMS frontend (Next.js 14, standalone output). Build from the REPO ROOT:
#   docker build -f frontend/Dockerfile --build-arg BACKEND_INTERNAL_URL=http://backend:4000 -t hms-frontend .
# The /api/* rewrite target is resolved at build time, so pass the internal backend URL as a build arg.
# ---------------------------------------------------------------------------
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace=frontend --include-workspace-root=false --no-audit --no-fund

FROM deps AS build
ARG BACKEND_INTERNAL_URL=http://backend:4000
ENV BACKEND_INTERNAL_URL=${BACKEND_INTERNAL_URL} NEXT_PUBLIC_API_URL=/api NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=3072
COPY frontend frontend
RUN npm run build -w frontend

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN apk add --no-cache tini
# standalone bundle keeps the monorepo layout: /app/frontend/server.js + /app/node_modules
COPY --from=build --chown=node:node /app/frontend/.next/standalone ./
COPY --from=build --chown=node:node /app/frontend/.next/static ./frontend/.next/static
COPY --from=build --chown=node:node /app/frontend/public ./frontend/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/login >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "frontend/server.js"]
