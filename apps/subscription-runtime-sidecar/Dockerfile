FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/subscription-runtime-sidecar/package.json apps/subscription-runtime-sidecar/package.json
COPY packages/subscription-runtime-adapter/package.json packages/subscription-runtime-adapter/package.json
COPY packages/meeting-core/package.json packages/meeting-core/package.json
RUN pnpm install --frozen-lockfile

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PATH=/app/apps/subscription-runtime-sidecar/node_modules/.bin:$PATH \
    SSL_CERT_DIR=/etc/ssl/certs \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/subscription-runtime-sidecar/node_modules ./apps/subscription-runtime-sidecar/node_modules
COPY --from=dependencies /app/packages/subscription-runtime-adapter/node_modules ./packages/subscription-runtime-adapter/node_modules
COPY apps/subscription-runtime-sidecar ./apps/subscription-runtime-sidecar
COPY apps/meeting-platform/proto/agent_runtime.proto ./apps/meeting-platform/proto/agent_runtime.proto
COPY packages/subscription-runtime-adapter ./packages/subscription-runtime-adapter
COPY packages/meeting-core ./packages/meeting-core
COPY tsconfig.json ./tsconfig.json
USER 10001:10001
ENTRYPOINT ["/app/apps/subscription-runtime-sidecar/node_modules/.bin/tsx", "/app/apps/subscription-runtime-sidecar/src/main.ts"]
