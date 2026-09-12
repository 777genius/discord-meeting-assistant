# Voice answers

[Self-hosting](README.md) · [AI runtime setup](ai-summaries.md)

Voice answers are an optional conversation path. They require the generation
runtime, Pipecat, an ElevenLabs voice and Craig playback. The core VoiceText
speech gateway does not provide a Pipecat STT adapter; setting a VoiceText
profile alone does not configure conversation. Long-term grounded memory has
separate [serving restrictions](meeting-memory.md).

## 1. Meet the prerequisites

Complete the base installation and [AI runtime prerequisites](ai-summaries.md),
including the source-built runtime package, authorized account pool, service token and digest.
The command below enables both summaries and voice. The sidecar image builds
the runtime from pinned public source; authorized account access is still required.

Create `secrets/platform/conversation-runtime-token` with an independent random
bearer, owner `10001:10001`, mode `0400`. Create `secrets/pipecat` with owner
`10001:10001`, mode `0700`, and place the ElevenLabs key in
`secrets/pipecat/elevenlabs-api-key`, mode `0400`. The Pipecat key mount is
separate from the gateway's speech-recognition key mount.

## 2. Keep the shipped voice initially

Add to `/secure/botik.env`:

```dotenv
CONVERSATION_ENABLED=true
VOICETEXT_LIVE_ENABLED=true
PIPECAT_RUNTIME_PROFILE=elevenlabs-multilingual
CONVERSATION_VOICE_PROFILE_ID=elevenlabs-multilingual
PIPECAT_RUNTIME_ELEVENLABS_MODEL=eleven_flash_v2_5
PIPECAT_RUNTIME_ELEVENLABS_VOICE_ID=jqcCZkN6Knx8BJ5TBdYR
PARTICIPANT_GREETING_DEFAULT_LOCALE=ru
```

Live recognition is required to receive addressed questions. Configure the
selected live speech profile and its gateway key using [Transcription](transcription.md);
the ElevenLabs TTS key alone does not configure that input path.

Use `en` for the default greeting locale if appropriate. Your ElevenLabs account
must have access to the selected voice. The shipped thinking, greeting and
farewell assets are bound to this voice/profile. Changing only the voice ID can
fail startup. The repository has no complete public cue-generation workflow;
a custom voice requires producing and validating all matching asset manifests
in a committed source revision before building. Do not edit checksums to bypass
asset validation.

The internal sidecar address and service-token paths are already wired in
Compose. Adding differently named copies to `.env` does not override hardcoded
Compose values. `CONVERSATION_SYSTEM_PROMPT` is an optional supported text
override; leave it at the default for the first test.

## 3. Enable Craig playback with an override

The base Craig overlay hardcodes playback to false. A `.env` entry named
`MEETING_PLAYBACK_ENABLED` has no effect on that literal. Save this separate,
non-secret file outside the checkout as `/secure/botik-voice.yaml`:

```yaml
services:
  craig-bot:
    environment:
      MEETING_PLAYBACK_ENABLED: "true"
      MEETING_PLAYBACK_URL: ws://meeting-platform:4310/v1/craig/playback
```

It uses the existing shared Craig integration bearer and internal network.
It does not expose the playback socket publicly.

## 4. Start all dependencies

```sh
node infra/deployment/run-verified-compose.mjs --env-file /secure/botik.env -- \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.craig.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml \
  -f infra/deployment/compose.hosted-summary.yaml \
  -f /secure/botik-voice.yaml \
  --profile hosted-summary --profile conversation up --build --detach --wait
```

Both profiles matter: `conversation` starts Pipecat; `hosted-summary` starts the
subscription sidecar used by the default voice profile. Extend inspection
commands with the same files and profiles. Pipecat's socket health probe only
proves its listener is up, not successful generation/TTS/playback.

## 5. Check an addressed answer

In the private test setup, address Botik explicitly with a short synthetic
question. Confirm exactly one spoken answer, expected language and audible
non-silent output, then check that normal recording and final transcription
still work. Follow the [private voice verification runbook](../operations/real-e2e-runbook.md)
for formal timing, interruption, reconnect or recording-track claims.

If silent, inspect Platform, Pipecat, sidecar and Craig logs separately. Check
runtime authentication, provider/voice access and the Craig playback override.
Do not treat a successful model response as proof that Discord received audio.

## Disable voice

Stop the affected services, set `CONVERSATION_ENABLED=false`, remove the voice
override and the `conversation` profile, then redeploy. Explicitly stop the
previous `pipecat-runtime` container if it remains from the earlier configuration.
Keep hosted-summary enabled if summaries still use it. Preserve recordings and
runtime credentials; do not remove data as part of toggling the feature.
