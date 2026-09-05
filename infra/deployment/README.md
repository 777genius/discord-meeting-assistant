# Isolated host deployment

This Compose stack is isolated under one explicit `DEPLOY_ROOT`. Its non-external
networks use Compose-generated, project-scoped names, its service discovery is
limited to those networks, and it never mounts another project's mutable runtime
directory. Use a distinct Compose project name and `DEPLOY_ROOT` for every stack.
Craig joins the project-scoped `meeting-internal` network and posts authenticated
ingress traffic to `http://meeting-platform:4310`.

Meeting Platform is deliberately locked to one replica and
`LIVE_INGRESS_OWNER_MODE=singleton`. Do not scale this service horizontally
until record-ID routing, durable leases with fencing tokens, distributed
projection locks, and takeover/recovery tests are implemented. Stateless HTTP
endpoints may later be split into an independently scalable deployment.

All files below `${DEPLOY_ROOT}/secrets` and the copied subscription auth pool
must be regular, non-symlink files with mode `0400`, owned by the UID that reads
them. Platform and subscription-runtime files and their mounted directories use
UID `10001`; `redis.conf` uses UID `999`; `s3-config.json` uses UID `1000`.
Root-owned bootstrap files are limited to services whose entrypoints read them
before dropping privileges. Persistent service data stays on the large host
volume rather than the root filesystem.

The sidecar pool manifest is `${DEPLOY_ROOT}/runtime/auth-pool/pool.json`.
It contains only sequential opaque slots (`slot-1` through `slot-8`) and paths
inside one immutable opaque generation. Swapping `pool.json` publishes a whole
generation atomically, so a running sidecar never imports a different account
into an existing slot. Account names and the host inventory path stay outside
Compose and the application. Reserved accounts must be removed from every
other project's candidate manifest before the new sidecar starts.

The audited launcher modules ship inside the immutable sidecar image.
`${DEPLOY_ROOT}/runtime/installation` supplies only the exact pinned
`@vioxen/subscription-runtime` package tree. Do not copy launcher modules into
that persistent directory: keeping policy code in the image prevents a fresh
application release from silently reusing an older admission policy.
Roll back across this ownership cutover by restoring the previous Compose file,
full-installation mount, launcher path, image, and digest together before
starting the old sidecar. An old image cannot use the new `node_modules`-only
mount because it does not contain the image-owned launcher.

PostgreSQL migrations are owned by the one-shot `postgres-migrations` service,
not by PostgreSQL init hooks. It acquires an advisory lock, applies every
version atomically with its exact SHA-256 ledger receipt, and rejects a gap or
checksum drift. `meeting-platform` cannot start until that service exits
successfully.

For an existing deployment use a stop-first rollout: stop Meeting Platform,
deploy the new immutable image, run `postgres-migrations` to completion, then
start Meeting Platform. Do not run an older binary concurrently with migration
`0005_live_meeting_append_only.sql` or later: after backfill the schema rejects
the legacy embedded arrays, so an old binary cannot silently restore them.
Horizontal live ingress remains prohibited independently of this migration
fence.

`DISCORD_PUBLICATION_MODE=message` is the default Discord container: publications
are direct SUT-authored messages in the configured results channel. Set
`DISCORD_PUBLICATION_MODE=thread` only to retain the opt-in thread presentation;
the thread title is human-facing and never includes the internal idempotency
digest. `DISCORD_FINAL_PUBLICATION_MODE=separate-message` keeps the live draft and
publishes one separate idempotent final summary by default. Set it to
`replace-live` only for the previous single-message behavior.

Local Final Reply is independently disabled by default. To enable it, keep
`DISCORD_PUBLICATION_MODE=message`, enable the Discord Message Content intent for
the official bot application, write an independently generated 32-byte base64 or
64-character lowercase-hex key to
`${DEPLOY_ROOT}/secrets/platform/meeting-knowledge-principal-key` with mode
`0400`, and set `MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED=true`. The key
encrypts short-lived authorization principals and derives non-reversible dedupe
subjects; it is not a provider or Discord credential.

