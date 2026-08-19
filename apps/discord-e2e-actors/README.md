# Discord E2E actors

This test-only CLI connects two official bot applications to one private guild
voice channel and plays synthetic Ogg Opus fixtures with controlled overlap,
strictly sequential playback, or one speaker reconnecting during the same recording.
It never accepts bot tokens directly through environment variables.

## Compile a hosted campaign plan

Compile the strict definition and its operator-selected runtime bindings before
starting a campaign. Both inputs must be current-user-owned, single-link regular
files with mode `0600`. The output path must be absolute and absent; its parent
is created with mode `0700`, and the complete plan is published create-only with
mode `0600`. Compilation performs no host, Discord, or secret-store actions.

```sh
pnpm --filter @discord-meeting/discord-e2e-actors compile:hosted-campaign-plan -- \
  --definition /absolute/private/campaign-definition.json \
  --bindings /absolute/private/runtime-bindings.json \
  --output /absolute/private/plans/campaign-plan.json
```

Never reuse the output path. The runner initializes the fresh campaign artifact
layout separately; compiling a plan does not create run or barrier artifacts.

## Run the hosted campaign coordinator

The package contains an executable coordinator for the fixed private-test
campaign. It compiles three isolated runs (`sequential`, `overlap`, then
`reconnect`) into one validated execution graph and starts each finite child
only at its declared barrier. The reconnect run orders four proactive greetings,
one addressed answer, and one prepared farewell without operator sleeps. Armed
receipts close the observer, actor, and supplemental-player races before their
release gates are published.

Run the campaign commands from the audited host-side checkout, not from a
Compose runner container. Before the coordinator may create its private
artifact layout or start a child, the admission CLI recomputes the plan from the
exact definition and runtime bindings. It also validates the pinned fixture
bytes, five file-secret files, available disk space, declared candidate
revisions, and fresh remote probe results. Inputs and receipts are private
create-only files; a retry uses a new campaign ID, artifact root, and output
paths.

```sh
pnpm --filter @discord-meeting/discord-e2e-actors preflight:hosted-campaign -- \
  --definition /absolute/private/campaign-definition.json \
  --bindings /absolute/private/runtime-bindings.json \
  --plan /absolute/private/plans/campaign-plan.json \
  --receipt /absolute/private/admission.json \
  --minimum-free-bytes 1073741824 \
  --remote-evidence /absolute/private/remote-evidence.json \
  --release-binding /absolute/private/release-binding.json

pnpm --filter @discord-meeting/discord-e2e-actors run:hosted-campaign -- \
  /absolute/private/plans/campaign-plan.json \
  /absolute/private/campaign-pass.json \
  86400000 \
  /absolute/private/admission.json \
  /absolute/private/campaign-definition.json \
  /absolute/private/runtime-bindings.json \
  --release-binding /absolute/private/release-binding.json
```

🚨 Production admission is fail-closed. Both preflight and the runner require
the same private reviewed release-binding file. It must match the compiled trust
root and pin the candidate source revisions plus full immutable image digests.
An absent binding fails with `RELEASE_BINDING_REQUIRED`; mutable/missing digests,
historical evidence, or an operator-authored `remote-evidence.json` cannot grant
authority. Do not bypass admission or present deterministic coordinator tests
as a real Discord/host pass.

## Supplemental Speaker D playback

`play:supplemental` is a one-off addition to the retained private-guild campaign.
It connects one official Speaker D test bot and plays one pre-qualified Ogg Opus
fixture exactly once. That fixture contains two ordered synthetic turns: Speaker
D first asks Botik a question and later makes one explicit group farewell. This
supplements conversation/farewell coverage; Speaker A and Speaker B remain the
only human WER/CER corpus and overlap inputs.

The committed `test/fixtures/supplemental-voice-playback.v1.json` pins the
already-qualified fixture. Do not generate or substitute audio during the
campaign. Relative fixture paths are resolved from the manifest directory:

```json
{
  "schemaVersion": 1,
  "privateTestGuildAcknowledgement": "private-test-guild",
  "guildId": "1533228590643155034",
  "voiceChannelId": "1533228823045214398",
  "applicationId": "1533873978417086474",
  "fixture": {
    "path": "supplemental-question-farewell.ru.ogg",
    "sha256": "fa4d4db0e725944e65cacef8dff12172b2fac2456f2cd5ded33eddc86328c608",
    "durationMs": 24226,
    "purpose": "speaker-d-botik-question-and-later-group-farewell"
  }
}
```

