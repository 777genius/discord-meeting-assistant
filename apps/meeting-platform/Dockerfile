FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates ffmpeg git \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@11.18.0 --activate \
  && groupadd --gid 10001 meeting \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin meeting

# Keep the expensive system dependency layer independent from the immutable
# source revision so a rollout does not download and install apt packages again.
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"

RUN printf '%s' "${SOURCE_REVISION}" \
  | grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$'

WORKDIR /app
COPY --chown=10001:10001 . .
# The mandatory PostgreSQL/Testcontainers qualification runs on the host/CI
# before image construction; BuildKit intentionally has no Docker socket.
RUN node vendor/infinity-context/prepare-official-sdk.mjs \
  && pnpm install --frozen-lockfile --filter @discord-meeting/meeting-platform... \
  && pnpm --filter @discord-meeting/meeting-platform check:image \
  && node vendor/infinity-context/prepare-official-sdk.mjs --prune-dev \
  && pnpm store prune

USER 10001:10001
EXPOSE 4310
ENTRYPOINT ["/app/apps/meeting-platform/node_modules/.bin/tsx", "/app/apps/meeting-platform/src/main.ts"]
