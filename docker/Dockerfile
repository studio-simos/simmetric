# ============================================================
# Single-container mode (all-in-one for standalone / air-gapped
# deployment). Runs PostgreSQL + server + collector + widget +
# entrypoint in one container via supervisord.
#
# For production multi-container deployments, use:
#   docker compose -f docker/docker-compose.yml up -d
# with the individual Dockerfile.* images.
# ============================================================

# Stage 1: Build
FROM node:24-alpine AS builder

RUN corepack enable

WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/frontend/package.json packages/frontend/
COPY packages/collector/package.json packages/collector/
COPY packages/widget/package.json packages/widget/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/
COPY packages/frontend/ packages/frontend/
COPY packages/collector/ packages/collector/
COPY packages/widget/ packages/widget/

# Generate Prisma client
RUN pnpm --filter server db:generate

# Build all packages
RUN pnpm build

# Build widget client bundle (Vite, not covered by turbo build)
RUN pnpm --filter widget build:widget

# ============================================================
# Stage 2: Runtime
# ============================================================
FROM node:24-alpine AS runtime

RUN corepack enable

WORKDIR /app

# Install PostgreSQL, supervisord, git, poppler-utils (PDF rendering), and
# the pgvector extension (D-08 Phase 91-01: air-gap bundle — the extension .so
# + .control + .sql are installed offline via apk; no internet at boot).
# node:24-alpine is based on Alpine 3.20; postgresql16-pgvector is published
# in the community repo. If the package is unavailable on a future Alpine
# bump, fall back to: --repository=http://dl-cdn.alpinelinux.org/alpine/edge/community
# (unpinned base deps — project policy: rely on Alpine point-release rebuilds)
# hadolint ignore=DL3018
RUN apk add --no-cache \
  postgresql16 \
  postgresql16-pgvector \
  postgresql16-client \
  supervisor \
  git \
  poppler-utils \
  chromium \
  nss \
  freetype \
  harfbuzz \
  ca-certificates \
  ttf-freefont \
  curl \
  wget

# Initialize PostgreSQL directories
RUN mkdir -p /run/postgresql && chown node:node /run/postgresql
RUN mkdir -p /var/lib/postgresql/data && chown node:node /var/lib/postgresql/data

# Copy workspace config
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy package manifests for pnpm
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/frontend/package.json packages/frontend/
COPY packages/collector/package.json packages/collector/
COPY packages/widget/package.json packages/widget/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/packages/frontend/dist/ packages/frontend/dist/
COPY --from=builder /app/packages/collector/dist/ packages/collector/dist/
COPY --from=builder /app/packages/widget/dist/ packages/widget/dist/
COPY --from=builder /app/packages/widget/dist-widget/ packages/widget/dist-widget/

# Copy Prisma schema and config from builder
COPY --from=builder /app/packages/server/prisma/ packages/server/prisma/
COPY --from=builder /app/packages/server/prisma.config.ts packages/server/prisma.config.ts

# Copy entrypoint + shared production-secret provisioning helper (parity
# with the split image: entrypoint-server.sh sources the same helper).
COPY docker/entrypoint.sh /app/entrypoint.sh
COPY docker/provision-encryption-key.sh /app/provision-encryption-key.sh
RUN chmod +x /app/entrypoint.sh /app/provision-encryption-key.sh

# Create storage directories
RUN mkdir -p /app/storage/data /app/storage/backups /app/storage/documents /app/storage/vectors /app/storage/uploads

# Environment defaults
ENV NODE_ENV=production
ENV SERVER_PORT=3000
ENV COLLECTOR_PORT=3210
ENV WIDGET_PORT=3211
ENV SERVER_URL=http://localhost:3000
ENV COLLECTOR_URL=http://localhost:3210
ENV WIDGET_SERVICE_URL=http://localhost:3211
ENV DATABASE_URL=postgresql://simmetricchat:simmetricchat@localhost:5432/simmetricchat
# Documented scaffolding placeholders — operators override via .env / -e.
# hadolint ignore=DL3064
ENV JWT_SECRET=change-me-in-production
# hadolint ignore=DL3064
ENV COLLECTOR_SECRET=change-me-in-production
# hadolint ignore=DL3064
ENV WIDGET_API_KEY=change-widget-api-key-in-production
ENV LLM_PROVIDER=ollama
ENV OLLAMA_BASE_URL=http://ollama:11434
ENV OLLAMA_KEEP_ALIVE=10m
ENV EMBEDDING_PROVIDER=local
ENV VECTOR_DB_PROVIDER=lancedb
ENV STORAGE_PATH=/app/storage
ENV ALLOW_REGISTRATION=false
ENV DISABLE_TELEMETRY=true
ENV LOG_LEVEL=info

EXPOSE 3000 3210 3211

VOLUME ["/app/storage"]

# Copy supervisord configuration
COPY docker/supervisord.conf /etc/supervisord.conf

# hadolint ignore=DL3025
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=30s \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
