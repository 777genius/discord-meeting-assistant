# Discord AI Meeting Assistant

Summary-first meeting intelligence for Discord. The system records through an
isolated Craig fork, produces a speaker-attributed final transcript, generates an
evidence-backed summary, and publishes it to Discord.

## Current phase

This repository contains the executable V1 vertical slice and its architecture
governance. The deployed flow is:

```text
authoritative Craig multitrack recording
  -> checksummed per-speaker artifact import
  -> post-call transcription
  -> final speaker-attributed transcript
  -> evidence-backed summary
  -> idempotent Discord publication
```

Live voice conversation is deliberately outside V1. Its future boundaries are
preserved through consumer-owned ports; Pipecat, realtime STT, TTS, and RAG must
not enter the meeting domain.

## Repository boundary

- The Craig fork is a separate Voice Gateway repository and keeps its upstream
  recording path authoritative.
- This repository owns Meeting Core, post-call processing, summary generation,
  publishing, and their contracts.
- Provider and transport details enter only through adapters and composition.

See [architecture overview](docs/architecture/overview.md),
[dependency rules](docs/architecture/dependency-rules.md), and
[decisions](docs/decisions/README.md).

## Discord guild onboarding

Meeting Platform generates and logs a least-privilege official Discord install
URL. It also serves the same redirect at internal `GET /discord/install` for a
deployment that reverse-proxies only that path. The current Meeting Platform and
isolated Craig Voice Gateway processes share one official bot identity, so this
is one installation step. Deployments using a distinct Craig identity can expose
its explicit second redirect from internal `GET /discord/install/craig`.

After the required application identity is installed, a server administrator runs `/setup`,
selects the recorded voice channel and the text results channel, and receives an
ephemeral result. The command verifies `Manage Guild`, both bots' effective
channel permissions, and a visible test publication before storing the
guild-scoped route. No Discord user access token or OAuth callback is used.

## Development

Required versions:

- Node.js `24.18.0`;
- pnpm `11.18.0`.

Install and run every local gate:

```bash
pnpm install --frozen-lockfile
pnpm run check
```

The private real-Discord acceptance flow, Russian/English synthetic fixtures,
recovery checks, and retained-evidence verifier are documented in the
[E2E runbook](docs/operations/real-e2e-runbook.md).

`@agent-teams/engineering-foundation` is an exact development-only dependency.
Production code must never import it.
