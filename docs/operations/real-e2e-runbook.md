# Real Discord E2E and isolated hosting

## Fixed test assets

These assets are test-only and must never be reused for real meetings or other
projects.

| Asset | Discord ID |
| --- | --- |
| Guild `Meeting Assistant E2E` | `1533228590643155034` |
| Voice channel `e2e-meeting` | `1533228823045214398` |
| Results channel `e2e-results` | `1533228891827736657` |
| Application `Meeting E2E SUT` | `1533224474609057793` |
| Application `Meeting E2E Speaker A` | `1533227577286852649` |
| Application `Meeting E2E Speaker B` | `1533228054724346087` |

Bot tokens are stored only in the local macOS Keychain service
`discord-voice-bot-e2e`, under accounts `sut`, `speaker-a`, and `speaker-b`.
They must not be copied into repository files, process arguments, logs, images,
or committed environment files.

## Hosting boundary

The deployment target is reached with:

```text
ssh codex-workers-eu-01
```

Before any deployment, inspect the host read-only and choose a new dedicated
directory, Compose project name, network, volumes, database role/database,
Redis namespace, ports, service account, and log path. Never open, run, restart,
or modify runtimes belonging to another project. The deployment must be
removable without addressing any shared project resource.

Secrets must be provisioned through the host's existing secret mechanism or a
new permission-restricted deployment environment file outside the checkout.
Never print them during provisioning or health checks.

Production transcription uses the Voicetext machine boundary and batch-v2 final
contract from ADR 0008. Rotate the `meeting-platform` machine identity with the
Voicetext CLI and route its one-time stdout directly into the host secret file;
never put the bearer in argv, an environment variable, shell history, or this
repository. The isolated deployment expects:

```text
secrets/platform/voicetext-service-token  10001:10001 0400
```

The Meeting Platform image runs as UID/GID `10001:10001`; bind-mounted secret
files must be readable only by that service identity. `root:root 0400` is not a
valid deployment state because the non-root container cannot read it.

Before a Discord campaign, a canary must prove authenticated batch submission,
poll/re-submit recovery under one idempotency key, immutable final utterances,
and exact speaker timeline mapping against the same Voicetext endpoint. A
transport success is insufficient: verify the canary transcript against its
pinned required terms and WER/CER thresholds. The derived live WebSocket canary
separately proves `ready`, immutable finalized segments, and
`finalize_complete`. The local Speaches container is available only through the
`local-stt` Compose profile and is not part of the production campaign.

## Required proof

Local deterministic and disposable-container tests are the default gate. A real
Discord run is a separate external gate and must exercise at least:

1. sequential Russian speech with English technical terms;
2. overlapping Speaker A and Speaker B speech;
3. actor disconnect and reconnect;
4. repeated post-call processing and publishing;
5. a second independent meeting to prove state isolation.

Each run must retain non-secret evidence: meeting and recording IDs, stage
transitions, audio duration, speaker IDs, transcript WER/CER and terminology
checks, overlap assertions, evidence-reference validation, and the final Discord
container/message IDs. Retained evidence schema v3 records whether the visible
projection is a direct parent-channel message or a thread message. It continues
to read historical v2 thread evidence and also records the exact Craig and
Meeting Platform container IDs/start times, immutable image IDs, optional
repository digests, image-bound source revisions, and Compose config hashes. The
acceptance result is invalid if any decision or action item references a missing
transcript turn, if a retry creates a duplicate meeting, summary, container, or
message, or if deployment provenance changes during collection or between
campaign runs.

The live slice adds a separate timing and mutation proof. For a call longer than
five minutes, retain timestamps for the first audio packet, first finalized
transcript turn, first Discord publication, every incremental-summary generation,
the meeting end, and the final authoritative replacement. The gate requires:

1. the first Discord publication within two seconds of the first recognized
   non-empty caption unless the external provider is unavailable;
2. one stable Discord container/message identity across captions, preliminary
   summaries, retries, and the authoritative post-call summary. The default
   container is the results channel itself; thread mode is explicit opt-in;
3. captions grouped by the real Discord speaker, with visible relative start
   times, while mutable partials never appear in summary evidence;
4. no preliminary summary before five minutes and the first successful summary
   generation by `05:30` unless Luna is unavailable;
5. Luna telemetry for every successful generation records measured or explicit
   unavailable states for input, cached input, cache-write input, output,
   reasoning output, and total tokens, plus model, run ID, price card, and an
   exact or bounded API-equivalent USD estimate;
