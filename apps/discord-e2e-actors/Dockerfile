FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV PNPM_HOME=/opt/pnpm \
    PATH=/opt/pnpm:$PATH

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.18.0 --activate \
  && groupadd --gid 10001 e2e \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin e2e

WORKDIR /app
COPY --chown=10001:10001 . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @discord-meeting/discord-e2e-actors build \
  && pnpm store prune

USER 10001:10001
WORKDIR /app/apps/discord-e2e-actors
ENTRYPOINT ["node", "dist/main.js"]