Migration 0032 is a stop-only boundary for older Local Final Reply binaries. It
monotonically activates question policy epoch 3 before enabling protocol-2
retrieval bindings; PostgreSQL then rejects epoch-2 admission and rejects an
old worker lease for a bound job in either `running` or `ready`. Rollback uses
the binding-aware epoch-3 release with locator admission still at zero or under
a new named cutover epoch. Do not code-revert to an epoch-2 image after this
migration.

Retrieval V2 answer serving is unavailable in the default deployment:
`infinityRolloutBasisPoints` is `0` and no production V2 provider binding is
composed. Do not add a binding or raise rollout until the exact release/profile
qualification manifest contains three real production-model repetitions and
accepted human receipts. Shadow retrieval must never reach the answer
publication state machine. Retraction and scoped deletion continue while
search and answer serving are disabled.

A V2-selected protocol-2 job persists its complete locator request, including
capability/profile/service/lane/ranking pins, opaque room and source-generation
scope, queries, filters/preferences, and retrieval/evidence/time bounds.
Restarted workers use that JSON binding verbatim. Capability, profile, lane,
policy, source, permission, or authoritative transcript drift fails closed; do
not repair a queued job by editing its binding or changing environment values.

The old downstream generic selector is migration-only
(`legacyRetrievalMigration.enabled`) and is scheduled for deletion no earlier
than 2026-10-31, after ADR-0049's full V1 drain and rollback gates pass.

## VoiceText provider profiles

No private VoiceText URL is a deployment default. To use the separately
versioned OSS gateway without changing Meeting Platform, add the
[self-hosted gateway overlay](voicetext-gateway.md). Meeting Platform still
uses only one VoiceText-compatible URL and machine bearer token; provider keys
stay in the gateway.

The clean-checkout ownership, bot, storage, TLS, secret, optional-service, and
single smoke workflow is in the [OSS meeting topology](oss-meeting-topology.md).

VoiceText batch and live recognition are selected independently in Compose:

```text
VOICETEXT_BATCH_PROFILE=deepgram-nova-3
VOICETEXT_LIVE_PROFILE=deepgram-nova-3
# VoiceText-history example only:
TRANSCRIPTION_LEGACY_EXECUTION_BINDING=voicetext-batch-v2:deepgram-nova-3
```

Batch also permits `elevenlabs-scribe-v2`; live also permits
`elevenlabs-scribe-v2-realtime`. Every mixed combination is supported. Invalid
values fail Meeting Platform startup, and omitted selectors default
independently to Deepgram. The Deepgram batch choice preserves contract v2 and
its existing idempotency identity; ElevenLabs batch uses strict contract v3.
The legacy binding has no default: it is explicit historical provenance for
recoverable rows created before durable binding existed. Binding-aware work
uses the isolated V2 post-call queue so a rolling V1 worker cannot claim it.
Set `TRANSCRIPTION_LEGACY_EXECUTION_BINDING=speaches-v1` for Speaches history;
use the frozen Deepgram value shown above only for VoiceText history. Do not
change the top-level transcription backend in the same migration.
Live always keeps raw Discord Opus at mono 48 kHz and requires the selected
provider/model in VoiceText `ready` before any audio. Neither selector exposes
provider credentials, endpoints, SDKs, or probes to Discord. The final batch
transcript from Craig's authoritative per-speaker Ogg tracks remains the only
final evidence used by summary, memory, or RAG; live text stays derived.

Recognition languages are provider- and model-dependent. The four selectable
profiles have deterministic routing and contract coverage. No retained campaign
in this public repository qualifies English, Russian, or provider acoustic
quality on the current exact Meeting Platform and VoiceText revisions. Any
historical/private EN/RU evidence applies only to the revisions named by its
receipt and is not transferable. Qualification remains closed until a retained
exact-revision campaign passes with both user-owned official test bots in a
private test guild.

