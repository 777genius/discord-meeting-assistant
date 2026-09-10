# Get started

[Documentation](README.md) · [Botik](../README.md)

Botik is self-hosted. You run the server and storage, create two Discord bot
applications and supply your own speech-provider credentials. External providers
may charge for usage.

1. [Choose your scenario](self-hosting/README.md).
2. [Prepare and install the base stack](self-hosting/installation.md).
3. [Provision storage and secret files](self-hosting/storage-and-secrets.md).
4. [Install the Discord bots and verify a first meeting](self-hosting/discord.md).
5. Add [live captions](self-hosting/transcription.md), [AI summaries](self-hosting/ai-summaries.md),
   [voice answers](self-hosting/voice-answers.md) or [recording playback](self-hosting/recording-playback.md) as needed.

The base result is a full transcript with speaker names and timestamps plus a
turn-count outline. AI generation needs an additional public source-built runtime image;
[meeting memory](self-hosting/meeting-memory.md) has separate serving gates.
Read each feature's prerequisites before choosing it.

For day-to-day maintenance, use [Operations](self-hosting/operations.md) and
[Troubleshooting](self-hosting/troubleshooting.md). The detailed
[Compose topology](../infra/deployment/oss-meeting-topology.md) and
[acceptance record](../infra/deployment/oss-acceptance.md) retain deployment
contracts and exact tested capabilities.
