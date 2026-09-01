# Self-hosted VoiceText Gateway

`compose.voicetext-gateway.yaml` replaces the default private VoiceText endpoint
without changing Meeting Platform code. It builds the separately versioned OSS
Rust gateway, gives it a private PostgreSQL database, and exposes only the
VoiceText-compatible HTTPS and WebSocket routes through Caddy.

There is no released gateway image claimed by this repository. The overlay
fails closed unless BuildKit checks out a Git ref whose commit matches the exact
configured checksum. It uses that same checksum as the local image tag and OCI
revision label.

## Pin the source

Set these non-secret values in the deployment environment:

```text
VOICETEXT_GATEWAY_GIT_URL=https://github.com/777genius/voicetext-gateway.git
VOICETEXT_GATEWAY_GIT_REF=refs/tags/v1.2.3
VOICETEXT_GATEWAY_SOURCE_REVISION=<exact 40- or 64-character Git commit>
VOICETEXT_PUBLIC_HOST=voice.example.com
```

BuildKit resolves `VOICETEXT_GATEWAY_GIT_REF` and verifies it with the
`checksum=VOICETEXT_GATEWAY_SOURCE_REVISION` Git-context query before executing
the gateway Dockerfile. A moved tag or branch fails the build instead of
silently relabelling different source. This requires Docker Buildx 0.28.0 or
newer and Dockerfile syntax 1.18 or newer.

For an offline deployment, first mirror the exact repository and objects onto
the deployment host, verify the checkout with Git, and use a local bare or
non-bare repository URL such as
`file:///srv/git/voicetext-gateway/.git`. Keep the exact ref and commit settings;
do not replace the Git URL with an unverified directory build context.

Point public DNS for `VOICETEXT_PUBLIC_HOST` to the host and allow inbound TCP
80/443 and UDP 443. The overlay derives Meeting Platform's sole VoiceText URL
from this hostname. The gateway and Meeting Platform reuse
`${DEPLOY_ROOT}/secrets/platform/voicetext-service-token`; provider credentials
never enter Meeting Platform.

## Provision secrets and profiles

Create these regular, non-symlink files:

```text
${DEPLOY_ROOT}/secrets/platform/voicetext-service-token
${DEPLOY_ROOT}/secrets/voicetext/postgres-password
${DEPLOY_ROOT}/secrets/voicetext/postgres-url
${DEPLOY_ROOT}/secrets/voicetext/providers/deepgram-api-key       # optional
${DEPLOY_ROOT}/secrets/voicetext/providers/elevenlabs-api-key    # optional
${DEPLOY_ROOT}/config/voicetext-gateway.env
```

The PostgreSQL URL file contains a URL-escaped copy of the password:

```text
postgresql://voicetext:<password>@voicetext-postgres:5432/voicetext
```

Configure provider key file paths in `voicetext-gateway.env`:

```text
VOICETEXT_DEEPGRAM_API_KEY_FILE=/run/voicetext-provider-secrets/deepgram-api-key
VOICETEXT_ELEVENLABS_API_KEY_FILE=/run/voicetext-provider-secrets/elevenlabs-api-key
```

Omit the line and file for an unused provider. Never place key or token contents
in Compose or `.env`. The gateway process, spool, Caddy state directories, and
gateway-readable secrets use UID/GID `10001`; keep secrets mode `0400` and
directories mode `0700`.

Select Meeting Platform profiles independently:

```text
# Deepgram
VOICETEXT_BATCH_PROFILE=deepgram-nova-3
VOICETEXT_LIVE_PROFILE=deepgram-nova-3

# ElevenLabs
VOICETEXT_BATCH_PROFILE=elevenlabs-scribe-v2
VOICETEXT_LIVE_PROFILE=elevenlabs-scribe-v2-realtime
```

Mixed profiles require both provider credentials. Missing or unknown profiles
fail closed; neither Meeting Platform nor the gateway silently substitutes a
provider. Keep Deepgram available while draining historical
`voicetext-batch-v2:deepgram-nova-3` work.

Recognition languages depend on the selected provider and model. Only English
and Russian provider flows are qualified. The adapter and gateway contract
checks do not establish final private-guild acceptance; that remains pending
until the live Discord campaign passes with an official test bot in a private
test guild.

## Validate the configuration

Render the merged configuration before starting anything:

```sh
docker compose --env-file <deployment.env> \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml config
```

The overlay exposes only the batch v2/v3, live v2, and health routes. It does
not run a provider, Discord, admission, or campaign canary. Run any later live
qualification only with test-only provider keys, synthetic audio, an official
test bot, and a private test guild.
