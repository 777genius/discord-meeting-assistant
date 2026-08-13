# Real Discord E2E and isolated hosting

## Fixed test assets

These assets are test-only and must never be reused for real meetings or other
projects.

| Asset | Discord ID |
| --- | --- |
| Guild `Meeting Assistant E2E` | `1533228590643155034` |
| Voice channel `e2e-meeting` | `1533228823045214398` |
| Results channel `e2e-results` | `1533228891827736657` |
| Application `Meeting E2E SUT` (approved Voice Bot) | `1533224474609057793` |
| Application `Meeting E2E Speaker A` | `1533227577286852649` |
| Application `Meeting E2E Speaker B` | `1533228054724346087` |
| Application `Meeting E2E Speaker C` (conversation observer) | `1533867700575670282` |
| Application `Meeting E2E Speaker D` | `1533873978417086474` |
| Botik test playback bot | `1534231284467896512` |

Bot tokens are stored only in the local macOS Keychain service
`discord-voice-bot-e2e`, under accounts `sut`, `speaker-a`, `speaker-b`,
`conversation-observer`, and `speaker-d`.
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
valid deployment state because the non-root container cannot read it. The
container-internal Botik identity and Voicetext canary probes require these
remote deployment secrets to remain exact owner `10001` mode `0400`. Campaign
definition, runtime-binding, and local official-bot token files are separate
local campaign inputs and remain exact current-user-owned mode `0600`.

Set `VOICETEXT_BATCH_MAX_CONCURRENCY` in the deployment environment to an
integer from `1` through `10`; it limits provider work within each meeting. The
production template targets `6`. Final transcription hard-limits a meeting to
ten speaker tracks and validates `10 x VOICETEXT_BATCH_MAX_ARTIFACT_BYTES` before
the bounded workers begin, which is 640 MiB with the production 64 MiB cap.
Workers read one Ogg immediately before upload rather than retaining all ten;
six workers have at most 384 MiB of caller Ogg payloads live, plus up to another
384 MiB of Fetch Blob copies during uploads.

Set `VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS=1` for the current 2 GiB Meeting
Platform container. This process-local FIFO gate covers only final Voicetext
transcription, so it does not directly gate completed-transcript summary
generation or publication. A job waiting for admission still occupies a BullMQ
worker slot; fully isolating stages would require a separate stage-job design.
Do not raise it to `2` on this host: two fully active six-worker meetings can
require about 1.5 GiB of Ogg and Blob payloads before runtime and transport
overhead. Raising it requires a separately sized host and a disposable canary;
it is not a distributed admission control.

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
container/message IDs. Retained evidence schema v4 records whether the visible
projection is a direct parent-channel message or a thread message. It continues
to read historical v2/v3 evidence and also records the exact Craig, Meeting
Platform, and Subscription Runtime container IDs/start times, immutable image
IDs, optional repository digests, image-bound source revisions, Compose config
hashes, and correlated stage/model latency observations. The
acceptance result is invalid if any decision or action item references a missing
transcript turn, if a retry creates a duplicate meeting, summary, container, or
message, if a required action deliverable is absent or unsupported by its cited
turns, or if deployment provenance changes during collection or between campaign
runs.

The live slice adds a separate timing and mutation proof. For a call longer than
five minutes, retain timestamps for the first audio packet, first finalized
transcript turn, first Discord publication, every incremental-summary generation,
the meeting end, and the final authoritative publication. The gate requires:

1. the first Discord publication within two seconds of the first recognized
   non-empty caption unless the external provider is unavailable;
2. one stable live Discord identity across captions, preliminary summaries, and
   retries. The final summary has one separate stable identity by default;
   `replace-live` compatibility mode reuses the live identity. The default
   container is the results channel itself; thread mode is explicit opt-in;
3. captions grouped by the real Discord speaker, with visible relative start
   times, while mutable partials never appear in summary evidence;
4. no preliminary summary before five minutes and the first successful summary
   generation by `05:30` unless Luna is unavailable;
