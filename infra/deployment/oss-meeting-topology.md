# Pinned OSS meeting topology

This is the one supported clean-checkout Compose workflow for the core
self-hosted lane. It runs Meeting Platform, a user-owned Craig bot with its own
PostgreSQL, Redis, and recording custody, and the OSS VoiceText gateway with its
own PostgreSQL and Caddy TLS edge. It never uses the public hosted Craig bot or
private VoiceText SaaS.

## Immutable sources and identities

`infra/deployment/source-pins.json` is the checked-in authority for each gateway Git URL, exact ref, and revision; these are immutable release constants, never environment settings.
The remote-source overlays pin source three ways: repository URL, exact Git ref
plus BuildKit `checksum`, and the same 40-character commit as image tag and OCI
revision label. Meeting Platform is a local source build: its generator proves a
clean checkout, requires `MEETING_PLATFORM_SOURCE_REVISION` to equal `HEAD`, and
records the exact commit and tree before Compose uses that revision for both the
image tag and OCI image/build label.

| Component | Repository | Exact ref and checksum |
| --- | --- | --- |
| Craig Meeting Gateway (ISC) | `https://github.com/777genius/craig-meeting-gateway.git` | `37b86a958b567cb7fcff75946e94fe5e7ee38f42` |
| OSS VoiceText gateway (Apache-2.0) | `https://github.com/777genius/voicetext-gateway.git` | `a32ea2ad2caa23fd74a9389ea232fd29e21aa4c3` |

The Craig pin implements `craig-lifecycle-v3`; its retained contract manifest
SHA-256 is `43b58c2661b22039fa432199227318b0d91fbbe1faa669bc0e62a68ddff8f940`
and bundle SHA-256 is
`9ecdba8ebe3dd7e5ca4d67be0d540a66d07c3a66e0536dcd9c929099249f72a9`.

Do not replace either remote context with a mutable branch, an unversioned image, a
local source directory, or the public Craig service. BuildKit must be 0.28.0 or
newer so the Git-context checksum is enforced. Set
`MEETING_PLATFORM_SOURCE_REVISION` to the output of `git rev-parse HEAD`; the
generator fails before Compose if it does not identify the clean Discord
checkout being deployed.

Create exactly two official Discord applications owned by the operator:

1. the **Craig application**, whose token is mounted only into `craig-bot` and
   which has the voice permissions required to record;
2. the **publication application**, whose token is mounted only into
   `meeting-platform` and which publishes commands, results, and transcript
   attachments.

Their application IDs and tokens must be different. There is no combined bot
identity and no user token. Install both only in an operator-owned private guild,
grant only the documented channel permissions, use test-only voice/results
channels and synthetic participants for qualification, and never use a public
guild, self-bot, customer recording, or real user project.

Use Meeting Platform's logged `/discord/install` URL for the publication
application. Install Craig separately with its Discord OAuth URL (application
ID `DISCORD_CRAIG_APPLICATION_ID`, permissions `68176896`, scopes `bot` and
`applications.commands`).
Confirm both application IDs in the private guild, then run
`/setup-voice-bot` as a `Manage Server` administrator to select the test-only
voice channel and results channel. Do not widen either application to
Administrator permission.

## Operator-owned configuration and custody

Copy `infra/deployment/.env.example` to `/secure/oss-meeting.env` outside the
checkout. Set `DEPLOY_ROOT`, `MEETING_PLATFORM_SOURCE_REVISION` (the output of
`git rev-parse HEAD` in this clean checkout), the two distinct application IDs,
the private results channel ID, `VOICETEXT_PUBLIC_HOST`, and the selected batch
and live profiles. The Craig and VoiceText source pins are deliberately not
environment overrides.

Create these persistent roots under the one operator-owned `DEPLOY_ROOT`:

```text
data/postgres                  Meeting Platform state (authoritative)
data/redis                     Meeting Platform durable work queue
data/object-storage            derived accepted artifacts
data/spool                     Meeting Platform durable ingress spool
data/craig/postgres            Craig metadata
data/craig/redis               Craig durable runtime state
data/craig/recordings          original multitrack recordings (authoritative)
data/voicetext/postgres        VoiceText job state
data/voicetext/spool           accepted VoiceText audio spool
data/voicetext/caddy-config    Caddy configuration state
data/voicetext/caddy-data      TLS/ACME state
```

Provision the base Platform files documented in [README.md](README.md),
including `postgres-password`, `redis.conf`, `s3-config.json`, and these files
under `${DEPLOY_ROOT}/secrets/platform`: `postgres-url`, `redis-url`,
`s3-access-key-id`, `s3-secret-access-key`, `discord-sut-token` (publication
bot), `craig-bearer-token`, and `voicetext-service-token`. Then add:

```text
secrets/craig/postgres-password
secrets/craig/database-url
secrets/craig/discord-bot-token
secrets/voicetext/postgres-password
secrets/voicetext/postgres-url
secrets/voicetext/providers/deepgram-api-key       # when a Deepgram profile is selected
secrets/voicetext/providers/elevenlabs-api-key    # when an ElevenLabs profile is selected
config/voicetext-gateway.env
```

