![Botik: voice meetings, transcripts and action items](docs/assets/botik-cover.webp)

# Botik - Meeting Assistant for Discord

Record Discord meetings and get a transcript with speaker names and timestamps.
Add live captions, AI summaries and voice answers when you need them.

[Get started](docs/getting-started.md) · [See examples](docs/preview.md) · [Documentation](docs/README.md)

## What it does

- **Records automatically** when people join the configured voice channel.
- **Posts the full transcript** to Discord after the meeting.
- **Adds optional extras:** live captions, AI notes, voice answers, meeting memory and recording playback.

The default setup includes a transcript and a simple turn-count outline.
AI features and playback need extra configuration. Original recordings remain
available if transcription or publishing fails.

## Get started

Self-host Botik with two Discord bots and a speech provider key.
Follow the [setup guide](docs/getting-started.md), then run `/setup-voice-bot`
to choose your voice channel and where results appear.

## Learn more

- [Speech providers and language support](docs/speech-providers.md)
- [Tested capabilities and limitations](infra/deployment/oss-acceptance.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture/overview.md)
