---
id: ADR-0049
status: accepted
supersedes: [ADR-0030, ADR-0031]
superseded_by: []
---

# ADR-0049: Locator-only upstream retrieval with downstream evidence authority

## Status

Accepted on 2026-08-22. This decision supersedes ADR-0030's
PostgreSQL-specific candidate-selection mechanics and ADR-0031's downstream
ownership of historical query execution, provider-score normalization, indexed
lane fusion, reranking, and neighbor expansion. It carries forward their
question admission, local evidence authority, exhaustive-coverage, durability,
and deletion rules.

## Context

PR #60 improved Meeting Knowledge retrieval quality, but it also placed a
second generic retrieval engine downstream of Infinity Context. The downstream
path executes multiple searches, merges provider ranks, normalizes provider
scores, applies lexical, speaker, and temporal scoring, expands neighbors, and
then fuses those historical candidates with current evidence. Infinity already
owns generic indexed retrieval mechanics, so retaining both engines would make
the effective ranking policy depend on two independently changing profiles.

The existing official SDK call uses text-bearing `/v1/search`. Discord strips
the returned text and keeps locator-shaped source references, but that is an
adapter convention rather than a text-free boundary. A mapper regression could
therefore admit remote text. Optional startup capabilities and response
diagnostics also do not attest one exact query profile or prove required lane
health for each request.

At the same time, moving all question or answer behavior upstream would cross
the authority boundary. Participant aliases, focused-versus-exhaustive routing,
authorized source selection, live freshness, local canonical evidence,
citations, Discord effects, and voice cancellation are meeting-product rules,
not reusable indexed retrieval mechanics.

## Decision

### Corrected ownership

| Owner | Authority and responsibility |
| --- | --- |
| Discord profile custody | Retains configured Discord identities and names and maps them to canonical, opaque actor keys. It never sends Discord IDs, display names, or alias maps to Infinity. |
| Meeting Knowledge | Resolves participant aliases in the question, selects authorized sources, constructs explicit query variants and opaque actor/time hints, chooses focused versus exhaustive handling, retrieves and rehydrates current/hot evidence locally, composes it with historical candidates, and owns evidence eligibility, citations, answer validation, and abstention. |
| Infinity Context | Executes supplied query variants across its indexed lanes; records provider score provenance; applies registered typed metadata filters and boosts; fuses and deduplicates indexed lanes; performs deterministic ranking and same-source historical neighbor expansion; enforces generic service bounds. |
| Transcription and PostgreSQL | Retain the accepted final transcript and canonical local turns as the only citation source. The finalized live-turn table remains the local authority for active hot evidence. |
| Publishing | Owns deterministic effect identity, durable reservation, the exactly-once Discord create authorization, unknown-outcome reconciliation, duplicate containment, and retraction. |
| Conversation | Reuses the grounded-answer use case and owns cancellation, replacement, literal-TTS handling, and playback. |

Infinity owns fusion only among its indexed keyword, dense, and any optional
graph lanes. Meeting Knowledge performs the final composition of locally
authorized current/hot evidence and historical Infinity candidates because
that decision is authorization- and freshness-sensitive. It uses an explicit,
versioned source policy; it does not compare unattested local and remote score
scales.

Participant alias resolution remains in Meeting Knowledge. Discord profile
custody supplies the mapping from configured names to canonical opaque actor
keys. After an unambiguous local match, Meeting Knowledge may send only those
opaque keys as typed filter or boost values. Infinity never receives or parses
names or aliases and an actor-key match never grants evidence eligibility.

### Additive locator-only contract

Infinity adds the purpose-specific endpoint `/v1/context/retrieve` and exact
official SDK types. The endpoint is additive. Text-bearing `/v1/search` remains
unchanged for its existing consumers and is never the target contract for this
migration.

The versioned request contains only:

- the exact contract version, capability/profile fingerprint, index profile,
  and opaque scope reference;
- bounded explicit `{ queryId, text, weight }` variants constructed by Meeting
  Knowledge;
- registered hard fields such as source key, projection generation, kind, and
  include/exclude source keys;
- registered typed soft signals such as opaque actor keys, time range/order,
  and same-source neighbor radius;
- candidate, deadline, fan-out, and required-lane bounds.

It contains no authorization principal, meeting aggregate, Discord identifier,
name, alias, answer policy, locale policy, citation, or free-form filter JSON.

Every response contains:

- `available`, `unavailable`, or `unqualified`;
- the exact request capability/profile fingerprint and exact applied bounds;
- `coverage: top_k_only`;
- unique candidates containing only an opaque locator, opaque source family,
  fused score, direct-or-neighbor relation, neighbor distance, and bounded
  retrieval contributions identifying lane, query, rank, and contribution.

The response contains no text, snippet, rendered context, arbitrary metadata,
remote citation, answer, authorization assertion, alias/query echo, or
completeness assertion. Retrieval provenance is not canonical source
provenance. Meeting Knowledge alone binds a returned locator to local release,
generation, range, hash, human actor, quote, and citation identity.

Projection attributes available to Infinity are derived and non-authoritative:
opaque locator, source key, projection generation, sequence ordinal, opaque
actor keys, start/end time, and kind. Only locally admitted final human
evidence has a historical index projection.

### Fail-closed capability and authority rules