5. Luna telemetry for every successful generation records measured or explicit
   unavailable states for input, cached input, cache-write input, output,
   reasoning output, and total tokens, plus model, run ID, price card, and an
   exact or bounded API-equivalent USD estimate;
6. a live-finalization fence before the durable post-call dispatcher can publish
   the final message, so a late live edit cannot overwrite a replacement-mode
   result or race the separate authoritative publication.

Record provider, Luna, and Discord latencies independently. Do not report the
five-second projection tick as STT or model latency. The API-equivalent cost is
an observability estimate only; the subscription runtime does not create an API
invoice.

### Live Botik conversation acceptance

Conversation rollout remains unqualified until one isolated private-guild run
proves the complete path with official test bots and synthetic speech:

1. address Botik with each canonical RU/EN alias and the pinned STT variants,
   including `Ботек`, then repeat one request as `Ботик` followed by a short
   pause and a separate question turn from the same speaker;
2. retain observer evidence that the configured Botik playback bot produced non-silent answer audio
   in the configured voice channel, plus end-of-turn to first-answer-audio
   latency for both a warm simple request and a warm reasoning request;
3. prove an ordinary mention such as `Вчера Ботик отвечал странно` does not start
   a conversation turn, and prove a different speaker cannot consume a pending
   wake latch;
4. after Craig finalization, retain the dedicated Botik authoritative track and
   verify that its duration covers only packets accepted by the Discord sender;
5. verify the final Voicetext transcript contains the expected Botik speaker ID
   and recognizable answer text, then verify the authoritative summary may cite
   those Botik turns without treating Botik as a human participant;
6. verify the derived live transcript does not ingest outbound Botik audio and
   therefore cannot create a self-response loop.

Passing local, provider, or voice-observer checks alone does not satisfy this
gate. Record the private guild/channel IDs, recording ID, Botik track checksum,
transcript ID, summary ID, provider/model profile, and latency measurements in
the retained non-secret evidence bundle.

### Greeting, reconnect, and farewell retained proof

The remaining lifecycle gate uses the same conversation voice observer and
retained evidence collector; it is not a separate framework. During one
private-guild reconnect run, retain create-only captures for a named Russian
greeting, a named English greeting, default-locale greetings for the unknown
observer and Speaker D, one addressed Botik answer, and the prepared farewell,
in that exact observer order. It mirrors the pinned Speaker D fixture: question,
Botik answer, then explicit group farewell. Set
`DISCORD_E2E_CONVERSATION_VOICE_PURPOSE` to `greeting`, `farewell`, or
`addressed-answer` for each capture and use the runtime turn ID shown by the
correlated structured event.

The committed fixture manifest pins Speaker C (`1533867700575670282`) as the
observer, the private guild, and the voice channel. Set the observer account to
`conversation-observer`; a capture set from any other consistent environment
still fails.
The first greeting may occur before Craig exposes its random recording ID. In
that case omit `DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID`; the raw capture
retains `null`, and the collector binds it exactly once to the explicitly
selected recording. A conflicting non-null recording ID fails closed, and the
v7/v8 verifier still requires every capture timestamp to fall inside that
recording's authoritative interval.

For a cold Botik connection, set
`DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS=120000` and
`DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS=6000` for the pinned
five-second campaign. The capture timeout must remain short enough to retain
exactly one playback. The readiness
timeout also covers a Botik already present in voice but not yet speaking; the
short capture window starts with the first audio packet.

The executable test-only coordinator now supplies deterministic readiness
barriers for actor joins, reconnects, observer captures, supplemental playback,
and the addressed-answer handshake. Its strict reconnect sequence is four
greetings, the addressed answer, then the prepared farewell. Manual sleeps or
operator timing are not acceptance evidence.

🚨 External execution is admitted only by the executable production trust
binding. The same private reviewed release-binding file is required by preflight
and the runner; absence fails with `RELEASE_BINDING_REQUIRED`. It must match the
compiled trust root, pin the candidate source revisions and full immutable Craig
and Meeting Platform image digests, and configure typed probes for clock,
deployment, Discord/Craig identity, container provenance, and the Voicetext
semantic canary. Missing or mutable digest data blocks preflight. Supplied
remote-capability files remain untrusted diagnostic declarations and never grant
authority. Do not bypass admission, run against production, or present local
coordinator coverage as real-provider qualification.

