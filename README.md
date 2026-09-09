# Botik - Meeting Assistant for Discord

Record voice meetings and get a speaker-attributed transcript directly in Discord.
Enable live captions, AI summaries or voice answers when you need them.

[**Set up Botik**](infra/deployment/oss-meeting-topology.md)

## Contents

- [Features](#features)
- [Preview](#preview)
- [Get started](#get-started)
- [Speech providers](#speech-providers)
- [Documentation](#documentation)
- [Development](#development)

## Features

- **Automatic recording:** starts when people join your configured voice channel.
- **Full transcripts:** speaker names and timestamps, attached to the final Discord post.
- **Live captions:** optional updates during the meeting.
- **AI summaries:** optional meeting notes, decisions and action items linked to transcript evidence.
- **Voice answers and meeting memory:** optional features configured separately.
- **Recording playback:** optional private links to listen again.

The default setup publishes a complete transcript and a simple turn-count outline.
AI summaries, voice features and playback require additional configuration.
Original recordings remain available if transcription or publication fails.

## Preview

Examples below include optional summaries and playback.

| Summary and attachments | Actions, questions, and recording | Transcript | Recording |
| :---: | :---: | :---: | :---: |
| <img src="https://github.com/user-attachments/assets/820f6a34-6f18-4577-9828-a3c557b4a624" alt="Botik meeting summary with attached full summary and transcript" width="100%"> | <img src="https://github.com/user-attachments/assets/7d6b9613-e257-4970-a273-056cd45aef11" alt="Botik action items, open questions, and meeting recording link" width="100%"> | <img width="100%" alt="image" src="https://github.com/user-attachments/assets/f3465217-c314-4ddc-9cc7-0a6388945887" /> | <img width="741" height="398" alt="image" src="https://github.com/user-attachments/assets/c3fb02a2-9dce-422e-8741-5b4e1f7cd0a9" /> |

## Get started

You will need:

- a server with persistent storage, Node.js `24.18.0`, Docker Compose `2.24.4+`
  and Docker Buildx `0.28.0+`;
- two user-owned Discord applications: one for recording and one for publishing;
- a Deepgram and/or ElevenLabs API key;
- a domain pointing to your server, with ports 80/443 available for HTTPS.

1. Clone this repository.
2. Follow the [Docker Compose setup](infra/deployment/oss-meeting-topology.md)
   to configure credentials, build the services and check their health.
3. Install both bots in your Discord server with the documented permissions.
4. Run `/setup-voice-bot` as a server administrator and choose the voice channel
   to record and the text channel for results.
5. Join the selected voice channel. After the meeting ends, Botik posts the result.

Keep bot tokens and provider keys in the mounted secret files described in the
setup guide. Speech recognition uses your selected provider's API and billing.

## Speech providers

Batch transcription uses the original recording; live transcription produces
captions during the call. Select them independently:

| Mode | Deepgram | ElevenLabs |
| --- | --- | --- |
| Batch | `deepgram-nova-3` | `elevenlabs-scribe-v2` |
| Live | `deepgram-nova-3` | `elevenlabs-scribe-v2-realtime` |

Set `VOICETEXT_BATCH_PROFILE` and `VOICETEXT_LIVE_PROFILE` in your deployment
configuration. Both default to Deepgram, so the default setup needs a Deepgram key.
If you only have an ElevenLabs key, set the batch profile to
`elevenlabs-scribe-v2` and the live profile to `elevenlabs-scribe-v2-realtime`
before starting the services.

Recognition languages and quality depend on the provider and model. Tests cover
synthetic Russian/English audio and Discord sequential speech, overlap and
reconnection. See the [results and limits](infra/deployment/oss-acceptance.md).
English, Russian and Ukrainian display labels are separate from speech recognition
support; Ukrainian speech has not been qualified.

## Documentation

- [Installation and backups](infra/deployment/oss-meeting-topology.md)
- [Speech gateway configuration](infra/deployment/voicetext-gateway.md)
- [Deployment options](infra/deployment/README.md)
- [Tested capabilities and limitations](infra/deployment/oss-acceptance.md)
- [Architecture](docs/architecture/overview.md)
- [Testing and E2E](docs/architecture/testing-strategy.md)

## Development

Use Node.js `24.18.0` and pnpm `11.18.0`:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

For faster feedback use `pnpm run check:changed` while editing and
`pnpm run check:fast` before handoff. Read the
[dependency rules](docs/architecture/dependency-rules.md) before changing code.