Store its token in Keychain service `discord-voice-bot-e2e`, account
`speaker-d`, or in a private `speaker-d` file accepted by the existing
file-secret reader. Then run with explicit private-target acknowledgement and
bounded holds:

```sh
DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD=private-test-guild \
DISCORD_E2E_SUPPLEMENTAL_MANIFEST=/app/apps/discord-e2e-actors/test/fixtures/supplemental-voice-playback.v1.json \
DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT=/absolute/evidence/speaker-d.playback.json \
DISCORD_E2E_SUPPLEMENTAL_RUN_ID=campaign-2026-08-11-reconnect \
DISCORD_E2E_SUPPLEMENTAL_PRE_HOLD_MS=10000 \
DISCORD_E2E_SUPPLEMENTAL_POST_HOLD_MS=10000 \
pnpm --filter @discord-meeting/discord-e2e-actors play:supplemental
```

The CLI refuses token environment variables, an absent private-guild
acknowledgement, malformed or unpinned targets, a non-bot or mismatched
application identity, changed/non-Ogg audio, a fixture longer than 60 seconds,
timeouts shorter than the fixture, a pre-hold above 120 seconds, and a post-hold
above 60 seconds. It writes create-only non-secret evidence after playback reaches
`Playing` and then `Idle`; it never replaces an existing evidence file.

## Providerless conversation voice observer

`observe:conversation` is a separate Stage 7 diagnostic for a private,
test-only guild. It uses one official observer bot, joins only the explicitly
configured guild voice channel, and subscribes only to the configured Craig bot
user. Set `DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD=private-test-guild`;
this acknowledgement is mandatory and is retained in the evidence. Do not use
it in a public or user-owned guild.

Store the observer token in macOS Keychain under service
`discord-voice-bot-e2e`, account `conversation-observer` (or use the same
private file-secret reader rules described above). Provide no token through an
environment variable:

```sh
DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD=private-test-guild \
DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID=... \
DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID=... \
DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID=... \
DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID=... \
DISCORD_E2E_CONVERSATION_VOICE_RUN_ID=... \
DISCORD_E2E_CONVERSATION_VOICE_TURN_ID=... \
DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID=... \
DISCORD_E2E_CONVERSATION_VOICE_PURPOSE=addressed-answer \
DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID=... \
DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT=/absolute/evidence/answer-handshake \
DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS=120000 \
DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS=6000 \
DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS=5000 \
DISCORD_E2E_CONVERSATION_VOICE_OUTPUT=/absolute/evidence/conversation-voice.json \
pnpm --filter @discord-meeting/discord-e2e-actors observe:conversation
```

The observer decodes only bounded 48 kHz stereo S16LE PCM in memory (never more
than 60 seconds / 11,520,000 bytes), then atomically writes a new JSON evidence
file with packet/timing data, PCM SHA-256, RMS and non-silence metrics. It never
stores bot tokens, PCM, Opus packets, or transcript text. It fails for no audio,
timeout, silence, an unexpected sender, or an existing output path.
It joins the pinned private channel before waiting for the configured playback
bot, allowing the observer to be present before a first-join greeting becomes
playback-ready.
Use `DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS` for a cold playback bot;
it bounds both playback-bot readiness and the wait for its first audio packet.
The separate, bounded audio capture window starts only with that first packet.
When omitted, readiness falls back to the capture timeout, which defaults to
60 seconds. Real campaigns should set both explicitly so a long readiness wait
cannot widen the retained audio window.

For an ordered campaign, `DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON`
may contain up to 15 additional capture objects. Greeting and farewell objects
contain `attemptId`, `expectedDuration`, `outputPath`, `purpose`, and literal
`turnId`. An `addressed-answer` object contains `expectedDuration`, `outputPath`,
`purpose`, and an absolute fresh `playbackHandshakeRoot`. Every
`expectedDuration` declares integer `minimumMilliseconds` and
`maximumMilliseconds`; the minimum cannot exceed the maximum, and the configured
capture timeout and PCM byte ceiling must cover the declared range. The observer
validates every create-only output and correlation before
joining, keeps one voice connection for the full sequence, and waits for the
configured source to remain silent for 300 milliseconds between captures. That
wait is bounded by `DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS`, not by the
short capture timeout. This prevents Discord reconnect timing from binding a
later utterance to an earlier expected turn.

