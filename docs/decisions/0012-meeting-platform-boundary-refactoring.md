---
id: ADR-0012
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0012: Meeting Platform transport and runtime boundary refactoring

## Status

Accepted. This decision governs the implemented refactoring and does not
authorize a product-scope expansion.

## Context

Meeting Platform currently combines composition, HTTP transport, Craig ingress,
operations endpoints, Discord installation routes, and derived live-meeting
orchestration in a small number of large modules. That makes a new REST endpoint
touch unrelated responsibilities and permits provider vocabulary to leak toward
high-level runtime coordination.

The product must retain its authoritative-recording invariants while making the
external REST surface grow independently. Its current live ingress holds
process-local state and locks, so adding replicas without explicit ownership
would create duplicate work and split meeting state.

## Decision

Refactor Meeting Platform in vertical, independently releasable steps into the
following source-dependency boundaries with explicit public entrypoints:

- `composition` selects concrete adapters and owns process assembly only.
- `http` owns the `PlatformHttpHost` lifecycle contract and route registration.
  Fastify is the first outer HTTP adapter. Operations, Discord installation, and
  Craig routes are separate modules so new REST endpoints do not modify a
  central request switch.
- `craig-ingress` is a concrete inbound anti-corruption adapter. It alone may
  use Craig request/response types and maps them to consumer-owned lifecycle and
  packet inputs before application or live-runtime coordination.
- `operations-http` owns health, readiness, and metrics endpoints.
- `discord-install-http` owns public installation and configuration routes.
- `live-runtime` coordinates derived live transcription, projection, summary,
  conversation, and lifecycle handoff through small consumer-owned ports. It
  must not import Discord, Craig, Voicetext, Fastify, or other provider-specific
  types directly.

Fastify remains an outer adapter, not application vocabulary: domain and
application code receive no Fastify types. Replacing it or adding gRPC creates
another inbound adapter and reuses the same application inputs. Do not add
NestJS, a service locator, or a generic in-house HTTP framework.

The deployment remains explicitly singleton for stateful recording ingress and
live-meeting ownership until a dedicated scale-out design is implemented. That
design must route every record or meeting ID to one owner, acquire durable
leases with fencing tokens, replace process-local projection locks with
distributed locks, and retain idempotent outbound publication. Replicas are not
an accepted shortcut before those mechanisms and their recovery tests exist.

After the responsibilities are decomposed, enable Foundation's production and
test maintainability presets globally without grandfather exclusions. Refactor
until production code satisfies the configured file, function, complexity,
depth, and parameter budgets; temporary suppressions remain governed and
time-bounded.

## Consequences

- New REST endpoints extend a focused route module rather than the composition
  root or live-runtime coordinator.
- Craig remains visible as a product integration at the inbound edge, but it
  cannot become application or domain language.
- HTTP transport and providers can change without changing use cases or domain
  invariants.
- Live ingress is honest about its current single-owner limit, with a concrete
  route to horizontal scale instead of unsafe replica configuration.
- The Foundation source graph, entrypoints, and maintainability checks become
  executable guards for the refactoring rather than documentation only.