Use the audited host-side checkout for compile, preflight, and run. Do not run
the coordinator as a Compose service: its bounded SSH/process probes and local
official-bot secret boundary are part of the host-side command surface. Prepare
private mode-0600 definition, runtime-binding, and reviewed release-binding
files, then compile the exact create-only plan. Discover the test deployment
through its fully expanded Compose model and pin the exact container identities,
source revisions, and full repository digests in the release binding. Do not
substitute tags, shortened digests, historical evidence, or guessed Craig
network names. The three runtime bindings are operator-selected fresh paths
under `/tmp/discord-e2e-attestations`; the coordinator later publishes v2 replay
markers bound to the selected recording and the running container/image
provenance.

```sh
pnpm --filter @discord-meeting/discord-e2e-actors compile:hosted-campaign-plan -- \
  --definition /absolute/private/campaign-definition.json \
  --bindings /absolute/private/runtime-bindings.json \
  --output /absolute/private/plans/campaign-plan.json

pnpm --filter @discord-meeting/discord-e2e-actors preflight:hosted-campaign -- \
  --definition /absolute/private/campaign-definition.json \
  --bindings /absolute/private/runtime-bindings.json \
  --plan /absolute/private/plans/campaign-plan.json \
  --receipt /absolute/private/admission.json \
  --minimum-free-bytes 1073741824 \
  --remote-evidence /absolute/private/remote-evidence.json \
  --release-binding /absolute/private/release-binding.json
```

Only an `admitted` receipt that exactly matches the plan, definition, bindings,
release binding, candidate revisions, campaign ID and artifact root can unlock
the host-side runner. Run preflight immediately before the bounded command. The
coordinator performs a second fresh authorization after acquiring its exclusive
lease and refuses to start the first child when readiness expired:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors run:hosted-campaign -- \
  /absolute/private/plans/campaign-plan.json \
  /absolute/private/campaign-pass.json \
  86400000 \
  /absolute/private/admission.json \
  /absolute/private/campaign-definition.json \
  /absolute/private/runtime-bindings.json \
  --release-binding /absolute/private/release-binding.json