The two-phase addressed-answer handoff is automatic. Meeting Platform publishes
a create-only intent with the exact run, meeting, turn, and playback-attempt IDs.
In strict campaign mode the observer may omit the pre-call
`DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID`; it derives the meeting ID from the
single fresh, schema-validated, run-bound, content-addressed intent in the clean
handshake root. Standalone observation still requires an explicit meeting ID.
The shared-volume receipt is not a cryptographic signature: trust comes from a
private current-user-owned directory, private current-user-owned regular files,
create-only publication, and exact digest/schema/run validation. For a hosted
campaign, apply `infra/deployment/compose.e2e-campaign.yaml` only to the isolated
test deployment. `E2E_CAMPAIGN_HOST_ROOT` is the exact fresh mode-0700
UID/GID-10001 wrapper used as `campaignRoot` by the host-side coordinator and
containing exactly one campaign-ID directory. It is bound to Meeting Platform
at `/run/e2e-campaign`, so readiness paths are
`/run/e2e-campaign/<campaign-id>/run-3/...`. Never point it at the shared
campaigns parent. The
production Compose file has no readiness mount. Official test-bot tokens remain
host-side runner secrets and are never mounted into Platform.
The deployment-safety probe must prove exact roots, sibling isolation, freshness
and bidirectional host/Platform nonce visibility before launch. Its v2 receipt
also brackets the exact compiled `campaignRoot` with canonical before/after
snapshots and requires a non-symlink mode-0700 UID/GID-10001 directory whose
only entry is the current campaign-ID directory. The host-side
coordinator is the host principal; no runner container participates. The
already-subscribed observer rejects stale, mismatched, or ambiguous receipts and
publishes a matching create-only ready receipt, retaining the resolved meeting
ID and intent digest in campaign proof. Only then may playback start. Any earlier
audible packet aborts the campaign. Never reuse a per-run subdirectory.

Each capture declares `greeting`, `farewell`, or `addressed-answer` purpose.
Alone it remains transport evidence: it does not run STT, establish the
authoritative Craig recording, or independently verify its operator-supplied
correlation. A first-join capture may omit
`DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID` before Craig exposes its random
recording ID; the create-only raw file then retains `null`. The collector binds
that capture exactly once to the explicitly selected authoritative recording
and rejects a conflicting non-null ID. Retained evidence v7 and newer closes that
correlation by checking
the capture interval against the authoritative recording, matching lifecycle
turns to settled runtime markers plus audible captures, and matching the
addressed-answer interval to exactly one Botik turn in the final transcript.
For the strict conversation campaign, positional correlation considers only
lifecycle events whose purpose and exact or retry-aware turn identity bind to
one of the six captures. Other meeting lifecycle events remain in retained
evidence but do not shift campaign positions; an extra event bound to a campaign
capture still fails the exact-six gate.
For v7 and newer, the configured source bot must be the same pinned Botik identity.

The strict six-capture order is: unknown-observer greeting, named Russian
greeting, named English greeting, Speaker D greeting, addressed answer, then
prepared farewell. The primary capture uses the top-level expected-duration
settings; each of the five additional objects must carry its own
`expectedDuration` range. Missing, extra, or reordered roles fail before login.

The executable lifecycle coordinator now provides deterministic barriers for
actor joins, reconnects, observer subscription and capture, addressed-answer
readiness, supplemental playback, and teardown. Manual sleeps, including the
historical ten-second Speaker B delay, are not acceptance evidence. The real
private-guild campaign is still not qualifying while fail-closed remote
admission is blocked; never run it against production or represent a local
coordinator test as a real-provider gate.

