# Dependency rules

## Direction

```text
domain <- application <- adapters <- composition
                 ^
              contracts are boundary-specific
```

- Domain imports only domain-level APIs inside its bounded context; it never
  imports application or adapter code.
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

## Meeting Core feature rules

- A source file belongs to exactly one module under
  `packages/meeting-core/src/features`.
- Cross-feature imports use only the provider feature's `index.ts` entrypoint.
- External consumers import an explicit `@discord-meeting/meeting-core/*`
  subpath; the package root is not a public API.
- Each production consumer boundary has an explicit Meeting Core feature
  subpath allowlist. Unknown consumers, root imports, and unknown or deep
  subpaths fail the repository-local architecture gate.
- Each feature owns its use-case ports, failure vocabulary, and validation
  errors. A universal result or error module is forbidden.
- Feature dependencies are directional and declared fail-closed in Foundation.
- Tests mirror feature ownership under `packages/meeting-core/test/features`.

## External systems

Craig, Discord, PostgreSQL, object storage, queues, STT, LLMs, telemetry, and the
optional Pipecat runtime are adapter or composition concerns. Core source must not
branch on provider names.

## Enforcement

`@agent-teams/engineering-foundation` owns the closed source graph. Every file
under a governed root must belong to exactly one opaque boundary and may use only
declared boundary, package, builtin, and runtime-reference edges.

Foundation 0.6.0 classifies an external Meeting Core subpath as a workspace
package edge, so it does not retain the target feature boundary. The narrow
`meeting-core-consumer-subpaths.json` policy and architecture-baseline verifier
supplement Foundation for that one package. They validate the exact exported
feature surface and enforce consumer-specific subpaths across static, type,
dynamic, export-from, and import-equals syntax.

Foundation 0.6.0 also treats governed test imports as runtime imports, which
would incorrectly require Vitest to become a production dependency and blocks
Meeting Core's intentional public self-import. Meeting Knowledge test ownership
is therefore enforced by the repository-local architecture-baseline verifier:
the exact feature test path must exist and may contain only test source files.

The first production change must extend governed roots beyond current tooling.
An unclassified source file, unresolved import, cross-package relative import,
undeclared dependency, blocked export, or parser error is a failing gate.

Ast-grep separately rejects ambient wall clock, environment, randomness, and
timers in domain and application paths. TypeScript remains the type authority;
Oxlint supplies fast and type-aware lint checks.