```

The hosted campaign pass receipt is published only after successful teardown.
Publication is create-only and atomic: a completed, synced temporary file in the
receipt directory is linked into its final name without replacing anything, and
the directory entry is synced before the temporary name is removed. A retry must
use a fresh campaign ID, fresh private artifact root, and fresh receipt path.
Never delete, overwrite, or reuse an existing receipt or artifact root to make a
retry pass. Retain an interrupted run's partial files, lease, and barrier markers
as abandoned diagnostic evidence, clearly separated from the next campaign.

To retain the ordered capture set with one observer connection, pass the
remaining capture records through
`DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON`. The record shape and
limits are documented in `apps/discord-e2e-actors/README.md`. Use the first
greeting as the literal primary capture, followed by the other three greetings,
the addressed answer, and the farewell. A non-empty additional capture array is
strict campaign mode: the CLI rejects a missing, extra, reordered, or misbound
role before Discord login and prints the validated non-secret JSON capture plan
before joining voice. Retain that plan beside the campaign evidence.
The exact six positions are unknown-observer greeting, named Russian greeting,
named English greeting, Speaker D greeting, addressed answer, and prepared
farewell. The primary capture uses
`DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS` plus its top-level
tolerance. Every additional capture object must include
`expectedDuration.minimumMilliseconds` and
`expectedDuration.maximumMilliseconds`; the minimum must not exceed the maximum,
and the capture timeout and PCM byte ceiling must cover every declared range.
The verifier preserves the lifecycle log's source order but filters it to events
that bind by purpose and turn identity to these six captures before positional
correlation. Unrelated meeting lifecycle events may remain in the evidence and
do not consume a campaign position; duplicate or extra events bound to a campaign
capture fail the exact-six lifecycle gate.

Use a literal `turnId` and `attemptId` for greeting and farewell captures. The
addressed-answer capture instead uses an absolute fresh
`playbackHandshakeRoot`. Meeting Platform creates an intent containing the exact
run, meeting, admitted turn, and playback-attempt IDs. The already-subscribed
observer may omit its pre-call meeting ID in strict campaign mode and derive it
from the single fresh, schema-validated, run-bound, content-addressed intent in
the clean handshake root. Standalone observation still requires an explicit
meeting ID. This shared-volume receipt is not cryptographically signed: the root
and receipt must be private and owned by the test UID/GID, publication is
create-only, and the observer rejects stale, mismatched, or ambiguous intents.
It creates the matching ready receipt and retains the resolved meeting identity
and digest in campaign proof before answer playback may begin. Any earlier
audible packet aborts the campaign. Apply the test-only
`infra/deployment/compose.e2e-campaign.yaml` overlay and set
`E2E_CAMPAIGN_HOST_ROOT` to the exact fresh mode-0700 UID/GID-10001 wrapper used
as `campaignRoot` by the coordinator and containing exactly one campaign-ID
directory. The overlay binds that wrapper to Meeting Platform at
`/run/e2e-campaign`; readiness paths are therefore exactly
`/run/e2e-campaign/<campaign-id>/run-3/...`. Never mount the shared campaigns
parent. Official test-bot
tokens remain in the host-side runner secret boundary and are not Platform
secrets. The base
production Compose deliberately has no campaign/readiness bind mount. Require
the host-to-Meeting-Platform root, isolation, freshness and bidirectional nonce
proof before launch, and never reuse a per-run subdirectory. The host-side
coordinator is the host principal, not a third mounted container. Meeting Platform
requires all `CONVERSATION_E2E_PLAYBACK_READINESS_*` settings together and
rejects them unless `E2E_TEST_ONLY_LABEL=true`.
Do not place the literal farewell capture before the addressed-answer capture.
The fixture produces Botik's answer before the group farewell, and the audible
pre-readiness guard intentionally fails if answer audio arrives before the
matching receipt is accepted; reversing the captures cannot recover a
trustworthy correlation afterward.
The bounded wait uses
`DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS`; an invalid, stale, oversized,
or late handshake aborts the campaign rather than guessing a correlation.

Reconnect one already-greeted official actor before the meeting ends. Do not
induce another first join. After finalization, pass all six observer files and
the pinned Botik speaker ID to the normal collector:

```sh
DISCORD_E2E_BOTIK_SPEAKER_ID=1534231284467896512 \
DISCORD_E2E_CONVERSATION_VOICE_INPUTS='["/absolute/evidence/greeting-observer.json","/absolute/evidence/greeting-ru.json","/absolute/evidence/greeting-en.json","/absolute/evidence/greeting-speaker-d.json","/absolute/evidence/addressed-answer.json","/absolute/evidence/farewell.json"]' \
DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT=/absolute/evidence/speaker-d.playback.json \
DISCORD_E2E_EVIDENCE_OUTPUT=/absolute/evidence/reconnect.evidence.v9.json \
DISCORD_E2E_SECRET_DIRECTORY=/run/secrets/discord-e2e \
pnpm --filter @discord-meeting/discord-e2e-actors collect:e2e

pnpm --filter @discord-meeting/discord-e2e-actors run verify:e2e -- \
  apps/discord-e2e-actors/test/fixtures/manifest.v1.json \
  /absolute/evidence/reconnect.evidence.v9.json
