---
id: ADR-0072
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0072: Diagnostic index readiness before question reservation

Quality Campaign owns diagnostic-index-readiness.ts within the existing closed
quality-campaign adapter boundary. It extends ADR-0069: an applied SDK process
mutation acknowledges indexing intent, while asynchronous dense projection may
still be unqualified. The installed diagnostic runner must pass a fresh full
retrieval profile readiness barrier before reserving any question or model effect.

Read-only official SDK capability probes wait at most ten minutes, with two-second
request deadlines and one-second bounded backoff only for explicit temporary
required-lane health. SDK retries remain disabled. A transport observer compares
public immutable identity even when the SDK rejects unhealthy capability bytes.
For retry classification only, restoring required-lane health must reconstruct
the frozen fingerprint. Only unmodified SDK-validated healthy capability can
succeed, with exact profile, fingerprint, index digest, revision and required lanes.
Foreign identity, malformed capability and request failures terminate safely.

Every invocation retains create-only preparation timing and safe failure codes.
Preparation latency is separate from question retrieval latency. Failed preparation
creates no question outcomes or reservations; it preserves the applied index so
the same installation can resume without reingestion. The forty-question denominator,
Terra/low/default profile, gold separation, question budgets and exactly-once
original/repair reservations remain unchanged. Past readiness receipts never bypass
fresh invocation checks or each question's existing capability attestation.

Synthetic integration tests exercise queued-to-ready projection, timeout, malformed
and foreign bindings, zero question effects on failure, same-index resume and
separate latency. This decision makes no new service or quality qualification claim.
