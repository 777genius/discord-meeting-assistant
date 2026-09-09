# Documentation

[Back to Botik](../README.md)

## Use Botik

- [Get started](getting-started.md): requirements and first meeting.
- [Examples](preview.md): summaries, transcripts and playback.
- [Speech providers](speech-providers.md): batch, live and languages.
- [Tested capabilities and limitations](../infra/deployment/oss-acceptance.md).

## Run Botik

- [Installation and backups](../infra/deployment/oss-meeting-topology.md).
- [Speech gateway configuration](../infra/deployment/voicetext-gateway.md).
- [Deployment options](../infra/deployment/README.md).
- [Greeting ledger retention](operations/greeting-ledger-retention.md).
- [Meeting memory retrieval baseline](operations/meeting-memory-retrieval-baseline.md).

## Develop Botik

- [Development](development.md): tools and checks.
- [Architecture](architecture/overview.md) and [dependency rules](architecture/dependency-rules.md).
- [Testing strategy](architecture/testing-strategy.md) and [private Discord E2E](operations/real-e2e-runbook.md).
- [Suppression governance](architecture/suppression-governance.md).
- [Architecture decisions](decisions/README.md).
- [Meeting Knowledge Q&A plan](plans/meeting-knowledge-qa-v1.md).
- [Meeting memory retrieval migration](plans/meeting-memory-retrieval-boundary.md).

## Keep documentation focused

README is the entry point. Keep details in a page for one topic and link to it.
Update the existing source instead of copying instructions between pages.
Architecture documents own current rules; ADRs own accepted decisions;
implementation plans track delivery. Executable rules live in `architecture/`.
