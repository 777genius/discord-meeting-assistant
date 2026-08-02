# Discord E2E actors

This test-only CLI connects two official bot applications to one private guild
voice channel and plays synthetic Ogg Opus fixtures with controlled overlap,
strictly sequential playback, or one speaker reconnecting during the same recording.
It never accepts bot tokens directly through environment variables.

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
fixture paths, scenario, speaker B delay, and readiness/playback timeouts. The
scenario is selected with `DISCORD_E2E_SCENARIO=overlap|sequential|reconnect` and
defaults to `overlap`. For `sequential`, the delay is the silent gap after speaker
A completes. For `reconnect`, the delay selects when speaker B disconnects while
speaker A continues; speaker B then waits for a new ready voice connection and
plays its fixture exactly once. Do not run this CLI against a public or user-owned
guild.

After the call finishes, run the collector with the explicit Craig recording ID.
It reads the actual Postgres snapshot/counts over the isolated SSH deployment,
downloads and hashes the authoritative S3 manifest and every speaker track,
counts Discord projection markers and retains the visible embed description,
captures immutable Craig and Meeting Platform deployment provenance, replays the
completed BullMQ job, then repeats the Postgres, Discord, and provenance probes.
It writes nothing unless correlation, stable provenance, and the single-run
verifier pass:

```sh
DISCORD_E2E_RUN_ID=campaign-2026-08-02-overlap \
DISCORD_E2E_RECORDING_ID=<craig-recording-id> \
DISCORD_E2E_ACTOR_RUN_INPUT=/absolute/evidence/overlap.actor-run.json \
DISCORD_E2E_EVIDENCE_OUTPUT=/absolute/evidence/overlap.evidence.v2.json \
pnpm --filter @discord-meeting/discord-e2e-actors collect:e2e
```

The collector performs a real post-call replay. Run it only against the isolated
official-bot test deployment. Infrastructure paths/host/project have safe
environment overrides for another disposable deployment. Craig defaults to
Compose project `craig-meeting-e2e`, service `bot`; override them with
`DISCORD_E2E_REMOTE_CRAIG_PROJECT` and `DISCORD_E2E_REMOTE_CRAIG_SERVICE`.
Both running images must carry a lowercase 40- or 64-character
`org.opencontainers.image.revision` OCI label. Do not restart either service
between the call and collection.

An individual evidence file can be checked again deterministically:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors run verify:e2e -- \
  test/fixtures/manifest.v1.json /absolute/path/to/retained-evidence.v2.json
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
  /absolute/evidence/sequential.evidence.v2.json \
  /absolute/evidence/overlap.evidence.v2.json \
  /absolute/evidence/reconnect.evidence.v2.json
```
