---
id: ADR-0050
status: superseded
supersedes: []
superseded_by: [ADR-0064]
---

# ADR-0050: Persisted Retrieval V2 serving binding and official SDK custody

## Status

Accepted on 2026-08-24. This decision adds the consumer-side serving details
required to implement ADR-0049 without changing that accepted decision.

## Context

ADR-0049 assigns generic indexed retrieval to Infinity Context and keeps
authorization, authoritative evidence, citations, answer effects, and voice in
the meeting product. A production consumer still needs deterministic rules for
choosing the legacy or V2 path, preserving that choice across retries, binding
to an exact provider capability, consuming the official SDK, and rehydrating
locator-only results without restoring a second downstream retrieval engine.

Reconstructing a request from mutable environment after admission would let a
retry observe a different profile, source generation, query decomposition, or
budget. Depending directly on an arbitrary checkout of Infinity Context would
also make Discord builds non-reproducible. Passing remote text through the
adapter, or treating remote retrieval provenance as citation authority, would
violate the original recording and final transcript evidence boundary.

## Decision

### Durable path and request binding

Before a protocol-2 question job can execute, Meeting Knowledge persists one
immutable retrieval binding containing:

- `retrievalPath`, `profileFingerprint`, and `cutoverEpoch`;
- the exact Retrieval V2 provider binding and required lanes;
- opaque room scope and accepted source generations;
- bounded query variants, actor/time signals, filters, preferences, and
  request/evidence/deadline budgets.

Retries, lease recovery, and replacement workers reuse the persisted snapshot
verbatim. They do not rebuild it from environment, a new capability response,
or the current source catalog. A missing, malformed, stale, or policy-mismatched
binding fails closed. One job uses either the legacy path or Retrieval V2;
candidate sets are never merged.

The composition router selects the path only from the persisted binding. The
legacy selector remains a separately named migration path and is controlled by
an explicit policy switch. A calendar target for deletion is informational;
ADR-0049's drain, rollback-window, release, and unresolved-effect gates remain
mandatory.

While that legacy selector exists, its single qualified input limit is 24
canonical candidate windows across composition, Meeting Core, and the
Subscription Runtime boundary. An input containing 25 is rejected before any
provider execution. Retrieval V2 does not inherit or invoke this selector.

### Consumer-owned anti-corruption boundary

The Infinity adapter implements a narrow Meeting Knowledge port. It uses the
official TypeScript SDK only for versioned wire mapping and strict response
validation. Infinity SDK, HTTP, Discord, PostgreSQL, and provider types do not
enter domain code or application contracts.

The adapter admits only locator-only responses that match the persisted
contract, capability fingerprint, service revision, index profile, ranking
policy, applied bounds, required-lane evidence, and response-size limits.
Unexpected fields, text, snippets, duplicate locators, unknown lanes, partial
required coverage, bound drift, or capability drift make the result
unavailable. Remote scores and contributions are retrieval provenance only.

### Local authority and bounded grounding

Meeting Knowledge authorizes the room before retrieval, resolves every returned
locator through the current PostgreSQL plan, reloads the accepted final meeting
and canonical transcript turns, validates source and projection generations,
rehashes canonical turns, and authorizes the room again after rehydration.
Any missing, duplicate, cross-room, stale, ambiguous, ineligible, or changed
locator fails the V2 retrieval attempt closed.

Only locally rehydrated canonical turns can enter answer evidence or citations.
The V2 path applies its persisted evidence-byte budget directly and bypasses
the legacy generic reranker. It may combine locally authoritative current/hot
evidence with locally rehydrated historical evidence under the consumer policy,
but it never sends an entire long transcript merely because it fits a model
window. Exhaustive questions continue to use an explicit exhaustive path or
abstain; top-k retrieval cannot prove completeness.

### Official SDK artifact custody

Discord consumes an immutable official SDK tarball produced from the reviewed
Infinity Context source revision. The artifact is stored under the repository's
vendor custody, has a verified SHA-256 digest and provenance record, is declared
once in the strict pnpm workspace catalog, and is referenced by consumers with
`catalog:`. Package manifests must not introduce direct `file:` dependencies or
point at an Infinity Context source checkout.

The vendored artifact is a build input, not a second implementation of
retrieval. Contract changes begin in Infinity Context, produce a new official
SDK version and artifact identity, and then update the consumer adapter and
qualification evidence.

Historical document ingestion uses that same official SDK generation and maps
the consumer-owned historical plan to
`document-retrieval-projection.v1`. Meeting Knowledge owns the deterministic
mapping from its candidate locator, release, index generation, ordinal, human
turn actors, and relative meeting interval; Infinity owns generic projection
validation and exact wire serialization. The provider projection contains a
`record_block` kind, stable generic meeting-evidence category, and no canonical
transcript authority.

The projection contract version is an explicit input to Meeting Knowledge's
historical index-generation identity. Its candidate locator, document identity,
document mutation, and release-index mutation therefore differ from the legacy
projection-less generation. Existing legacy rows are not reused in place:
eligible releases are rebuilt under the new generation, and the normal
authorized supersession/deletion workflow drains old documents independently
of Retrieval V2 serving.

### Rollout and effects

Retrieval V2 serving starts disabled and has no implicit production provider
binding. Enabling it requires qualification for the exact application release,
SDK artifact, service revision, capability/profile fingerprint, and index
profile, including repeated production-model results and accepted human
receipts. Shadow execution cannot select evidence, generate an answer, reserve
an effect, publish to Discord, or trigger speech.

The long-call V4 qualification orchestrator owns separate retrieval, canonical
local rehydration, answer, and independent-adjudication ports. It records seed
order before neighbor expansion. Citation admission is reconstructed only from
exact locally rehydrated turns returned as seeds or neighbors, and each outcome
binds the canonical question ID, locale, question digest, evidence bytes, prompt
bytes, and whole-transcript-use indicator. Uncomposed production ports fail
closed.

Each of three real repetitions must independently pass final-answer recall and
Recall@5 overall and for English, Russian, and mixed-language strata, plus
citation entailment and the frozen codename-free stratum. Provider-free
structural runs prove corpus shape and arithmetic only; they cannot satisfy
real-run, production-model, reviewer, or independent-adjudication receipts.

Publishing remains the only owner of exactly-once Discord effects. Indexing and
authorized deletion reconciliation continue independently of serving or answer
rollout. A Retrieval V2 failure may use only an explicitly configured,
separately observed local fallback or abstain; it cannot silently fall back to
another remote profile.

## Consequences

- The same durable job is deterministic across retries and deploys.
- Infinity Context owns reusable retrieval quality while Discord owns product
  authorization, evidence, citations, answer policy, and effects.
- Long meetings are grounded from bounded retrieved evidence rather than a
  routinely repeated full-transcript prompt.
- SDK upgrades are reproducible and reviewable, with one dependency declaration
  and no deep source coupling.
- Production activation remains blocked until exact-release E2E, model-quality,
  human-review, rollback, and private Discord qualification evidence is present.