The capability fingerprint is the digest of the exact contract, service and
SDK revision, fusion policy, attribute schema, index/profile identity,
supported signals, maximum bounds, provenance vocabulary, and required lanes.
It must be repeated exactly in every response.

The new path is unavailable when any of the following occurs:

- the fingerprint is missing, malformed, unknown, stale, or mismatched;
- a required lane is missing, unhealthy, unobserved, partial, or truncated;
- a request exceeds an advertised bound or uses an unknown field, filter,
  signal, operator, or enum value;
- the response changes an applied bound, contains an unknown provenance lane,
  duplicate locator, cross-source neighbor, malformed score, excessive item,
  partial required result, or any unexpected text-bearing field.

Bounds are rejected, never silently clamped or truncated. Optional graph-lane
absence may degrade only when graph was not required; required lexical and
dense lanes fail the whole request together.

Meeting Knowledge authorizes the scope before retrieval and reauthorizes every
locator after retrieval. It reloads exact canonical PostgreSQL turns and checks
room, source, desired release, projection generation, retention, range, hash,
and human eligibility. Missing or ambiguous locators, duplicate ownership,
generation or content drift, cross-room data, and authorization drift are
discarded and cannot become citations. Authority is checked again before model
generation, Publishing effect reservation and send, and Conversation playback.

The authoritative PostgreSQL transcript is the only citation source. Remote
text is forbidden by the SDK contract and can never cross it, even as a field
that the downstream adapter promises to ignore.

### Focused, exhaustive, fallback, and effect rules

Meeting Knowledge continues to choose focused retrieval versus deterministic
exhaustive coverage. Infinity results always attest `top_k_only` and can never
prove count, absence, universal, all-item, or broad completeness. Full-source
focused selection remains forbidden and produces an explicit insufficient
status rather than silent rank mutation.

Current/hot evidence is selected from canonical local state under a named,
bounded policy and is composed with historical candidates only after local
authorization. If remote retrieval is unavailable, Meeting Knowledge may use a
separately named bounded `canonical_local_exact_lexical` mode or abstain. That
mode has independent limits and telemetry and is never reported as Infinity or
hybrid success. It is not a permanent copy of Infinity's generic reranker.

Publishing remains the sole owner of durable exactly-once Discord effects.
Meeting Knowledge owns answer eligibility and the authority rechecks requested
by Publishing and Conversation. Conversation owns voice reuse, cancellation,
and playback; retrieval success never authorizes speech by itself.

Authorized historical deletion continues to drain while indexing, serving, or
the new retrieval capability is disabled or invalid. No retrieval rollout may
weaken ADR-0045 through ADR-0048's exact-profile and exact-head deletion rules.

### Migration and deletion point

The migration is upstream-first:

1. Infinity accepts its own ADR, implements `/v1/context/retrieve`, official
   SDK types, the exact fingerprint, generic projection attributes, and
   contract/security tests while leaving `/v1/search` unchanged.
2. A new index-profile identity dual-writes locally admitted final evidence,
   rebuilds every eligible current release, and drains deletion for both
   profiles.
3. Discord adds a thin anti-corruption adapter. After normal authorization it
   runs the new query in shadow, locally rehydrates locators, and records only
   locator digests and aggregate comparisons. Shadow output reaches neither
   selection, generation, Publishing, nor Conversation.
4. Recall, abstention, isolation, fingerprint, malformed-response, performance,
   and load gates pass on the exact release and profile.
5. Final Discord replies canary at staged percentages. Admission must
   deterministically select and persist immutable
   `{retrievalPath, profileFingerprint, cutoverEpoch}` on the durable question
   job before its first execution. Retries, lease recovery, and resumed or
   replacement workers reuse that binding; a missing or conflicting binding
   fails closed. Candidate sets from the legacy and new paths are never merged.
   One flag starts a new cutover epoch that binds only not-yet-bound jobs to the
   old path; rollback never changes an already-bound job. Dual-write and
   deletion continue.
6. Voice enables only after final-reply stability and its stricter latency,
   cancellation, and playback-authority gates pass.
7. At 100%, retain the legacy read path for two qualified releases and until,
   after the maximum 900-second job-retention and 540-second lease windows,
   there are zero nonterminal or leased old-path jobs and zero unresolved
   old-path effects, including unknown outcomes awaiting reconciliation.
   Retained terminal old-path job and effect audit rows are explicitly excluded
   from those zero gates and need not be deleted. The rollback window must also
   be expired and old-profile deletion fully drained.

Only at step 7 may the old generic downstream reranker, provider-score
normalization, indexed-lane fusion, historical neighborhood expansion,
diagnostics-derived qualification, and `/v1/search` adapter path be deleted.
The old reranker is transitional, not a permanent semantic fallback.

## Consequences

- Infinity has one reusable indexed retrieval policy without acquiring meeting
  authorization, alias, answer, citation, publication, or voice vocabulary.
- Meeting Knowledge remains the sole downstream evidence authority and the
  final current/hot-plus-historical composer.
- A text-bearing remote response cannot cross the new SDK boundary.
- Capability and lane drift fail per request instead of being hidden by cached
  startup state or an unnamed fallback.
- Rollback remains available without mixing ranking policies, while deletion
  recovery remains independent.
- Behavior-changing implementation is NO-GO until the exact prerequisites and
  retained evidence in the migration plan are satisfied.