Rollback is a profile change on the binding-aware release: set both selectors
back to Deepgram and redeploy the same source revision. Do not code-revert to a
pre-binding image after migration 0027. Schema readiness intentionally rejects
that image, while V2-bound rows remain durable and hidden from V1 recovery.
Deploying an older image is therefore a stop-only boundary, not a supported
rollback path.

## Infinity Context historical memory

The standard Compose deployment leaves Infinity Context disabled. Add
`compose.infinity-context.yaml` to enable the production path; that overlay
fails before container creation unless `INFINITY_CONTEXT_URL` and the full
reviewed `INFINITY_CONTEXT_ACTIVATION` JSON are present. Provision Infinity
Context separately at the qualified service revision and embedding profile; it
is not bundled into this Compose project. Its URL must be an HTTP(S) service
root reachable from the project-scoped `meeting-egress` network and must not contain
credentials, a query, or a fragment. Do not use `localhost`: inside Meeting
Platform that refers to the Platform container.

Place the provider-issued bearer token in
`${DEPLOY_ROOT}/secrets/platform/infinity-context-token`. Generate an independent
topology HMAC key and store it in
`${DEPLOY_ROOT}/secrets/platform/infinity-context-topology-key`, for example with
`openssl rand -base64 48`. Both must be regular, non-symlink files owned by UID
`10001` with mode `0400`; never put either value in `.env`, Compose, logs, or the
Infinity service. Keep the topology key stable across rollouts because rotating
it changes the opaque remote identities and requires an explicit migration.

Before a local source build, use the verified wrapper; direct Compose builds are unsupported because local contexts exist only for the lifetime of this command:

```sh
node infra/deployment/run-verified-compose.mjs --env-file <deployment.env> -- -f infra/deployment/compose.yaml build
```

The wrapper renders and verifies Compose before building. Its context is a `git archive` of `HEAD` plus only the exact generated `.build/meeting-platform-build-provenance.json`; ignored and untracked files never reach the Docker daemon.

Set these non-secret values in the deployment environment file:

```text
INFINITY_CONTEXT_URL=https://infinity-context.example.internal
INFINITY_CONTEXT_REQUEST_TIMEOUT_MS=10000
INFINITY_CONTEXT_OPERATION_TIMEOUT_MS=300000
INFINITY_CONTEXT_ACTIVATION={"apiVersion":"v1","archiveSha256":"4d96f50ae01f9000e9ac4c50eaa61b4d875c3a452aed58f7e2efe1d69ee8d08d","embeddingProfileAttestation":{"embeddingProfile":"tei-sentence-transformers-paraphrase-multilingual-minilm-l12-v2-384d-dense.v1","embeddingProfileDigestSha256":"sha256:b183b9d6350dfaf9f874cab9fef993d3ded5060a4a18d972c45ec97def5faf31","schemaVersion":1},"environment":"production","immutablePackageIntegrity":"sha512-YurXjgFGoRxwc5zJghj69ZFyZx8WLS1ucvgVvV2EFjZMCATxr9YrJW1ueeyLqwkaLKnO1JEvbTpqn7Q8K33b+A==","indexingEnabled":true,"packageSource":"immutable_package","qualificationManifestSha256":"sha256:2ba18c3e7b2297e6103fd0d285bb2db424f0d3ac5ea407b857422e3204925133","schemaVersion":1,"sdkCommit":"b77b490cebbf9d80d4204425df3d795b4866ea19","sdkTree":"ac25c12c4733953bf7a4882d5c2c4476589455f2","searchEnabled":true,"serviceName":"infinity-context","servingProfile":"same_room_retrieval"}
```

Treat that activation as a reviewed release attestation, not an operator-tuned
feature flag. Update it only together with retained qualification evidence and
the pinned SDK provenance in the application release. The deployment generator
derives the commit and canonical tree SHA-256 from a clean checkout and embeds
the generated operator-owned, read-only provenance artifact. A matching revision
environment value is required but cannot replace that Git-derived identity.
Replace the all-`a` digest above with the exact digest echoed
by that deployment instance. The digest detects instance drift; semantic
compatibility comes only from the source-pinned service/profile pair and the
locally verified tokenizer conformance receipt.

