# Dependency rules

## Direction

```text
domain <- application <- adapters <- composition
                 ^
              contracts are boundary-specific
```

- Domain imports only its own domain modules.
- Application imports its own domain and ports.
- Boundary contracts use primitives and contract-owned types.
- Inbound adapters translate external requests into application input.
- Outbound adapters implement consumer-owned application ports.
- Composition may import every layer needed to assemble one process.

Contracts are not a shortcut around dependency direction. Public transport DTOs,
integration events, application models, and domain events are distinct surfaces.

## Cross-context rules

- No domain-to-domain imports across bounded contexts.
- Synchronous collaboration uses a consumer-owned port and anti-corruption
  adapter over the provider's published API.
- Asynchronous collaboration uses a producer-owned versioned fact and an
  idempotent consumer.
- One transaction mutates authoritative state in one bounded context.
- Technical reuse is allowed for stable mechanics; business language is not
  deduplicated across contexts merely because fields look similar.

## External systems

Craig, Discord, PostgreSQL, object storage, queues, STT, LLMs, telemetry, and the
future Pipecat runtime are adapter or composition concerns. Core source must not
branch on provider names.

## Enforcement

`@agent-teams/engineering-foundation` owns the closed source graph. Every file
under a governed root must belong to exactly one opaque boundary and may use only
declared boundary, package, builtin, and runtime-reference edges.

The first production change must extend governed roots beyond current tooling.
An unclassified source file, unresolved import, cross-package relative import,
undeclared dependency, blocked export, or parser error is a failing gate.

Ast-grep separately rejects ambient wall clock, environment, randomness, and
timers in domain and application paths. TypeScript remains the type authority;
Oxlint supplies fast and type-aware lint checks.
