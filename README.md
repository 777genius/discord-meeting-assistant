# Botik - AI Meeting Assistant for Discord

**Turn every Discord voice meeting into clear, reliable team memory.**

Botik records your meeting and publishes the result directly to Discord. The
default self-hosted `transcript-outline` reports only the authoritative turn
count and attaches the speaker-attributed transcript. Rich decisions, action
items, open questions, and narrative summaries require optional hosted
generation and are not part of that default.
Optional live features add captions, an evolving summary, voice conversation,
grounded Q&A, historical meeting memory, and private recording playback.

[**Self-host Botik with two user-owned Discord applications**](infra/deployment/oss-meeting-topology.md)

## See the Discord result

The final post stays compact: it shows the meeting notes and attaches
`meeting-summary.md` plus the complete `meeting-transcript.md`. The transcript
is not repeated in the message body. A private recording link appears when
playback is enabled.

| Summary and attachments | Actions, questions, and recording | Transcript | Recording |
| :---: | :---: | :---: | :---: |
| <img src="https://github.com/user-attachments/assets/820f6a34-6f18-4577-9828-a3c557b4a624" alt="Botik meeting summary with attached full summary and transcript" width="100%"> | <img src="https://github.com/user-attachments/assets/7d6b9613-e257-4970-a273-056cd45aef11" alt="Botik action items, open questions, and meeting recording link" width="100%"> | <img width="100%" alt="image" src="https://github.com/user-attachments/assets/f3465217-c314-4ddc-9cc7-0a6388945887" /> | <img width="741" height="398" alt="image" src="https://github.com/user-attachments/assets/c3fb02a2-9dce-422e-8741-5b4e1f7cd0a9" /> |



## What Botik does

| Capability | What your team gets | Availability |
| --- | --- | --- |
| Automatic recording | Recording starts when people join the configured voice channel. | Core flow |
| Transcript outline | Authoritative turn count plus the complete transcript attachment; no inferred decisions or actions. | Core self-hosted flow |
| Rich final summary | Overview, decisions, action items, owners, deadlines, and unresolved questions. | Optional hosted generation |
| Full transcript | Every final result attaches a complete Markdown transcript with speakers and timestamps. | Core flow |
| Live captions and brief | One Discord post follows the conversation and updates key topics, decisions, actions, and questions during the call. | Optional live mode |
| Voice assistant | Address Botik for a spoken answer that can be interrupted. Optional greetings and farewells make the assistant present throughout the call. | Optional live mode |
| Grounded meeting Q&A | Reply to the current final Botik post, or ask by voice when enabled, for an answer tied to accepted transcript evidence. Botik abstains when evidence or authorization is insufficient. | Optional, rollout-gated |
| Historical meeting memory | Ground answers in authorized previous meetings from the same configured room. | Optional, requires qualified memory serving |
| Recording playback | Open a private signed link to a synchronized browser player. | Optional deployment feature |
| Output presentation | Discord labels and attachments support English, Russian, or Ukrainian; generated title and overview language depends on the selected summary provider. | Depends on the feature |
| Speech recognition | Recognition languages depend on the selected provider and model. The configured batch/live adapters are implemented and conformance-tested, but this exact OSS revision has no retained provider-quality qualification evidence. | Provider/model-dependent; exact-revision qualification pending |

This is not a claim that any configured provider supports only those languages.

Optional capabilities are enabled independently by each deployment. The core
post-call flow does not depend on live voice, historical memory, or playback.
Meeting Platform talks only to the versioned VoiceText contract; configured
speech providers are implemented, conformance-tested adapters behind the
self-hosted gateway. The Rust domain/application ports are provider-agnostic.
Those tests establish contract behavior only: real acoustic qualification
requires retained receipts bound to the exact provider, model, and source
revision. A new public V1 profile still requires an explicit identity/config
addition in gateway composition and the Discord consumer.

## How it works

1. **Install and choose your channels.** A server administrator runs
   `/setup-voice-bot`, then selects one voice channel to record and one text
   channel for results. Botik checks permissions and posts a test message before
   saving the setup.
2. **Meet as usual.** Recording starts automatically when people join. When live
   mode is enabled, captions and the meeting brief stay in one Discord post
   instead of flooding the channel.
3. **Leave with a complete handoff.** After the call, Botik reconciles the live
   draft, when present, with the full recording, publishes the minimal outline
   or an optionally hosted rich summary, and attaches the complete transcript
   without duplicate messages. Playback-enabled deployments also include a
   private recording link.