```

The gate derives locale and known/unknown status from privacy-safe runtime
metadata and combines it with audible captures plus the Botik transcript interval. It requires both locales, an
unknown participant, named participants in both languages, unique participant
greeting identity, and exactly one correctly localized
settled prepared farewell. Observer timestamps must
fall inside the same authoritative recording. The addressed capture must
overlap exactly one final transcript turn on the pinned Botik track. Any stale
file, duplicate attempt, mixed observer/Botik application, wrong run/recording,
wrong Botik speaker, or duplicate lifecycle identity fails closed. Keep the
existing deterministic greeting/playback and farewell-policy suites green: they
prove exact named/nameless phrases and the continuation, quoted-speech,
third-person, and false-positive cases without writing names or prompts to logs.
The supplemental evidence must match the pinned Speaker D application, fixture
hash, duration, guild, channel, and run. Its final transcript must contain the
question and farewell markers in order, with the audible Botik answer and its
deterministic nonce between them. The nonce is pinned in both the Speaker D
question terms and Botik answer expectation, so an unrelated acknowledgement
cannot satisfy the gate.
If an admitted greeting produces zero audio, the successful bounded retry uses
`participant-greeting:<participant-id>:retry-1..3`; v8 and newer accept only that
range and still require exactly one time-matched audible capture for that
participant. The observer may retain the base turn ID because it starts before
the successful attempt number is known.

For the retained campaign only, add the test-only `play:supplemental` CLI as a
separate Speaker D input. Its single pinned Ogg Opus fixture must first ask Botik
one synthetic question and, later in the same file, make one explicit group
farewell, with a qualified silent gap between those turns for Botik's answer.
The test-only coordinator starts it only after the required observer and actor
barriers are ready, using the same campaign run ID and armed connection/playback
gates. Bounded pre/post holds remain fixture behavior, not synchronization.
Speaker D and Botik are supplemental transcript evidence.
They must not be added to the Speaker A/B human WER/CER corpus or used to satisfy
the required A/B overlap.

The manifest supplied to that CLI pins the private guild, voice channel,
official Speaker D application ID, semantic fixture purpose, exact Ogg SHA-256,
and duration. Retain the manifest and the CLI's create-only playback evidence
beside the campaign evidence. The required acknowledgement is
`DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD=private-test-guild`; the token stays
in the existing Keychain/file-secret boundary under `speaker-d`. The complete
manifest shape, command, limits, and failure behavior are documented in
`apps/discord-e2e-actors/README.md`. This supplemental playback adds Speaker D's
own greeting capture; it does not replace any lifecycle capture or the authoritative Craig/transcript
checks above.

### Long-call telemetry

Meeting Platform writes one structured JSON event for every post-call stage and
every Luna or Sol runtime execution. These events contain measurements only. Raw
speech, transcript text, prompts, provider output, audio, and credentials are
never logged.

Use `Meeting processing stage completed` to inspect the full pipeline. Its safe
fields include stage duration and outcome plus the evidence timeline duration,
turn count, speaker count, character count, and final summary item counts when
those values exist. Successful transcription also reports the ratio between
processing time and the evidence timeline, which can be multiplied by a planned
meeting duration for a rough capacity estimate.

Use `Subscription runtime task completed` to inspect each Luna or Sol execution.
It records the admitted model profile, request size, runtime duration, status,
provider-unit availability, cache and reasoning breakdown, and the exact or
bounded API-equivalent cost when the runtime supplies one. A bounded final-output
repair is a separate execution with a separate run ID. Do not add both executions
together when measuring latency from meeting end; use them together only for
resource and cost analysis. Missing provider-unit classes and missing cost stay
explicitly unavailable and must never be read as zero.

Filter one meeting without printing unrelated container output:

```sh
MEETING_TELEMETRY_ID=NJMhJTt6ae58
docker logs discord-meeting-assistant-meeting-platform-1 2>&1 \
  | jq --arg meetingId "$MEETING_TELEMETRY_ID" -c '
      fromjson?
      | select(.meetingId == $meetingId)
      | select(
          .message == "Meeting processing stage completed"
          or .message == "Subscription runtime task completed"
          or .message == "Subscription runtime transport failed"
          or .message == "Incremental meeting summary refresh completed"
        )
    '
