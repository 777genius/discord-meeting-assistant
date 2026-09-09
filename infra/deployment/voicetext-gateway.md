# Self-hosted VoiceText Gateway

`compose.voicetext-gateway.yaml` supplies the self-hosted OSS VoiceText endpoint
without changing Meeting Platform code. A private VoiceText endpoint belongs to
the legacy hosted lane; it is not a deployment default or an OSS dependency.
Private SaaS reuse remains deferred/unverified under the
[OSS topology plan](oss-meeting-topology.md). A bounded follow-up must pin the
private SaaS contract/version, verify authentication and profile identity,
batch idempotency, live ACK/finalization, bounded failures and retained evidence
in an isolated synthetic deployment, then obtain separate provider and private
Discord acceptance before adoption. No SaaS compatibility is inferred here.
The overlay builds the separately versioned OSS Rust gateway, gives it a private
PostgreSQL database, and exposes only the
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
| `VOICETEXT_GATEWAY_GIT_REF` | `3e0ede3ec9086a45bc026f43191a998f2682fd6e` |
| `VOICETEXT_GATEWAY_SOURCE_REVISION` | `3e0ede3ec9086a45bc026f43191a998f2682fd6e` |
| `VOICETEXT_PUBLIC_HOST` | operator-supplied DNS name |

BuildKit resolves that exact ref and verifies it with the identical `checksum`
Git-context query before executing the gateway Dockerfile. This requires Docker
Buildx 0.28.0 or newer and Dockerfile syntax 1.18 or newer.

