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

The overlay fixes the source identity and accepts only the public hostname from
the deployment environment:

```text
VOICETEXT_GATEWAY_GIT_URL=https://github.com/777genius/voicetext-gateway.git
VOICETEXT_GATEWAY_GIT_REF=8edc6292abeed05b31c7ee683a737f8b62b6f4a6
VOICETEXT_GATEWAY_SOURCE_REVISION=8edc6292abeed05b31c7ee683a737f8b62b6f4a6
VOICETEXT_PUBLIC_HOST=voice.example.com
```

BuildKit resolves that exact ref and verifies it with the identical `checksum`
Git-context query before executing the gateway Dockerfile. This requires Docker
Buildx 0.28.0 or newer and Dockerfile syntax 1.18 or newer.

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

`voicetext-service-token` is one shared machine-credential file, not two copied
files. Generate at least 32 random bytes, encode them as one non-empty line with
no `Bearer ` prefix, make the regular non-symlink file owned by UID `10001` and
mode `0400`, and mount that exact inode read-only into both services. Meeting
Platform reads it through `VOICETEXT_SERVICE_TOKEN_FILE`; the gateway reads it
through `VOICETEXT_BEARER_TOKEN_FILE`. Rotate it stop-first on both services so
different old/new bytes can never coexist.

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

### Implemented profile mapping and qualification status

| Platform profile | Provider / model / mode | Language sent | Contract coverage | Exact-revision provider quality |
| --- | --- | --- | --- | --- |
| `deepgram-nova-3` batch | Deepgram / `nova-3` / batch contract v2 | `multi` | deterministic routing plus authenticated black-box scenario | Pending; no retained EN/RU acoustic-quality campaign for the pinned revisions |
| `deepgram-nova-3` live | Deepgram / `nova-3` / streaming contract v2 | configured live language | deterministic routing plus authenticated black-box scenario | Pending; derived captions never become authoritative evidence |
| `elevenlabs-scribe-v2` batch | ElevenLabs / `scribe_v2` / batch contract v3 | `multi` | deterministic routing plus authenticated black-box scenario | Pending; no retained EN/RU acoustic-quality campaign for the pinned revisions |
| `elevenlabs-scribe-v2-realtime` live | ElevenLabs / `scribe_v2_realtime` / streaming contract v2 | configured live language | deterministic routing plus authenticated black-box scenario | Pending; derived captions never become authoritative evidence |

Recognition languages depend on the selected provider and model, mode, and
provider account configuration; the gateway contract does not broaden them.
No English or Russian provider flow is qualified for acoustic quality on this
exact public OSS revision. Historical/private EN/RU results are evidence only
for the revisions named in their retained receipts, if any, and are not promoted
here. The historical statement "Only English and Russian provider flows are
qualified" applies, if at all, solely to those private receipts; that status does
not transfer to the exact public OSS revision.
Ukrainian may be selected
for presentation of already accepted text, but is not a qualified STT language
and must not be inferred from presentation behavior. The implemented Discord
Pipecat conversation profile is optional, default-off, and non-core. A
Pipecat-to-VoiceText provider adapter is future/unimplemented; it is not part of
this gateway or the core OSS meeting topology.

The adapter and gateway contract checks do not establish final private-guild
acceptance; that remains pending until the live Discord campaign passes with an
official test bot in a private test guild.

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

The external cross-head Rust/TypeScript gate is authenticated and exercises all
four provider/mode profiles. Run it only against an explicitly approved fake
provider or with test-only provider credentials and the synthetic Ogg fixture;
it is not providerless and is not itself an acoustic-quality qualification:

```sh
VOICETEXT_GATEWAY_E2E_HTTP_ORIGIN=http://127.0.0.1:8080 \
VOICETEXT_GATEWAY_E2E_WS_ORIGIN=ws://127.0.0.1:8080 \
VOICETEXT_GATEWAY_E2E_TOKEN='<test-only bearer token>' \
VOICETEXT_GATEWAY_E2E_OGG_FIXTURE=/absolute/path/to/synthetic.ogg \
VOICETEXT_CADDY_BIN=/absolute/path/to/caddy \
pnpm --filter @discord-meeting/voicetext-adapter run test:gateway-exact-head
```

The ordinary package test runs a providerless routing scenario against an
in-memory origin and skips the external scenario when these four variables are
absent. The exact-head command fails if any external variable or the offline
Caddy adapter is absent. Passing the scenario proves compatibility and profile
routing only; retain a separately admitted exact-revision campaign before making
EN/RU or provider-quality claims.
