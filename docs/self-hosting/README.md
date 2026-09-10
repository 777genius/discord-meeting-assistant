# Self-hosting Botik

[Documentation](../README.md) · [Botik](../../README.md)

Botik runs on your own server, with your own Discord applications, storage and
provider credentials. Self-hosting does not mean offline operation: Discord and
the selected speech/AI providers receive the data needed for their work and may
charge for usage.

## Choose a scenario

| I want to… | Start here | What I get |
| --- | --- | --- |
| Record meetings and read the transcript | [Install](installation.md) → [Discord setup](discord.md) | Original recordings and a final transcript with speakers and timestamps |
| See captions during a meeting or use ElevenLabs | [Transcription](transcription.md) | Optional live captions; independent batch/live provider selection |
| Get decisions, action items and an AI summary | [AI summaries](ai-summaries.md) | Optional generation through an operator-managed Subscription Runtime |
| Talk to Botik in voice | [Voice answers](voice-answers.md) | Optional conversation runtime and spoken replies |
| Open a recording player from Discord | [Recording playback](recording-playback.md) | HTTPS links to a synchronized player |
| Ask about previous meetings | [Meeting memory](meeting-memory.md) | Setup prerequisites and current serving restrictions; not a generally enabled feature |
| Upgrade, back up or investigate a failure | [Operations](operations.md), [Troubleshooting](troubleshooting.md) | Maintenance and recovery procedures |

Follow the base installation first, then add one optional feature at a time.
The base output is a transcript plus a count of transcript turns. It does not
include generated topics, decisions or action items.

## What these guides establish

Commands are based on the repository's Compose files and configuration. The
[acceptance record](../../infra/deployment/oss-acceptance.md) identifies the
Discord and provider scenarios actually tested. A documented configuration is
not evidence that every optional combination has passed a fresh installation
or provider-backed test. Each optional guide states its prerequisites and limits.

Use a separate private test guild and synthetic audio for your first verification.
The qualification controller and hosted development workers are not application
prerequisites. Do not copy internal test identities or campaign configuration.