Generate the Russian fixtures with embedded English technical terms before the
first external run. The command uses macOS `say` (voice `Milena` by default),
encodes Ogg Opus with `ffmpeg`, verifies it with `ffprobe`, and prints the audio
SHA-256 values that are pinned in the manifest and captured by the collector:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors fixtures:generate
```

The default Russian speech rate is the real-provider-qualified `130` words per
minute. English technical segments use `Daniel` at `150` words per minute so
the fixture audio pronounces them faithfully. `DISCORD_E2E_TTS_VOICE`,
`DISCORD_E2E_TTS_RATE`, `DISCORD_E2E_TTS_ENGLISH_VOICE`, and
`DISCORD_E2E_TTS_ENGLISH_RATE` are permitted only when the new audio is
re-qualified and its hashes and durations are repinned.

The versioned ground truth is `test/fixtures/manifest.v1.json`. It pins the exact
UTF-8 source and Ogg SHA-256 hashes, Ogg duration, expected Discord speaker IDs,
required Russian/English terminology, scenario timing, and overlap behavior.
The harness refuses to connect if a configured fixture differs from the manifest.

Before a coordinated real-provider run, store the five official private-test bot
tokens in macOS Keychain under service `discord-voice-bot-e2e`, accounts `sut`,
`speaker-a`, `speaker-b`, `conversation-observer`, and `speaker-d`.
Provide only the private test guild and voice channel IDs:

```sh
DISCORD_E2E_GUILD_ID=... \
DISCORD_E2E_VOICE_CHANNEL_ID=... \
DISCORD_E2E_RUN_ID=campaign-2026-08-02-overlap \
DISCORD_E2E_ACTOR_RUN_OUTPUT=/absolute/evidence/overlap.actor-run.json \
pnpm --filter @discord-meeting/discord-e2e-actors start
```

For an isolated Linux test host, build the package Dockerfile and mount a private
read-only directory containing `sut`, `speaker-a`, `speaker-b`,
`conversation-observer`, and `speaker-d` files. Set
`DISCORD_E2E_SECRET_DIRECTORY` to the mount path. The directory and every token
file must be owned by the container user, have no group/other permission bits,
and must not be symbolic links; token entries must be regular files. Delete the
host copies immediately after the campaign.

`runId` is chosen before the call. Craig's random `recordingId` is deliberately
not required by the actor process. Actor evidence contains absolute wall-clock
events and is bound to one explicit recording only by the collector after the
authoritative Craig manifest exists.

Optional environment settings override the Keychain service/account names,
fixture paths, scenario, speaker B connection/playback delays, and
readiness/playback timeouts. `DISCORD_E2E_SPEAKER_B_CONNECT_DELAY_MS` defaults
to `0`, accepts up to `120000`, and may be set only for a bounded private-guild
observer campaign. The scenario is selected with
`DISCORD_E2E_SCENARIO=overlap|sequential|reconnect` and
defaults to `overlap`. For `sequential`, the delay is the silent gap after speaker
A completes. For `reconnect`, the delay selects when speaker B disconnects while
speaker A continues; speaker B then waits for a new ready voice connection and
plays its fixture exactly once. Do not run this CLI against a public or user-owned
guild.

For the opt-in five-minute live-summary check, use
`DISCORD_E2E_PRE_PLAYBACK_HOLD_MS` to place the pinned speech near the five-minute
publication boundary and `DISCORD_E2E_POST_PLAYBACK_HOLD_MS` to keep both official
actors connected after their fixtures end. Both default to `0` and accept an integer
from `0` to `600000`. For example, `PRE=285000` plus `POST=30000` keeps recent
per-speaker captions visible around `05:00`, then leaves time to observe edits before
the actors close. Do not use these holds outside the private test guild.

Craig stops a completely silent test recording after one minute. The reproducible
live gate therefore uses `test/fixtures/manifest.live.v1.json` with the pinned
`speaker-*.live.ru-en.ogg` files: a very quiet 270-second heartbeat keeps the RTP
recording active, then the qualified Russian/English speech crosses the `05:00`
boundary. Select that manifest and both matching fixture paths, leave the pre-hold
at `0`, and use a short post-hold to observe the final live edits.

After the call finishes, run the collector with the explicit Craig recording ID.
It reads the actual Postgres snapshot/counts over the isolated SSH deployment,
downloads and hashes the authoritative S3 manifest and every speaker track,
counts Discord projection markers and retains the visible embed description plus
the names and byte sizes of both layered evidence attachments,
extracts the published possession link without retaining its fragment, exchanges
it for a scoped playback session, resumes that session after fragment removal,
and range-reads every authoritative S3 playback track whose SHA256 must match. Set
`DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN` to the explicit HTTPS origin,
`DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE=private-test-deployment`, and choose
`DISCORD_E2E_RECORDING_PLAYBACK_READINESS=transition` to require an observed
processing/unavailable-to-ready transition or `already-ready` to gate a known
already-ready collection. The retained JSON contains only origin/path, digests,
statuses, Content-Range, byte count, and checksum - never the fragment or cookie.
captures immutable Craig, Meeting Platform, and Subscription Runtime deployment
provenance plus correlated stage/model latency observations. When
`DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION` is set, it also requires and
captures the profiled Pipecat service. It replays the
completed BullMQ job, then repeats the Postgres, Discord, and provenance probes.
The retained v9 conversation group makes that exact Pipecat revision mandatory.
It also requires `DISCORD_E2E_DISCORD_PLAYBACK_LINK_PROOF_INPUT`, an absolute path
to the exact-marker Live Discord playback-link observer JSON. The collector
accepts only a current-user-owned regular mode-0600 file, parses the complete
observer output strictly, and requires its run, recording, playback origin,
container, message, capability digest, and first-seen poll timestamps to match
the service-level measurement before it reads a Discord secret or starts any
deployment/network probe. Do not create or edit this proof manually: retain the
JSON returned by `observeFirstSeenLiveDiscordPlaybackLink` for the campaign.
It writes nothing unless correlation, stable provenance, and the single-run
verifier pass:

```sh
DISCORD_E2E_RUN_ID=campaign-2026-08-02-overlap \
DISCORD_E2E_RECORDING_ID=<craig-recording-id> \
DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN=https://recordings.test.example \
DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE=private-test-deployment \
DISCORD_E2E_RECORDING_PLAYBACK_READINESS=already-ready \
DISCORD_E2E_ACTOR_RUN_INPUT=/absolute/evidence/overlap.actor-run.json \
DISCORD_E2E_EVIDENCE_OUTPUT=/absolute/evidence/overlap.evidence.v6.json \
DISCORD_E2E_MUTATION_TARGET=test-only \
DISCORD_E2E_REMOTE_HOST=e2e-test-host \
DISCORD_E2E_REMOTE_SOURCE_ROOT=/srv/discord-meeting/source \
DISCORD_E2E_REMOTE_COMPOSE_FILE=/srv/discord-meeting/source/infra/deployment/compose.yaml \
DISCORD_E2E_REMOTE_ENV_FILE=/srv/discord-meeting/source.env \
DISCORD_E2E_REMOTE_PROJECT=discord-meeting-assistant \
DISCORD_E2E_REMOTE_CRAIG_PROJECT=craig-meeting-e2e \
DISCORD_E2E_REMOTE_CRAIG_SERVICE=bot \
DISCORD_E2E_REMOTE_ATTESTATION_FILE=/tmp/discord-e2e-attestations/campaign-2026-08-02-overlap.json \
pnpm --filter @discord-meeting/discord-e2e-actors collect:e2e
```

For the opt-in greeting/farewell/Botik campaign, start a create-only observer
capture immediately before each of the four greeting playbacks, the prepared
farewell, and the addressed answer. Current collection emits v9 when the pinned
Botik speaker ID and the JSON array of those six files are supplied:

```sh
DISCORD_E2E_BOTIK_SPEAKER_ID=1533877611258708230 \
DISCORD_E2E_DISCORD_PLAYBACK_LINK_PROOF_INPUT=/absolute/evidence/playback-link-proof.json \
DISCORD_E2E_CONVERSATION_VOICE_INPUTS='["/absolute/evidence/greeting-observer.json","/absolute/evidence/greeting-ru.json","/absolute/evidence/greeting-en.json","/absolute/evidence/greeting-speaker-d.json","/absolute/evidence/addressed-answer.json","/absolute/evidence/farewell.json"]' \
DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT=/absolute/evidence/speaker-d.playback.json \
DISCORD_E2E_EVIDENCE_OUTPUT=/absolute/evidence/reconnect.evidence.v9.json \
DISCORD_E2E_SECRET_DIRECTORY=/run/secrets/discord-e2e \
pnpm --filter @discord-meeting/discord-e2e-actors collect:e2e
```

The v9 verifier requires audible RU and EN greetings for the exact pinned actor
identities whose Botik transcript interval contains a pinned greeting term and,
for known RU/EN actors, their pinned spoken-name token,
separate default-locale greetings for the pinned unknown observer and Speaker D
without logging a prompt or name, one greeting per participant despite reconnect,
exactly one completed prepared farewell in the pinned language, one audible capture per lifecycle
turn, and one audible addressed answer overlapping one final Botik transcript
turn. The pinned Speaker D playback must contribute the expected question and
farewell transcript terms, including its deterministic answer nonce. The Botik
answer is required between those turns and must repeat that same nonce. It
rejects stale intervals, duplicate attempts/participants, mixed
observer or Botik identities, wrong run/recording, and a missing/wrong Botik
speaker track. Deterministic bridge and providerless playback tests separately
prove the exact named and nameless phrase construction without retaining PII in logs.
The reconnect proof keeps semantic greeting/answer/farewell lifecycle events
unchanged and retains a dedicated privacy-safe SUT `participant.left`/rejoined
receipt pair. Its negative window starts when the rejoin receipt was observed
by the SUT, using its source occurrence time, and continuously reaches the
authoritative recording end. Any unmatched greeting-shaped Botik transcript
turn in that window fails closed.
For a zero-audio first attempt, the observer keeps the participant's base turn
ID while the settled event may use only `:retry-1` through `:retry-3`; timestamp
binding must still prove exactly one audible successful greeting.

For a fully hosted campaign, use the same external secret directory for the
actor harness, voice observer, and collector. It contains files named by the
configured accounts (`sut`, `speaker-a`, `speaker-b`, `conversation-observer`,
and `speaker-d`) and never token values in environment variables or process
arguments.

Collection and both verification commands require immutable candidate inputs
`DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION`,
`DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION`, and
`DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION`. Set them from the
release candidate commits, never from an existing evidence file.
Set optional `DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION` only when the
deployment was started with Compose profile `conversation`; once set, missing or
stale Pipecat provenance fails collection and verification.

The collector performs a real post-call replay. Run it only against the isolated
official-bot test deployment. It has no remote host, path, service, or project
defaults. Set every `DISCORD_E2E_REMOTE_*` coordinate explicitly, set
`DISCORD_E2E_MUTATION_TARGET=test-only`, and use only Compose projects
`discord-meeting-assistant` and `craig-meeting-e2e` (Craig service `bot`). The
running `meeting-platform` container must carry label `e2e.test-only=true`.

The hosted coordinator publishes a mode `0600`, non-symlink, one-shot marker
immediately before collection inside the same owner's non-symlink mode `0700`
directory at `/tmp/discord-e2e-attestations/<run-id>.json` on the remote test
host. Pass that absolute path as `DISCORD_E2E_REMOTE_ATTESTATION_FILE`. The
marker contains no secret and binds the selected fixture set, actor run, Craig
recording, running container, image, and source revision exactly. Standalone
collection must use an equivalently reviewed create-only v2 marker; legacy v1
is readable only as historical evidence and cannot authorize campaign replay:

```json
{
  "schemaVersion": 2,
  "purpose": "bullmq-post-call-replay",
  "fixtureSetId": "discord-meeting-ru-en-v6",
  "runId": "campaign-2026-08-02-overlap",
  "recordingId": "explicit-craig-recording-id",
  "containerId": "64-lowercase-hex-container-id",
  "imageId": "sha256:64-lowercase-hex-image-id",
  "sourceRevision": "40-or-64-lowercase-hex-source-revision"
}
```

The collector performs a read-only target preflight before reading credentials
or Discord, then repeats the label/marker check against the exact container and
confirms the completed BullMQ job. It checksum-validates and removes the
one-shot marker immediately before retry. A failed preflight leaves the marker
for diagnosis; once consumed, any failure requires a newly reviewed marker.
An interruption after marker consumption has an ambiguous replay outcome: check
the job's latest `processedOn` before reviewing and issuing a fresh marker.
Remote probe failures never print stderr, marker contents, or secret values.
All three required running images, plus Pipecat when selected, must carry a
lowercase 40- or 64-character
`org.opencontainers.image.revision` OCI label. Do not restart those services
between the call and collection.

An individual evidence file can be checked again deterministically:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors run verify:e2e \
  /absolute/path/to/manifest.v1.json /absolute/path/to/retained-evidence.v6.json
```

The command exits non-zero for WER/CER or terminology failure, wrong speakers or
timestamps, missing overlap, invalid summary evidence, broken reconnect ordering,
changed replay identities, or any duplicate business effect.

Finally verify the full campaign. At least one passing run for each scenario is
required, including one retained v8-or-newer reconnect run for the lifecycle
proof. The hosted coordinator currently emits v9 for reconnect and v6 for
sequential and overlap; schema versions may differ while immutable deployment
provenance must match exactly. Set the
expected Pipecat revision for all three collections so the v6 runs retain the
same four-component provenance as the reconnect run. Meeting,
recording, transcript, summary, thread, and message IDs must all be isolated
between runs:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors run verify:campaign -- \
  test/fixtures/manifest.v1.json \
  /absolute/evidence/sequential.evidence.v6.json \
  /absolute/evidence/overlap.evidence.v6.json \
  /absolute/evidence/reconnect.evidence.v9.json
```