## Built for trustworthy meeting notes

- **Generated claims stay connected to the conversation.** When optional rich
  generation is enabled, decisions and action items must reference real
  transcript turns. The default outline makes no such inferred claims.
- **The recording remains the source of truth.** Live captions are useful during
  the call, but the final transcript is produced from the original per-speaker
  recording.
- **Failures do not erase the meeting.** A transcription, summary, or publishing
  failure cannot delete or invalidate the original recording.
- **Retries do not create duplicate results.** Post-call stages and Discord
  publication use stable identities and reconcile uncertain outcomes.
- **Discord access stays narrow.** Setup uses an official bot installation,
  requires `Manage Server`, verifies channel permissions, and never asks for a
  Discord user token.

## Set up your Discord server

1. Create two official applications in the Discord Developer Portal: a
   user-owned Craig recording application and a separate user-owned Meeting
   Platform publication application. Create one test bot for each application
   when qualifying the deployment.
2. Configure their distinct application IDs and token files as described in the
   [self-host topology](infra/deployment/oss-meeting-topology.md), then install
   both applications in an operator-owned private guild. Never use a user token,
   self-bot, public guild, or a project-operated application ID.
3. Open any text channel and run `/setup-voice-bot` with the publication bot.
4. Select the voice channel to record and the text channel that should receive
   final results and, when enabled, live updates.

The canonical deployment uses two official applications and two installations:
one user-owned Craig voice bot and one Meeting Platform publication bot. Their
application IDs and token files are always distinct.

## Current status

This repository contains the executable V1 vertical slice and production
packages. The complete recording-to-transcript-outline flow is self-hostable;
rich generation is implemented as an optional hosted lane. Live voice, grounded
Q&A, historical memory, and playback are separately enabled, fail-closed
capabilities while the project remains under active development.

## Technical overview

```text
original multitrack recording
  -> checksummed per-speaker audio
  -> final transcription
  -> speaker-attributed transcript
  -> minimal transcript outline (default) or evidence-backed summary (optional)
  -> idempotent Discord publication
```

The original Craig recording, final transcript, and meeting database are the
authoritative evidence. Live captions and incremental summaries are derived
views and never replace them.

### Repository scope

- The isolated Craig fork is a separate Voice Gateway repository and owns
  Discord voice transport plus the authoritative multitrack recording.
- This repository owns Meeting Core, live conversation, post-call processing,
  transcription, meeting knowledge, summary generation, recording playback,
  Discord publication, and their contracts.
- Provider and transport details stay behind adapters so the meeting model is
  not tied to Craig, Discord, a specific speech provider, or an LLM SDK.

Start with the [architecture overview](docs/architecture/overview.md),
[dependency rules](docs/architecture/dependency-rules.md),
[testing strategy](docs/architecture/testing-strategy.md), and
[accepted decisions](docs/decisions/README.md).

### Transcription providers

Authoritative batch transcription and derived live transcription are selected
independently:

- `VOICETEXT_BATCH_PROFILE`: `deepgram-nova-3` (default) or
  `elevenlabs-scribe-v2`;
- `VOICETEXT_LIVE_PROFILE`: `deepgram-nova-3` (default) or
  `elevenlabs-scribe-v2-realtime`.

Invalid values stop startup. Provider credentials, endpoints, health probes,
names, and SDK types are never exposed to Discord.

## Development

Required versions:

- Node.js `24.18.0`;
- pnpm `11.18.0`.

Install dependencies and run the complete repository check:

```bash
pnpm install --frozen-lockfile
pnpm run check
```

Use `pnpm run check:changed` for quick feedback while editing and
`pnpm run check:fast` before handoff. The complete `pnpm run check` remains the
authoritative pull-request gate.

Private real-Discord acceptance, Russian and English synthetic fixtures,
recovery checks, and retained-evidence verification are documented in the
[E2E runbook](docs/operations/real-e2e-runbook.md).

Those historical/private campaign procedures and any evidence retained outside
this public checkout do not qualify the current OSS revision. EN/RU acoustic
quality and all four provider/mode profiles remain pending until a campaign
receipt binds the exact Meeting Platform and VoiceText source revisions.

`@agent-teams/engineering-foundation` is an exact development-only dependency.
Production code must never import it.
