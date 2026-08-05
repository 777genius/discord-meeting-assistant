---
id: ADR-0005
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0005: Dedicated subscription account custody

Status: Accepted

Date: 2026-08-02

## Context

A read-only audit of the authorized hosted `social-monitor` deployment confirmed
that its hardened implementation uses `@vioxen/subscription-runtime` through
the versioned `RunAgentTask` and `CheckHealth` gRPC contract. It deliberately
removes every `*_API_KEY` and `*_API_KEY_FILE` from the child environment.

The host account pool does not provide a host-wide exclusive execution lease.
`social-monitor` owns only a project-local lease and mutable `auth-current`
state. Sharing that directory would permit OAuth refresh and session-chain
races between projects.

## Decision

V1 reserves a dedicated account slot or subset in the host allocation registry.
The allocation step atomically materializes only the reserved account into the
private runtime directory owned by the Meeting Assistant subscription-runtime
sidecar. `social-monitor` must exclude the reservation from its candidates.

The Meeting Platform application never mounts or reads account credentials.
The sidecar exclusively owns its auth copy, encrypted state, key, cursor,
leases, and volumes. No `social-monitor` mutable volume is shared. The
application reaches the sidecar over an authenticated, non-published internal
gRPC endpoint and uses purpose `discord_meeting.summary.generate` with a
stateless completion profile, disabled tools, isolated empty working directory,
structured prompt, JSON Schema, result hash, and execution attestation.

The deployment pins the audited runtime artifact and verifies its launcher
digest. Provider failures are mapped to safe retry classes such as
`quota_limited`, `needs_reconnect`, `provider_session_invalid`, and timeout;
provider payloads and account identities never cross the adapter boundary.

The long-term target is a host-wide Subscription Runtime Gateway that alone
owns all account sessions and leases. It is not required for V1 because it also
requires migrating existing consumers.

## Consequences

- `OPENAI_API_KEY` remains absent from the application and deployment.
- Direct mounting of `social-monitor/auth-current` is forbidden, including in
  production E2E.
- Account reuse is explicit and race-free rather than an implicit shared file.
- Summary idempotency is keyed by meeting ID, transcript revision, and summary
  policy version.
- Losing the runtime delays summary processing without affecting recording or
  final transcript durability.
