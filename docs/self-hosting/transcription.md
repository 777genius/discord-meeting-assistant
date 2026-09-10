# Final transcripts and live captions

[Self-hosting](README.md) · [Provider limits](../speech-providers.md)

The base stack transcribes Craig's original per-speaker recordings after the
meeting. Optional live captions stream while it runs. Live text is derived;
it does not replace the authoritative final transcript.

## Deepgram only

Store your key in `secrets/voicetext/providers/deepgram-api-key` and add its
container path to `config/voicetext-gateway.env`, following
[Storage and secrets](storage-and-secrets.md). In `/secure/botik.env`:

```dotenv
VOICETEXT_BATCH_PROFILE=deepgram-nova-3
VOICETEXT_LIVE_PROFILE=deepgram-nova-3
VOICETEXT_LIVE_ENABLED=false
```

## ElevenLabs only

Store the ElevenLabs key and configure only its gateway key-file path. Change
**both** selectors in `/secure/botik.env`:

```dotenv
VOICETEXT_BATCH_PROFILE=elevenlabs-scribe-v2
VOICETEXT_LIVE_PROFILE=elevenlabs-scribe-v2-realtime
VOICETEXT_LIVE_ENABLED=false
```

The selectors default independently to Deepgram. Changing only the batch selector
does not select ElevenLabs live recognition. Missing credentials do not trigger
a fallback to another provider. ElevenLabs speech recognition and the optional
ElevenLabs voice-answer service are separately configured consumers.

## Add live captions

Once final transcription works, set `VOICETEXT_LIVE_ENABLED=true` and redeploy
with the same three-file command from [Installation](installation.md#5-build-and-start).
A separate live session may be opened for each speaker, so provider usage can
increase with speaker count. Captions do not require the AI-summary sidecar.

Check that captions appear while the private test fixture plays, then verify
that the final transcript is still published after the meeting. A successful
health check alone does not verify provider access or caption delivery.

## Mixed providers

Batch and live can use different providers. Configure both key files and both
gateway key-path entries, then select the desired combination. Configuration
supports this, but mixed-provider acoustics have not been qualified. Do not
promise the same recognition quality as the narrow recorded campaigns.

## Size and concurrency

| Setting | Default | Operational meaning |
| --- | --- | --- |
| `VOICETEXT_BATCH_MAX_ARTIFACT_BYTES` | `67108864` | At most 64 MiB per submitted speaker artifact; may be lowered, not raised |
| `VOICETEXT_BATCH_MAX_CONCURRENCY` | `6` | Parallel speaker-track submissions per meeting; range 1–10 |
| `VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS` | `1` | Process-wide meeting admission; range 1–2; keep 1 with Platform's 2 GiB limit |
| `VOICETEXT_LIVE_MAX_CONCURRENT_SESSIONS` | `10` | Live session capacity |
| `VOICETEXT_LIVE_PACKET_BACKPRESSURE_TIMEOUT_MS` | `2000` | Bounded wait under live packet pressure |

Duration capacity depends on encoded size, not a guaranteed meeting-minute limit.
A long track can exceed the artifact limit. Do not assume automatic splitting
or increase the maximum beyond the admitted limit. Investigate a rejected job
while preserving the original recording.

For an existing deployment, drain pending provider-bound work before removing
its credentials. Switching providers does not rewrite the binding of queued
historical work. Do not edit the hardcoded legacy execution binding to migrate
old jobs; follow the [deployment compatibility rules](../../infra/deployment/README.md#voicetext-provider-profiles).

The [acceptance record](../../infra/deployment/oss-acceptance.md) covers narrow
RU/EN fixtures. Ukrainian UI text does not establish Ukrainian speech quality.