```

The same process exposes bounded aggregate stage histograms at `/metrics` under
`discord_meeting_stage_duration_seconds`. Meeting IDs and run IDs are intentionally
excluded from Prometheus labels to avoid unbounded cardinality. Docker JSON logs
are the per-meeting diagnostic record; export the filtered JSONL into the isolated
evidence directory when it must survive container removal. Accepted Luna usage is
also retained in the `meeting_core.live_meetings` snapshot. Final Sol provider
telemetry remains log-only in this minimal V1 design so observability does not
expand the authoritative Meeting aggregate.

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

Meeting Platform, Subscription Runtime, and profiled Pipecat receive their
revisions through the deployment environment. Apply the same `SOURCE_REVISION` label to the
isolated Craig gateway image in its own deployment Dockerfile. A copied host
source tree does not need `.git`; the revision is captured before copying and is
made immutable by the built image ID plus OCI label. Verify the three required
labels, and Pipecat when the `conversation` profile is under test, with
`docker image inspect` before the first call. Do not restart or redeploy Craig,
Meeting Platform, Subscription Runtime, or selected Pipecat between actor start
and retained evidence collection.

Use the versioned Russian/English ground truth at
`apps/discord-e2e-actors/test/fixtures/manifest.v1.json`. Generate its audio with
the actor package `fixtures:generate` script. The committed manifest pins the
resulting Ogg SHA-256 and duration; actor startup fails on any mismatch.
It also pins the official Botik and Voice Bot speaker IDs that may add proactive
greeting tracks. They remain outside fixture WER/CER and human overlap checks;
any other speaker still fails the retained-evidence gate.

Choose a unique `DISCORD_E2E_RUN_ID` and actor evidence path before each call.
Do not guess Craig's future random recording ID. Actor evidence uses absolute
wall-clock timestamps. After Craig finalizes, pass the explicit recording ID and
actor file to `collect:e2e`. The collector fail-closed binds them using the
authoritative manifest `startedAt`/`endedAt`, speaker tracks, checksums and timing.

The collector obtains both Postgres observations, S3 bytes, Discord marker counts,
visible embed text, and the names and byte sizes of both attachments containing
layered evidence, plus the completed-job replay and deployment provenance directly
from Docker. It accepts hidden v3 embed markers and legacy thread markers during
rollout. A direct-message receipt must retain exactly one matching message and
zero matching threads; a thread receipt must retain exactly one of each. Current
v6 evidence requires non-empty `meeting-summary.md` and `meeting-transcript.md`
attachments whose metadata remains unchanged after replay. Manually authored
identity counts or provenance are not accepted evidence.
Retain its non-secret JSON output and the verifier
result. Run the campaign verifier with the standard pnpm separator:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors run verify:campaign -- \
  apps/discord-e2e-actors/test/fixtures/manifest.v1.json \
  /absolute/evidence/sequential.evidence.v6.json \
  /absolute/evidence/overlap.evidence.v6.json \
  /absolute/evidence/reconnect.evidence.v9.json
```

The campaign must contain at least one retained v8-or-newer reconnect run; the
hosted coordinator currently emits v9, while sequential and overlap collection
remains v6. Mixed schema versions are valid
only when every run retains identical immutable deployment provenance. Set
`DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION` for all three collections so the
v6 runs retain the same four-component provenance as the reconnect run. The
verifier rejects cross-meeting identity reuse, mixed deployments, raw
internal IDs in Discord text, missing action-owner mentions, and missing or
invalid authoritative evidence references. Historical v2-v4 evidence still
verifies inline intervals and speaker mentions; v5 remains readable as the first
clean-summary format. Current v6 additionally proves the two attachments
containing layered evidence from ADR-0025 and their replay stability. Historical
evidence remains individually readable but cannot replace the required
v8-or-newer reconnect proof.
A successful provider call without a passing campaign result is not accepted.

Synthetic fixtures may be generated for deterministic speech. They must contain
only invented test content, identify the expected Discord speaker explicitly in
fixture metadata, and be checked with `ffprobe` before use. Provider/network
failures block only their external gate; work continues on local, integration,
recovery, documentation, or deployment-isolation checks.
