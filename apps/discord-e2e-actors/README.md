# Discord E2E actors

This test-only CLI connects two official bot applications to one private guild
voice channel and plays synthetic Ogg Opus fixtures with controlled overlap,
strictly sequential playback, or one speaker reconnecting during the same recording.
It never accepts bot tokens directly through environment variables.

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
may contain up to 15 additional `{ attemptId, outputPath, purpose, turnId }`
objects. The observer validates every create-only output and correlation before
joining, keeps one voice connection for the full sequence, and waits for the
configured source to remain silent for 300 milliseconds between captures. That
wait is bounded by `DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS`, not by the
short capture timeout. This prevents Discord reconnect timing from binding a
later utterance to an earlier expected turn.

Each capture declares `greeting`, `farewell`, or `addressed-answer` purpose.
Alone it remains transport evidence: it does not run STT, establish the
authoritative Craig recording, or independently verify its operator-supplied
correlation. A first-join capture may omit
`DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID` before Craig exposes its random
recording ID; the create-only raw file then retains `null`. The collector binds
that capture exactly once to the explicitly selected authoritative recording
and rejects a conflicting non-null ID. Current v7/v8 retained evidence closes that
correlation by checking
the capture interval against the authoritative recording, matching lifecycle
turns to settled runtime markers plus audible captures, and matching the
addressed-answer interval to exactly one Botik turn in the final transcript.
For v7/v8, the configured source bot must be the same pinned Botik identity.

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

Before a coordinated real-provider run, store both tokens in macOS Keychain
under service `discord-voice-bot-e2e`, accounts `speaker-a` and `speaker-b`.
Provide only the private test guild and voice channel IDs:

```sh
DISCORD_E2E_GUILD_ID=... \
DISCORD_E2E_VOICE_CHANNEL_ID=... \
DISCORD_E2E_RUN_ID=campaign-2026-08-02-overlap \
DISCORD_E2E_ACTOR_RUN_OUTPUT=/absolute/evidence/overlap.actor-run.json \
pnpm --filter @discord-meeting/discord-e2e-actors start
```

For an isolated Linux test host, build the package Dockerfile and mount a private
read-only directory containing `speaker-a` and `speaker-b` files. Set
`DISCORD_E2E_SECRET_DIRECTORY` to the mount path; every file must be regular,
owned by the container user, and have no group/other permission bits. Delete the
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
captures immutable Craig, Meeting Platform, and Subscription Runtime deployment
provenance plus correlated stage/model latency observations. When
`DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION` is set, it also requires and
captures the profiled Pipecat service. It replays the
completed BullMQ job, then repeats the Postgres, Discord, and provenance probes.
The retained v8 conversation group makes that exact Pipecat revision mandatory.
It writes nothing unless correlation, stable provenance, and the single-run
verifier pass:

```sh
DISCORD_E2E_RUN_ID=campaign-2026-08-02-overlap \
DISCORD_E2E_RECORDING_ID=<craig-recording-id> \
DISCORD_E2E_ACTOR_RUN_INPUT=/absolute/evidence/overlap.actor-run.json \
DISCORD_E2E_EVIDENCE_OUTPUT=/absolute/evidence/overlap.evidence.v6.json \
pnpm --filter @discord-meeting/discord-e2e-actors collect:e2e
```

For the opt-in greeting/farewell/Botik campaign, start a create-only observer
capture immediately before each of the four greeting playbacks, the prepared
farewell, and the addressed answer. Then collect v8 by adding the pinned Botik
speaker ID and the JSON array of those six files:

```sh
DISCORD_E2E_BOTIK_SPEAKER_ID=1534231284467896512 \
DISCORD_E2E_CONVERSATION_VOICE_INPUTS='["/absolute/evidence/greeting-observer.json","/absolute/evidence/greeting-ru.json","/absolute/evidence/greeting-en.json","/absolute/evidence/greeting-speaker-d.json","/absolute/evidence/farewell.json","/absolute/evidence/addressed-answer.json"]' \
DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT=/absolute/evidence/speaker-d.playback.json \
DISCORD_E2E_EVIDENCE_OUTPUT=/absolute/evidence/reconnect.evidence.v8.json \
DISCORD_E2E_SECRET_DIRECTORY=/run/secrets/discord-e2e \
pnpm --filter @discord-meeting/discord-e2e-actors collect:e2e
```

The v8 verifier requires audible RU and EN greetings for the exact pinned actor
identities whose Botik transcript interval contains a pinned greeting term,
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
For a zero-audio first attempt, the observer keeps the participant's base turn
ID while the settled event may use only `:retry-1` through `:retry-3`; timestamp
binding must still prove exactly one audible successful greeting.

For a fully hosted campaign, use the same external secret directory for the
actor harness, voice observer, and collector. It contains files named by the
configured accounts (`sut`, `speaker-a`, `speaker-b`, and
`conversation-observer`) and never token values in environment variables or
process arguments.

Collection and both verification commands require immutable candidate inputs
`DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION`,
`DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION`, and
`DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION`. Set them from the
release candidate commits, never from an existing evidence file.
Set optional `DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION` only when the
deployment was started with Compose profile `conversation`; once set, missing or
stale Pipecat provenance fails collection and verification.

The collector performs a real post-call replay. Run it only against the isolated
official-bot test deployment. Infrastructure paths/host/project have safe
environment overrides for another disposable deployment. Craig defaults to
Compose project `craig-meeting-e2e`, service `bot`; override them with
`DISCORD_E2E_REMOTE_CRAIG_PROJECT` and `DISCORD_E2E_REMOTE_CRAIG_SERVICE`.
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
required and meeting, recording, transcript, summary, thread, and message IDs
must all be isolated between runs:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors run verify:campaign -- \
  test/fixtures/manifest.v1.json \
  /absolute/evidence/sequential.evidence.v6.json \
  /absolute/evidence/overlap.evidence.v6.json \
  /absolute/evidence/reconnect.evidence.v6.json
```