`craig/database-url` is
`postgresql://craig_meeting:<url-escaped-password>@craig-postgres:5432/craig_meeting`.
The VoiceText equivalent uses host `voicetext-postgres`, user/database
`voicetext`, and its own password. `voicetext-gateway.env` contains only the
selected provider key-file paths under `/run/voicetext-provider-secrets`; key
values never enter an env file.

All credentials are user-owned. Generate independent random PostgreSQL/Redis/S3
credentials and at least 32 random bytes for each machine bearer. Secret files
must be regular, non-symlink files, mode `0400`, owned by the container UID that
reads them. Craig bot and VoiceText gateway/config files use UID/GID `10001`;
the two PostgreSQL password files use the image's PostgreSQL UID (`70` for the
pinned Alpine image). Follow the base README for Platform Redis and SeaweedFS
ownership. The same
`platform/craig-bearer-token` file is mounted read-only into Platform and Craig,
and the same `platform/voicetext-service-token` file into Platform and VoiceText.
The two Discord token files remain separate.

## One config, up, and wait command

From the repository root of a clean Discord checkout, after DNS for
`VOICETEXT_PUBLIC_HOST` points to this host and TCP 80/443 plus UDP 443 are
available, run this one exact command:

```sh
node infra/deployment/run-verified-compose.mjs --env-file /secure/oss-meeting.env -- -f infra/deployment/compose.yaml -f infra/deployment/compose.craig.yaml -f infra/deployment/compose.voicetext-gateway.yaml up --build --detach --wait
```

The verified wrapper creates a Docker context from exactly the files in the committed Git tree, adds only `.build/meeting-platform-build-provenance.json`, removes identity and Compose-control variables inherited from its process, and compares the rendered Compose source revision, source tree, local context, remote source pins, and application identities before any build. It fails if the checkout is dirty, the configured Meeting
Platform revision differs from `HEAD`, either official application ID is
missing, or the Craig and publication IDs are equal. It atomically replaces its read-only
`0444` output, so the checkout owner can repeat the exact command for deploy,
restart, or upgrade without elevated privileges. The generated context cannot contain ignored or untracked files, including `.env` variants. Compose config then fails
before creation on an incomplete interpolation. The final step builds only the
pinned remote sources, starts migrations and dependencies, and waits for service
health without invoking Discord commands, joining voice, or calling a speech
provider. Do not enable any Compose profile for this workflow.
The former `node tooling/generate-build-provenance.mjs >/dev/null && docker compose`
sequence is obsolete because it neither cross-checked the deployment environment
nor safely replaced its existing `0444` output.
In particular, Infinity Context, subscription-runtime/`hosted-summary`, the
Pipecat `conversation` profile, `local-stt`, the E2E campaign/controller, and
recording playback remain excluded.

After startup, inspect health and prove every container has restart count zero:

```sh
docker compose --env-file /secure/oss-meeting.env -f infra/deployment/compose.yaml -f infra/deployment/compose.craig.yaml -f infra/deployment/compose.voicetext-gateway.yaml ps
docker inspect --format '{{.Name}} restart={{.RestartCount}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}' $(docker compose --env-file /secure/oss-meeting.env -f infra/deployment/compose.yaml -f infra/deployment/compose.craig.yaml -f infra/deployment/compose.voicetext-gateway.yaml ps --quiet)
```

Every long-running service must be `healthy` (or have its documented one-shot
status) and every `restart=` value must be `0` before private-guild setup.

## Default output and optional features

The default `SUMMARY_PROVIDER=transcript-outline` is deliberately minimal: it
reports the authoritative transcript turn count and attaches the transcript. It
does not generate an overview, topics, decisions, actions, owners, deadlines, or
open questions. Rich generation is optional and hosted separately; it is not a
claim of this self-hosted default.

The repository contains an implemented Discord Pipecat conversation profile,
but that profile is default-off and non-core. There is no implemented
Pipecat-to-VoiceText provider adapter; that adapter remains future work. The OSS
topology uses VoiceText only for final batch transcription (and optional derived
live captions when explicitly enabled), never as a Pipecat provider.

Craig's original multitrack files, the final accepted transcript, and Meeting
Platform PostgreSQL are authoritative. Redis, live captions, outlines,
generated summaries, VoiceText spool entries, and object-store renditions are
derived or operational state. A transcription or publication failure must never
delete the original Craig recording.

## Stop, backup, restore, and teardown

For a consistent backup, stop the project, snapshot/copy every data root above
and the external secret/config files, then restart with the same command. Back
up `data/craig/recordings`, `data/craig/postgres`, and `data/postgres` first and
retain the inspected OCI image revision labels and generated Meeting Platform
provenance file with the backup. A label alone is not proof of source identity;
verify it against `.build/meeting-platform-build-provenance.json`. Test restores
into a new private deployment before relying on them.

To tear down containers and networks while retaining all bind-mounted evidence:

```sh
docker compose --env-file /secure/oss-meeting.env -f infra/deployment/compose.yaml -f infra/deployment/compose.craig.yaml -f infra/deployment/compose.voicetext-gateway.yaml down
```

Do not add `--volumes` and do not delete `DEPLOY_ROOT`. Erasing an original
recording, database, TLS state, or secret is a separate destructive retention
operation, never normal teardown.
