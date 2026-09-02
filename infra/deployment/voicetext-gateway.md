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

The first three rows below are immutable checked-in Compose constants, not deployment environment variables. Only `VOICETEXT_PUBLIC_HOST` is operator supplied:

| Setting | Checked value |
| --- | --- |
| `VOICETEXT_GATEWAY_GIT_URL` | `https://github.com/777genius/voicetext-gateway.git` |
| `VOICETEXT_GATEWAY_GIT_REF` | `28202aca479bad722289da8d2633d6cfd249c6c1` |
| `VOICETEXT_GATEWAY_SOURCE_REVISION` | `28202aca479bad722289da8d2633d6cfd249c6c1` |
| `VOICETEXT_PUBLIC_HOST` | operator-supplied DNS name |

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
| `deepgram-nova-3` batch | Deepgram / `nova-3` / batch contract v2 | `multi` | providerless deterministic contract only | Pending; no retained EN/RU acoustic-quality campaign for the pinned revisions |
| `deepgram-nova-3` live | Deepgram / `nova-3` / streaming contract v2 | configured live language | providerless deterministic contract only | Pending; derived captions never become authoritative evidence |
| `elevenlabs-scribe-v2` batch | ElevenLabs / `scribe_v2` / batch contract v3 | `multi` | providerless deterministic contract only | Pending; no retained EN/RU acoustic-quality campaign for the pinned revisions |
| `elevenlabs-scribe-v2-realtime` live | ElevenLabs / `scribe_v2_realtime` / streaming contract v2 | configured live language | providerless deterministic contract only | Pending; derived captions never become authoritative evidence |

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

The ordinary adapter package test is explicitly providerless. Its fake loopback
gateway uses fabricated transcript text and is contract coverage only.

The separate opt-in provider canary sends the pinned real-speech Ogg fixture to
one selected batch/live provider pair. Its five required transcript terms are
checked-in constants, not operator inputs. It first verifies a create-only
running gateway identity observation against the pinned commit, independently expected
Git tree, full immutable image digest, origins, run ID, and identity digest. It
retains a create-only identity-bound receipt only after provider-derived batch
and live text, timestamps, ACKs, idempotent replay, and finalization pass. The
complete variable and receipt contracts are documented in
`packages/voicetext-adapter/README.md`. A credentialed invocation has this shape:

```sh
VOICETEXT_GATEWAY_PROVIDER_CANARY_REQUIRED=1 \
VOICETEXT_GATEWAY_PROVIDER_CANARY_HTTP_ORIGIN=https://voice.example.com \
VOICETEXT_GATEWAY_PROVIDER_CANARY_WS_ORIGIN=wss://voice.example.com \
VOICETEXT_GATEWAY_PROVIDER_CANARY_TOKEN='<test-only bearer token>' \
VOICETEXT_GATEWAY_PROVIDER_CANARY_PROFILE=deepgram \
VOICETEXT_GATEWAY_PROVIDER_CANARY_FIXTURE=/absolute/path/to/speaker-a.ru-en.ogg \
VOICETEXT_GATEWAY_PROVIDER_CANARY_RUN_ID=release-candidate-deepgram \
VOICETEXT_GATEWAY_PROVIDER_CANARY_IDENTITY_FILE=/create-only/evidence/gateway-identity.json \
VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_IDENTITY_SHA256='<64 lowercase hex>' \
VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_TREE='<exact Git tree object ID>' \
VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_IMAGE_DIGEST='<repository@sha256:...>' \
VOICETEXT_GATEWAY_PROVIDER_CANARY_RECEIPT=/new/evidence/deepgram-receipt.json \
pnpm --filter @discord-meeting/voicetext-adapter run test:gateway-provider-canary
```

Run it again with `PROFILE=elevenlabs`, a fresh run ID, a separately observed
identity binding, and a new receipt path to qualify that pair. Never reuse or
overwrite an identity or receipt path. `test:gateway-exact-head` additionally
requires the offline Caddy adapter check. Neither command is a language or
private-Discord qualification; no EN, RU, UK, or other language claim may be
made without separately retained, exact-identity acoustic evidence.
