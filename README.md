![Botik: voice meetings, transcripts and action items](docs/assets/botik-cover.webp)

# Botik - Self-hosted Meeting Assistant for Discord

Run Botik on your own server with your own Discord bots and provider credentials.
Record Discord meetings and get a transcript with speaker names and timestamps.
Add live captions, AI summaries and voice answers when you need them.

[Get started](docs/getting-started.md) · [See examples](docs/preview.md) · [Documentation](docs/README.md)

## What it does

- **Records automatically** when people join the configured voice channel.
- **Posts the full transcript** to Discord after the meeting.
- **Adds optional extras:** live captions, AI notes, voice answers, meeting memory and recording playback.

The default setup includes a transcript and a simple turn-count outline.
AI summaries and voice answers build from the public
[`777genius/ar`](https://github.com/777genius/ar) source, but still require
operator-owned authorized Codex subscription sessions and account-pool setup.
Playback also needs extra configuration; follow the
[feature guides](docs/optional-features.md). Original recordings remain available
if transcription or publishing fails.

## Get started

Self-host Botik with two user-owned Discord applications and a speech provider key.
Follow the [setup guide](docs/getting-started.md), then run `/setup-voice-bot`
to choose your voice channel and where results appear.

## Learn more

- [Self-hosting scenarios and configuration](docs/self-hosting/README.md)
- [Speech providers and language support](docs/speech-providers.md)
- [Tested capabilities and limitations](infra/deployment/oss-acceptance.md)
- [Development](docs/development.md)
- [Architecture](docs/architecture/overview.md)
- [Security policy](SECURITY.md)

## License

[Apache License 2.0](LICENSE). Third-party attributions are listed in
[NOTICE](NOTICE).
