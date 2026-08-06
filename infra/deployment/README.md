# Isolated host deployment

This Compose project is isolated under one explicit `DEPLOY_ROOT`, uses unique
networks and service names, publishes no host ports, and never mounts another
project's mutable runtime directory. Craig joins `discord-meeting-internal` and
posts authenticated ingress traffic to `http://meeting-platform:4310`.

Meeting Platform is deliberately locked to one replica and
`LIVE_INGRESS_OWNER_MODE=singleton`. Do not scale this service horizontally
until record-ID routing, durable leases with fencing tokens, distributed
projection locks, and takeover/recovery tests are implemented. Stateless HTTP
endpoints may later be split into an independently scalable deployment.

All files below `${DEPLOY_ROOT}/secrets` and the copied subscription auth slot
must be regular, non-symlink files with mode `0400`, owned by the UID that reads
them. Platform and subscription-runtime files and their mounted directories use
UID `10001`; `redis.conf` uses UID `999`; `s3-config.json` uses UID `1000`.
Root-owned bootstrap files are limited to services whose entrypoints read them
before dropping privileges. Persistent service data stays on the large host
volume rather than the root filesystem.

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

Set `DISCORD_APPLICATION_ID` and `DISCORD_CRAIG_APPLICATION_ID` to the official
application identities. They are intentionally equal in the current one-install
deployment while the code and process boundaries remain separate. Give them
different values only for an explicit two-install deployment. `DISCORD_LEGACY_GUILD_ID` and
`DISCORD_LEGACY_VOICE_CHANNEL_ID` are a temporary pair-scoped compatibility
route for the existing private E2E guild; omit both in a new self-service
deployment. After Discord login, Meeting Platform fails closed if its configured
application ID does not match the bot token.

The application log includes the direct official Discord install URL, which can
be linked from any product page without exposing Meeting Platform's private HTTP
listener. If a reverse proxy is added, expose only `/discord/install` and, for a
distinct Craig identity, `/discord/install/craig`; do not publish the Craig
ingress listener itself. Craig reaches the authenticated
`GET /v1/craig/configuration` snapshot only on the internal network using the
existing Craig bearer; do not expose that route publicly.

## Live conversation profile

Live conversation is disabled by default. To enable the provider-neutral path,
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
