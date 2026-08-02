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

Production transcription uses the Voicetext protocol-v2 machine boundary from
ADR 0006. Rotate the `meeting-platform` machine identity with the Voicetext CLI
and route its one-time stdout directly into the host secret file; never put the
bearer in argv, an environment variable, shell history, or this repository. The
isolated deployment expects:

```text
secrets/platform/voicetext-service-token  root:root 0400
```

Before a Discord campaign, a canary must prove `ready`, immutable finalized
segments, and `finalize_complete` against the same Voicetext endpoint. A transport
success is insufficient: verify the canary transcript against its pinned
required terms and WER/CER thresholds. The local Speaches container is available
only through the `local-stt` Compose profile and is not part of the production
campaign.

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
thread/message IDs. Retained evidence schema v2 also records the exact Craig and
Meeting Platform container IDs/start times, immutable image IDs, optional
repository digests, image-bound source revisions, and Compose config hashes. The
acceptance result is invalid if any decision or action item references a missing
transcript turn, if a retry creates a duplicate meeting, summary, thread, or
message, or if deployment provenance changes during collection or between
campaign runs.

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
directly from Docker. It accepts current human-readable projection markers and
legacy markers during rollout. Manually authored identity counts or provenance
are not accepted evidence. Retain its non-secret JSON output and the verifier
result. Run the campaign verifier with the standard pnpm separator:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors run verify:campaign -- \
  apps/discord-e2e-actors/test/fixtures/manifest.v1.json \
  /absolute/evidence/sequential.evidence.v2.json \
  /absolute/evidence/overlap.evidence.v2.json \
  /absolute/evidence/reconnect.evidence.v2.json
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
