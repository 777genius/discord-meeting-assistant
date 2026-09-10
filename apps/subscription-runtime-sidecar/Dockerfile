# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf
FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime-source-build
WORKDIR /source
COPY --from=subscription_runtime_source / /source/
RUN npm ci --ignore-scripts --registry=https://registry.npmjs.org \
    && npm run build \
    && npm pack --ignore-scripts --pack-destination /tmp
RUN node -e 'const p=require("./package.json"); if(p.name!=="@vioxen/subscription-runtime" || p.version!=="0.1.0-main.28") process.exit(1)'
RUN npm ci --omit=dev --ignore-scripts --registry=https://registry.npmjs.org \
    && mkdir -p /opt/subscription-runtime/node_modules/@vioxen/subscription-runtime \
    && cp -a node_modules/. /opt/subscription-runtime/node_modules/ \
    && tar -xzf /tmp/vioxen-subscription-runtime-0.1.0-main.28.tgz --strip-components=1 -C /opt/subscription-runtime/node_modules/@vioxen/subscription-runtime

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/subscription-runtime-sidecar/package.json apps/subscription-runtime-sidecar/package.json
COPY packages/subscription-runtime-adapter/package.json packages/subscription-runtime-adapter/package.json
COPY packages/meeting-core/package.json packages/meeting-core/package.json
RUN pnpm install --frozen-lockfile
COPY packages/meeting-core ./packages/meeting-core
COPY packages/subscription-runtime-adapter ./packages/subscription-runtime-adapter
RUN pnpm --filter=@discord-meeting/subscription-runtime-sidecar... --if-present run build

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
ARG SOURCE_REVISION
ARG SUBSCRIPTION_RUNTIME_SOURCE_REVISION
LABEL io.botik.subscription-runtime.source="https://github.com/777genius/ar" \
      io.botik.subscription-runtime.revision="${SUBSCRIPTION_RUNTIME_SOURCE_REVISION}"
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
RUN printf '%s' "${SOURCE_REVISION}" \
  | grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$'
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PATH=/app/apps/subscription-runtime-sidecar/node_modules/.bin:$PATH \
    SSL_CERT_DIR=/etc/ssl/certs \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=runtime-source-build /opt/subscription-runtime/node_modules /opt/subscription-runtime/node_modules
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/subscription-runtime-sidecar/node_modules ./apps/subscription-runtime-sidecar/node_modules
COPY --from=dependencies /app/packages/subscription-runtime-adapter/node_modules ./packages/subscription-runtime-adapter/node_modules
COPY apps/subscription-runtime-sidecar ./apps/subscription-runtime-sidecar
COPY packages/subscription-runtime-adapter/proto/agent_runtime.proto ./packages/subscription-runtime-adapter/proto/agent_runtime.proto
COPY --chown=10001:10001 infra/subscription-runtime/audited-*.mjs /opt/subscription-runtime/
COPY packages/subscription-runtime-adapter ./packages/subscription-runtime-adapter
COPY packages/meeting-core ./packages/meeting-core
COPY --from=dependencies /app/packages/meeting-core/dist ./packages/meeting-core/dist
COPY --from=dependencies /app/packages/subscription-runtime-adapter/dist ./packages/subscription-runtime-adapter/dist
COPY tsconfig.json ./tsconfig.json
RUN chmod 0555 /opt/subscription-runtime/audited-xhigh-launcher.mjs \
    && chmod 0444 /opt/subscription-runtime/audited-codex-jsonl-bridge-output.mjs \
      /opt/subscription-runtime/audited-codex-jsonl-capture-store.mjs \
      /opt/subscription-runtime/audited-codex-jsonl-capture.mjs \
      /opt/subscription-runtime/audited-codex-jsonl-events.mjs \
      /opt/subscription-runtime/audited-xhigh-policy.mjs
USER 10001:10001
ENTRYPOINT ["/app/apps/subscription-runtime-sidecar/node_modules/.bin/tsx", "/app/apps/subscription-runtime-sidecar/src/main.ts"]