Two-hour historical retrieval has no operator boolean. It remains unavailable
until the release retains an accepted evidence digest, exact release revision,
and rollout epoch proving focused retrieval, exhaustive coverage, and final-answer
quality. General Infinity search does not enable it. Indexing, reconciliation,
and deletion continue while either serving gate is closed. The request timeout must
be from 100 through 60000 ms; the operation timeout must be from 1000 through
600000 ms and must not be shorter than the request timeout.

Before the stop-first rollout, validate interpolation with `docker compose
--env-file <deployment.env> -f infra/deployment/compose.yaml config`. Then verify
DNS, TLS, routing, and bearer authentication from a disposable container on the
the project-scoped `meeting-egress` network. The service capability response must identify
`infinity-context`, API `v1`, Qdrant support, the required adapters,
`service_revision=b77b490cebbf9d80d4204425df3d795b4866ea19`, and these
activation-bound semantic fields:
`embedding_profile_id=tei-sentence-transformers-paraphrase-multilingual-minilm-l12-v2-384d-dense.v1`
and
the exact activation-injected `embedding_profile_digest_sha256` instance echo.
Meeting Platform still starts when the endpoint is unreachable or a capability
differs so recording and authoritative publication remain available. Historical
indexing and search are soft-disabled, a warning is emitted, and deletion and
reconciliation continue. The platform repeats qualification and never falls back
to an unqualified provider. Older capability endpoints that omit any required
runtime provenance fields are incompatible and fail historical serving closed.

## Redis queue durability

Copy `redis.conf.example` to `${DEPLOY_ROOT}/secrets/redis.conf`, replace the
password with a generated secret, and keep that deployed file mode `0400` and
owned by UID `999`. The matching platform `redis-url` secret must use the same
password.

`appendonly yes`, `appendfsync everysec` (or `always`), and
`maxmemory-policy noeviction` are mandatory. `noeviction` deliberately rejects
new queue writes under pressure rather than dropping BullMQ state. Meeting
Platform continuously checks these runtime settings; an invalid policy makes
the queue readiness probe fail closed.

Create two official applications. Set `DISCORD_PUBLICATION_APPLICATION_ID` to
the publication bot identity and `DISCORD_CRAIG_APPLICATION_ID` to the separate
user-owned Craig identity; the values and bot-token files must differ. The
publication application never records voice, and Craig never publishes Meeting
Platform results. `DISCORD_LEGACY_GUILD_ID` and
`DISCORD_LEGACY_VOICE_CHANNEL_ID` are a temporary pair-scoped compatibility
route for the existing private E2E guild; omit both in a new self-service
deployment. After Discord login, Meeting Platform fails closed if its configured
application ID does not match the bot token.

The application log includes the direct official Discord install URL, which can
be linked from any product page without exposing Meeting Platform's private HTTP
listener. If recording playback is disabled, expose only `/discord/install` and,
for a distinct Craig identity, `/discord/install/craig`. When playback is
enabled, the proxy may additionally expose `/recordings/`; preserve `Range`,
`Content-Range`, `Accept-Ranges`, `Cookie` and `Set-Cookie` headers. Never expose
`/v1/`, `/metrics`, `/readyz`, or the Craig ingress listener. Craig reaches the authenticated
`GET /v1/craig/configuration` snapshot only on the internal network using the
existing Craig bearer; do not expose that route publicly.

## Recording playback

Create a random signing secret with at least 32 bytes, store it as a regular
mode `0400` file under `${DEPLOY_ROOT}/secrets/platform`, and configure both:

```text
RECORDING_PLAYBACK_PUBLIC_BASE_URL=https://recordings.example.com
RECORDING_PLAYBACK_SIGNING_SECRET_FILE=/run/secrets/recording-playback-signing-secret
```

The public URL must be an HTTPS origin without a path. The secret part of each
Discord link stays in the URL fragment and is exchanged for a scoped HttpOnly
cookie, so reverse-proxy access logs do not receive it. The object-storage
bucket remains private. Rotating the signing secret revokes existing links.