6. a live-finalization fence before the durable post-call dispatcher can replace
   the same message, so a late live edit cannot overwrite the authoritative result.

Record provider, Luna, and Discord latencies independently. Do not report the
five-second projection tick as STT or model latency. The API-equivalent cost is
an observability estimate only; the subscription runtime does not create an API
invoice.

### Live Discord mutation trace

Start the observer immediately before the private five-minute call. It uses the
SUT token from macOS Keychain by default, or from an isolated host secret
directory when `DISCORD_E2E_LIVE_SECRET_DIRECTORY` is supplied. It scans both
SUT-authored parent-channel messages and public active/archived thread messages
under the dedicated results channel. It retains only messages created during this
bounded observation and writes a v2 trace only when a visible projection changes.

```sh
DISCORD_E2E_LIVE_RUN_ID=campaign-2026-08-02-live-1 \
DISCORD_E2E_LIVE_RESULT_CHANNEL_ID=1533228891827736657 \
DISCORD_E2E_LIVE_SUT_APPLICATION_ID=1533224474609057793 \
DISCORD_E2E_LIVE_DURATION_MS=600000 \
DISCORD_E2E_LIVE_POLL_INTERVAL_MS=2000 \
DISCORD_E2E_LIVE_OUTPUT=/absolute/evidence/live-discord.trace.v1.json \
pnpm --filter @discord-meeting/discord-e2e-actors observe:live
```

On the host, add only `DISCORD_E2E_LIVE_SECRET_DIRECTORY=/run/secrets/discord-e2e`
or its isolated equivalent. The trace is a create-only, atomic `0600` file; an
existing output path, non-text results channel, invalid configuration, wrong SUT
identity, or no observed projection fails the run without replacing evidence.

Before building each local deployment image, obtain the source revision from its
authoritative checkout. Pass that 40- or 64-character lowercase hex revision as
`SOURCE_REVISION` and bind it into the image, not only the mutable tag:

```dockerfile
ARG SOURCE_REVISION
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
```

Meeting Platform receives this through `MEETING_PLATFORM_SOURCE_REVISION` in
the deployment environment. Apply the same `SOURCE_REVISION` label to the
isolated Craig gateway image in its own deployment Dockerfile. A copied host
source tree does not need `.git`; the revision is captured before copying and is
made immutable by the built image ID plus OCI label. Verify both labels with
`docker image inspect` before the first call. Do not restart or redeploy Craig or
Meeting Platform between actor start and retained evidence collection.

Use the versioned Russian/English ground truth at
`apps/discord-e2e-actors/test/fixtures/manifest.v1.json`. Generate its audio with
the actor package `fixtures:generate` script. The committed manifest pins the
resulting Ogg SHA-256 and duration; actor startup fails on any mismatch.

Choose a unique `DISCORD_E2E_RUN_ID` and actor evidence path before each call.
Do not guess Craig's future random recording ID. Actor evidence uses absolute
wall-clock timestamps. After Craig finalizes, pass the explicit recording ID and
actor file to `collect:e2e`. The collector fail-closed binds them using the
authoritative manifest `startedAt`/`endedAt`, speaker tracks, checksums and timing.

The collector obtains both Postgres observations, S3 bytes, Discord marker counts
and visible embed text, the completed-job replay, and deployment provenance
directly from Docker. It accepts hidden v3 embed markers and legacy thread
markers during rollout. A direct-message receipt must retain exactly one matching
message and zero matching threads; a thread receipt must retain exactly one of
each. Manually authored identity counts or provenance are not accepted evidence.
Retain its non-secret JSON output and the verifier
result. Run the campaign verifier with the standard pnpm separator:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors run verify:campaign -- \
  apps/discord-e2e-actors/test/fixtures/manifest.v1.json \
  /absolute/evidence/sequential.evidence.v3.json \
  /absolute/evidence/overlap.evidence.v3.json \
  /absolute/evidence/reconnect.evidence.v3.json
```

The verifier rejects cross-meeting identity reuse, mixed deployments, raw
internal IDs in Discord text, missing human evidence intervals, and missing
speaker/action-owner mentions. A successful provider call without a passing
campaign result is not accepted.

Synthetic fixtures may be generated for deterministic speech. They must contain
only invented test content, identify the expected Discord speaker explicitly in
fixture metadata, and be checked with `ffprobe` before use. Provider/network
failures block only their external gate; work continues on local, integration,
recovery, documentation, or deployment-isolation checks.
