# Isolated host deployment

This Compose project is isolated under one explicit `DEPLOY_ROOT`, uses unique
networks and service names, publishes no host ports, and never mounts another
project's mutable runtime directory. Craig joins `discord-meeting-internal` and
posts authenticated ingress traffic to `http://meeting-platform:4310`.

All files below `${DEPLOY_ROOT}/secrets` and the copied subscription auth slot
must be regular, non-symlink files with mode `0400`, owned by the UID that reads
them. Platform and subscription-runtime files and their mounted directories use
UID `10001`; `redis.conf` uses UID `999`; `s3-config.json` uses UID `1000`.
Root-owned bootstrap files are limited to services whose entrypoints read them
before dropping privileges. Persistent service data stays on the large host
volume rather than the root filesystem.

For an existing isolated deployment, apply every newly added idempotent SQL
migration before restarting Meeting Platform. Fresh PostgreSQL volumes execute
the mounted migrations automatically. Migration `0002_create_post_call_outbox.sql`
must be present before deploying the crash-safe post-call dispatcher. Migration
`0003_create_live_meetings.sql` must be applied before enabling the derived live
transcript and incremental-summary projection. Migration
`0004_create_guild_installations.sql` must be applied before enabling
self-service guild setup and per-guild publication routing.

`DISCORD_PUBLICATION_MODE=message` is the default: each meeting owns one mutable
SUT-authored message directly in the configured results channel. Set
`DISCORD_PUBLICATION_MODE=thread` only to retain the opt-in thread presentation;
the thread title is human-facing and never includes the internal idempotency
digest.

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
