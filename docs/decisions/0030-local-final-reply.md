---
id: ADR-0030
status: superseded
supersedes: []
superseded_by: [ADR-0049]
---

# ADR-0030: Memory-backed grounded final reply

## Status

Accepted on 2026-08-13.

## Context

ADR-0027 established provider-neutral meeting source and actor identity but did
not authorize questions, expose transcript evidence, call a model, or publish an
answer. A reply feature has two independent unknown-outcome boundaries: model
generation and Discord message creation. It also handles sensitive question and
transcript text, so an ordinary retry loop or a summary-as-evidence shortcut
would create unsupported answers or duplicate external effects.

## Decision

- Meeting Knowledge owns exact-current-final question admission, immutable
  evidence binding, deterministic locale, explicit grounding plans, grounded
  claims, citations, and the collapsed durable QuestionJob vocabulary.
- Its application layer depends only on the consumer-owned
  `FinalReplyEvidencePort`, `FocusedMemoryRetrievalPort`, `QuestionAuthorizationPort`,
  `QuestionAdmissionCommitPort`, `QuestionJobStore`,
  `GroundedAnswerGenerator`, and `AnswerPublicationPort`. Boundary DTOs contain
  primitives and feature-owned values; Discord, PostgreSQL, and Subscription
  Runtime types remain outside Meeting Knowledge.
- Every ordinary current-final question uses `focused_retrieval`. Retrieval
  crosses the application boundary as bounded references without text and must
  attest the exact generation derived from the bound canonical transcript.
  Meeting Knowledge then reloads only those references from local authoritative
  state and assigns question-local opaque evidence IDs. A pending or stale
  generation returns fixed localized `processing`; unavailable retrieval returns
  `unavailable`; low coverage returns `insufficient_evidence`. No complete
  transcript, transcript prefix, summary prose, candidate-locator text, or
  fallback form of those values may enter an answer-model prompt.
- The first production candidate locator is a deterministic PostgreSQL adapter
  that scans the immutable accepted release locally and emits reference/hash
  identities only. It is replaceable through the consumer-owned port. This ADR
  adds no Infinity SDK, synchronization worker, remote text trust, or voice path.
- Authorization uses a short-lived opaque principal reference and a separate
  keyed requester subject. Fresh observations are required before evidence
  hydration, provider execution, answer reservation, and the send CAS. Atomic
  PostgreSQL admission verifies the still-current meeting, transcript,
  projection, roster, and policy while reserving dedupe and rate capacity. The
  immutable binding includes the canonical human roster, so later authority
  checks fail closed if actor membership changes without transcript replacement.
- Provider input is limited to the selected, locally rehydrated canonical turns,
  and exact request/token headroom is measured before the call. Provider output
  is strict structured data. An answered result has one through
  twelve bounded claims and every claim cites admitted human evidence. Unknown
  fields, unsupported evidence IDs, unsafe output, stale bindings, malformed
  attestation, and incomplete coverage fail closed. Canonical evidence is
  reloaded before all-or-nothing one-message rendering.
- Subscription Runtime gains two dedicated Sol/medium, stateless, tools-disabled
  purposes: `discord_meeting.knowledge.answer.v1` and
  `discord_meeting.knowledge.coverage_extract.v1`. Summary and conversation
  profiles cannot satisfy either purpose.
- Publishing owns immutable answer effects separately from summary publication.
  After a durable `request_started` transition, exactly one Discord create call
  is authorized with automatic client retries disabled. Ambiguous outcomes are
  reconciled by immutable marker and payload identity and never authorize a
  second create.
- PostgreSQL owns QuestionJob/admission durability and Publishing effect
  durability through purpose-specific tables and migrations. Discord owns
  ingress filtering, opaque-principal resolution, permission observations, one
  create attempt, and remote reconciliation. Composition alone selects these
  adapters and rollout limits.

## Consequences

- Replies to live, stale, unrelated, or legacy projections create no job.
- Candidate lookup and transcript rehydration occur only after positive
  participant and channel authorization. Authorization, memory generation, job
  generation, or binding drift cancels and scrubs pre-send work.
- A provider or Discord failure cannot alter the recording, accepted transcript,
  summary, or current final projection.
- Sensitive question, principal, evidence, model output, and rendered payload
  data are scrubbed at terminal settlement or expiry while minimal hashes and
  remote receipts remain available for reconciliation.
- Infinity SDK/synchronization, historical serving, configured Q&A roles,
  arbitrary messages, and voice playback remain separate slices.