The Compose source pin identifies build input, not a qualified deployment.
Compare the observed image and source identities with the retained campaign
receipt before applying its results to a deployment; see
[receipt interpretation](oss-discord-stt-campaign.md#locate-and-interpret-a-trusted-receipt).
Database pooling defaults to 10 in Compose; the historical isolated native
harness selected 1.

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
directories mode `0700`. The PostgreSQL password file is read by PostgreSQL,
so use its pinned Alpine image UID `70`, not the gateway UID. The URL file and
provider keys remain owned by `10001`. Pre-create the persistent directories
listed in the [topology custody section](oss-meeting-topology.md#operator-owned-configuration-and-custody)
with their service owners so bind mounts do not become root-owned directories.

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

Omitted selectors default independently to `deepgram-nova-3`; selecting
ElevenLabs for one does not change the other. Invalid profile values fail
Meeting Platform startup. Missing credentials for a selected provider fail
closed, without provider fallback. Mixed profiles require both provider
credentials; configuration support does not qualify mixed-profile acoustics.
Keep Deepgram available while draining historical
`voicetext-batch-v2:deepgram-nova-3` work.

These are native Deepgram and ElevenLabs integrations in the OSS gateway;
Pipecat does not implement either STT path. Deepgram batch uses the v2 contract;
ElevenLabs batch uses v3. Live uses the v2 WebSocket contract with the selected
provider/model identity checked at readiness.

### Implemented profile mapping and qualification status

Historically, root verified independent B0/H0 review and full gates/CI PASS for gateway
`550ec217b3b549d7719aaa4a412d9ecbaf0a2f4b` and Discord
`d934481304ea8791462f59261db11827dfc9eb20` (gateway PR #1, Discord PR #63;
Canary PR #19). These are review/gate results, not Discord campaign acceptance.

Native campaign `8de7b998-a09f-4d9a-9c39-01dc33828eef` on that gateway retained:

| Platform profile / mode | Provider model | Language | WER | CER |
| --- | --- | --- | ---: | ---: |
| `deepgram-nova-3` batch | Deepgram `nova-3` | `multi` | 0.272727 | 0.233227 |
| `deepgram-nova-3` live | Deepgram `nova-3` | `multi` | 0.295455 | 0.230032 |
| `elevenlabs-scribe-v2` batch | ElevenLabs `scribe_v2` | `multi` | 0.204545 | 0.194888 |
| `elevenlabs-scribe-v2-realtime` live | ElevenLabs `scribe_v2_realtime` | `multi` | 0.227273 | 0.198083 |

This is narrow provider-fixture qualification on one 26-second synthetic RU/EN
fixture. All five required terms and timestamps passed. Each live profile had
1,312 contiguous packets accepted, written, and ACKed, with
`finalize_result_observed` and terminal `finalize_flushed`. There was exactly
one native operation per profile. Native thresholds remain WER <= 0.35 and
CER <= 0.25; Discord thresholds remain WER <= 0.35 and CER <= 0.20.
Native results do not establish the stricter Discord gate.

Retained operator evidence (filesystem paths, not public links) under
`/mnt/volume_ams3_1784742570542/vtoss-astra-y-20260905`:

- `artifacts/provider-8de7b998-summary-r1/summary.json`
- `artifacts/provider-8de7b998-retained-r1/manifest.json`

These results do not qualify broad language/acoustic coverage, all mixed
combinations, or other revisions. Recognition remains provider/model-dependent;
`multi` is not a language-coverage guarantee.
Ukrainian may be selected
for presentation of already accepted text, but is not a qualified STT language
and must not be inferred from presentation behavior. The implemented Discord
Pipecat conversation profile is optional, default-off, and non-core. A
Pipecat-to-VoiceText provider adapter is future/unimplemented; it is not part of
this gateway or the core OSS meeting topology.

Real Discord acceptance remains PENDING for a deployment until its trusted receipt
proves all required scenarios. The adapter and gateway contract checks do not establish
private-guild acceptance; that remains pending until the deployment has that receipt. Claim Discord qualification only for profiles and identities
supported by an original trusted campaign receipt; follow the
[receipt lookup and applicability procedure](oss-discord-stt-campaign.md#locate-and-interpret-a-trusted-receipt).

## Validate the configuration

Use Docker Compose 2.24.4 or newer (the overlay uses `!reset null` to remove
inherited optional environment entries), plus the Buildx prerequisites above.
Provision the operator-owned databases, Redis, storage, two official bot
applications, and base secrets following the
[core OSS topology](oss-meeting-topology.md#operator-owned-configuration-and-custody).
Supply your own Deepgram and/or ElevenLabs keys for the selected profiles;
the provider directory is mounted read-only only into the gateway. No private
VoiceText backend is needed. Complete public DNS and TLS prerequisites above;
local ports `18080`/`18443` and an operator CA belong in a separate TEST overlay,
not the normal public-host configuration.

This quickstart uses the default feature-off scope: conversation, grounded
voice, local final reply, and Retrieval V2 are inactive; enable no Compose
profiles. The OSS overlay removes the inherited empty grounded-voice rollout
epoch and unused actor-keyring path. No dummy epoch or keyring is required.
Feature validation is unchanged: enabling grounded voice requires its real
rollout configuration, and Retrieval V2 requires its real actor-key mapping
authority in a subsequent feature-specific overlay.

Copy `infra/deployment/.env.example` to `/secure/oss-meeting.env` outside the
checkout and fill the base storage/database credentials by mounted files as
linked above. Set `DEPLOY_ROOT`, `MEETING_PLATFORM_SOURCE_REVISION` to the clean
checkout's `git rev-parse HEAD`, distinct `DISCORD_CRAIG_APPLICATION_ID` and
`DISCORD_PUBLICATION_APPLICATION_ID`, `DISCORD_RESULTS_CHANNEL_ID`, and
`VOICETEXT_PUBLIC_HOST`. Put the independent batch/live selectors in this env
file; put only provider key-file paths in `config/voicetext-gateway.env`.
For this core quick start select `SUMMARY_PROVIDER=transcript-outline`,
`CONVERSATION_ENABLED=false`, and `VOICETEXT_LIVE_ENABLED=true`. No hosted
subscription credentials are needed for outline summaries. Install both official
applications and configure the active voice/results room route with
`/setup-voice-bot` as described in the topology; a running stack alone does not
admit a room.

From the repository root, with the provisioned `/secure/oss-meeting.env`, render
all three files together before starting anything:

```sh
docker compose --env-file /secure/oss-meeting.env \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.craig.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml config
```

Then start from a clean committed checkout using the provenance-checking wrapper
(set `MEETING_PLATFORM_SOURCE_REVISION` in that env file to this checkout's HEAD):

```sh
node infra/deployment/run-verified-compose.mjs --env-file /secure/oss-meeting.env -- \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.craig.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml up --build --detach --wait
```

The overlay exposes only the batch v2/v3, live v2, and health routes. It does
not run a provider, Discord, admission, or campaign canary. Run any later live
qualification only with test-only provider keys, synthetic audio, an official
test bot, and a private test guild.

The ordinary adapter package test is explicitly providerless. Its fake loopback
gateway uses fabricated transcript text and is contract coverage only.

### Historical provider-canary contract

The invocation below is pinned in the checked-in canary source to historical
gateway `550ec217b3b549d7719aaa4a412d9ecbaf0a2f4b`. It does not apply to the
checked-in `3e0ede3ec9086a45bc026f43191a998f2682fd6e` Compose pin and is not a
universal release requirement. Do not substitute hashes to imply compatibility.
Discord qualification uses the separate
[OSS trusted collection procedure](oss-discord-stt-campaign.md#exact-target-and-configuration);
a current-revision provider-canary invocation requires separately reviewed
compatibility and retained evidence.

The separate opt-in provider canary sends the pinned real-speech Ogg fixture to
one selected batch/live provider pair. Its five required transcript terms are
checked-in constants, not operator inputs. It first verifies a create-only
running gateway identity observation against the pinned commit, independently expected
Git tree, full immutable image digest, origins, run ID, and identity digest. It
retains a create-only identity-bound receipt only after provider-derived batch
and live text, timestamps, ACKs, idempotent replay, and finalization pass. The
complete variable and receipt contracts are documented in
[adapter README](../../packages/voicetext-adapter/README.md#historical-provider-canary-contract).
A historical credentialed invocation has this shape:

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
