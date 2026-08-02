# Agent navigation and guardrails

Read these before changing the repository:

1. [Architecture overview](docs/architecture/overview.md)
2. [Dependency rules](docs/architecture/dependency-rules.md)
3. [Testing strategy](docs/architecture/testing-strategy.md)
4. [Accepted decisions](docs/decisions/README.md)

## Current phase

The repository contains an executable architecture baseline but no production
packages. Do not create empty DDD folders or speculative packages. A production
package may be added only together with one real vertical slice, an owner, tests,
and its closed source-dependency classification.

## Hard rules

- Domain code is deterministic and depends on no framework, transport, database,
  provider SDK, wall clock, environment, randomness, or timer.
- Application code depends on domain and consumer-owned ports.
- Contracts expose versioned boundary data, never aggregates or infrastructure
  types.
- Adapters implement ports. Composition is the only place concrete dependencies
  are selected.
- Craig, Discord, STT, LLM, object storage, queue, and future Pipecat types cannot
  enter domain or application code.
- Cross-context collaboration uses a published contract or a consumer-owned port
  with an anti-corruption adapter. Never deep-import another context.
- The original Craig recording, final transcript, and meeting database are the
  authoritative evidence. Live transcript and generated summary are derived.
- A summary decision or action item must reference existing transcript turns.
- Failure in transcription, summary, or publishing must not delete or invalidate
  the original recording.
- Do not add a generic `shared`, `common`, `utils`, base repository, service
  locator, or universal event type.
- The engineering foundation is development-only and must use exact registry
  version `0.4.1`.

## Workflow

Before adding production source:

1. identify its bounded context and feature owner;
2. add the package path to the architecture decision and dependency model;
3. extend `architecture/foundation/source-dependencies.yaml` so every new source
   file is classified fail-closed;
4. add domain/application/contract tests before real external adapters;
5. run focused checks while editing and `pnpm run check` before handoff.

Development currently happens on `main`. Keep changes small and use Conventional
Commits when commits are requested.

## Test safety

Never test Discord voice flows with user accounts, self-bots, public guilds, or
real user projects. Real Discord E2E requires official bot applications, a private
test guild, test-only channels, test identities, and synthetic audio fixtures.
Run destructive infrastructure and recovery tests only against disposable data.