The page presents one synchronized player over the authoritative speaker
tracks. Audio is delivered with byte ranges, so seeking and long meetings do not
depend on Discord file limits or require downloading the complete recording.

When the host HTTPS proxy belongs to another Compose project, start the narrow
recording edge with `compose.recording-edge.yaml`. Set `PUBLIC_EDGE_NETWORK` to
the proxy's Docker network and set `MEETING_INTERNAL_NETWORK` to the exact
Compose-generated network name reported for the Meeting Platform project. These
two networks are explicitly external to the edge project: this overlay is a
narrow, operator-authorized bridge, not project-isolated networking. The edge
forwards only `/recordings/*`; every other path returns `404`. Point the host
HTTPS virtual host at `recording-edge:8080` and keep TLS termination there.

## Live conversation profile

Live conversation is disabled by default and is non-core. The repository has an
implemented Discord Pipecat conversation profile, but no Pipecat-to-VoiceText
provider adapter; that adapter remains future/unimplemented. To enable the
existing provider-neutral conversation path,
create `${DEPLOY_ROOT}/secrets/platform/conversation-runtime-token`, create an
empty `${DEPLOY_ROOT}/secrets/pipecat` directory owned by UID `10001`, and start
this Compose project with `--profile conversation` plus
`CONVERSATION_ENABLED=true`. Platform and Pipecat authenticate with the shared
token; it must be a regular non-symlink file with mode `0400`.

In the Craig deployment, set `MEETING_PLAYBACK_ENABLED=true` and point
`MEETING_PLAYBACK_URL` at this Platform's internal
`/v1/craig/playback` WebSocket. Craig authenticates with its existing Meeting
Platform integration bearer. Playback remains disabled when conversation is
disabled.

The default production profile is `elevenlabs-multilingual`. Pipecat sends the
recognized turn to the internal Subscription Runtime sidecar, which uses the
same fast `gpt-5.6-luna` policy as incremental summaries, and streams the
answer through ElevenLabs. The sidecar keeps its Codex app-server worker warm
and prewarms a clean thread; every conversation turn still receives a new
stateless thread.

For ElevenLabs, add `${DEPLOY_ROOT}/secrets/pipecat/elevenlabs-api-key` and set:

```text
PIPECAT_RUNTIME_PROFILE=elevenlabs-multilingual
CONVERSATION_VOICE_PROFILE_ID=elevenlabs-multilingual
PIPECAT_RUNTIME_ELEVENLABS_MODEL=eleven_flash_v2_5
PIPECAT_RUNTIME_ELEVENLABS_VOICE_ID=<ElevenLabs voice id>
PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_ADDRESS=subscription-runtime-sidecar:50052
PIPECAT_RUNTIME_SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE=/run/platform-secrets/runtime-service-token
```

The compose wiring passes that same voice ID to Meeting Platform. Startup fails
closed if the pre-generated thinking-cue manifest was recorded for a different
voice; regenerate the cue assets and update their manifest when changing it.

No application or contract change is required. The sidecar fails closed when
the key, voice ID, Subscription Runtime token, or internal address is missing.
The multilingual model handles Russian and English directly and can accept
additional locale hints without adding a new application profile. The
deterministic profile remains limited to local and CI E2E and is rejected by
both production compositions.

## Immutable remote source constants

The authoritative Craig and VoiceText gateway Git URL, full ref, and revision are
checked in at `infra/deployment/source-pins.json`. Their Compose remote contexts
repeat the same revision as `ref`, BuildKit `checksum`, image tag, and OCI
revision label. These pins are release constants, not deployment-environment
settings; the verified Compose wrapper rejects any rendered mismatch.

With `compose.hosted-summary.yaml`, Meeting Platform waits for the subscription
runtime sidecar's authenticated gRPC `CheckHealth` response to report `SERVING`.
The probe reads the mounted service-token file and never sends its value through
Compose or process arguments.
