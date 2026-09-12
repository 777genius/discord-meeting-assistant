![Botik: voice meetings, transcripts and action items](docs/assets/botik-cover.webp)

# Botik - Self-hosted Meeting Assistant for Discord

Run Botik on your own server with your own Discord bots and provider credentials.
It records Discord meetings, shows live captions, posts a transcript and a
summary, and answers questions on that summary.

[Get started](docs/getting-started.md) · [See examples](docs/preview.md) · [Documentation](docs/README.md)

| Summary and attachments | Actions, questions, and recording | Transcript | Recording |
| :---: | :---: | :---: | :---: |
| <img src="https://github.com/user-attachments/assets/9b286efe-ce60-401e-850b-61b53f74a455" alt="Botik meeting summary with attached full summary and transcript" width="100%"> | <img src="https://github.com/user-attachments/assets/7d6b9613-e257-4970-a273-056cd45aef11" alt="Botik action items, open questions, and meeting recording link" width="100%"> | <img src="https://github.com/user-attachments/assets/f3465217-c314-4ddc-9cc7-0a6388945887" alt="Botik meeting transcript" width="100%"> | <img src="https://github.com/user-attachments/assets/c3fb02a2-9dce-422e-8741-5b4e1f7cd0a9" alt="Botik meeting recording playback" width="100%"> |

## What it does

- **Records automatically** when people join the configured voice channel.
- **Shows live captions** during the call.
- **Posts the full transcript** to Discord after the meeting.
- **Publishes a summary** with action items, then answers questions on it.
- **Optional:** voice answers in the call and recording playback.

Speech-to-text is tested on Deepgram and ElevenLabs. You can also use a local
model, such as Whisper. For AI answers, you can use an API, a subscription, or
a local model.

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
