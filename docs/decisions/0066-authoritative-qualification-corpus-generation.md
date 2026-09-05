---
id: ADR-0066
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0066: Bind qualification corpus cardinality to an authoritative generation

## Status

Accepted on 2026-09-05. This decision corrects stale cardinality documentation;
it does not qualify the observed candidate generation or change evaluation
semantics.

## Context

The production runbook described one historical source-harness decoder fixture
as though its 2,209-turn, eight-speaker, 37/3 answerability, 22/18 locale, and
category counts were the installed production admission schema. The installed
`corpus-admit` implementation does not enforce those transcript or distribution
counts. It seals `sourceDigestSha256` and `snapshotSha256` and requires the main
campaign's 200 automatic and 40 independently reviewed entries.

On 2026-09-05 the orchestrator measured the current authoritative PostgreSQL
`NEW` snapshot for the candidate meeting. Accepted final transcript version 2
had status `succeeded` and exactly equalled the saved source JSON. No newer
accepted transcript was present for that meeting. The accepted transcript
contained 1,779 ordered turns and seven speakers. Identity authority classified
six speakers as human; the remaining declared automation speaker owned 10 turns.
The resulting final-human generation contained 1,769 ordered, unique turns from
six speakers. The existing private 40-question set contained 29 answerable and
11 abstention questions, with 10 EN and 30 RU.

The same read-only snapshot inspection found no canonical `source`, `actors`,
`identityProvenance`, `lifecycleGeneration`, or `authoritativeDurationMs`
metadata and no `historical_memory_sync` row for the meeting. The separate
identity-authority JSON supports the offline human-turn counts above; it does
not manufacture sealed lifecycle-v3 provenance or an applied historical index.

Those values are safe aggregate provenance for one observed candidate. They are
not quality measurements, and neither the private corpus nor its contents were
copied into this repository.

## Decision

- A qualification corpus is identified by its immutable authoritative
  generation, sealed source digest, and sealed snapshot digest. Transcript,
  speaker, answerability, and locale counts describe that generation; no such
  count becomes a universal production constant merely by appearing in a
  runbook or fixture.
- The accepted final transcript is transcript authority. Identity authority is
  the only basis for human/automation classification. Automation turns remain
  in the authoritative transcript but are excluded from the final-human
  qualification generation; order and turn identity remain exact and unique.
- The installed `corpus-admit` path is authoritative for admission behavior. Its
  fixed question membership remains exactly 200 `automatic` plus 40
  `independent_review` entries. The historical 2,209/8/37/3/22/18 decoder and
  its category arithmetic remain test-only and cannot reject, reshape, or
  authorize a new authoritative generation.
- Successful transcription and source-JSON equality do not establish Meeting
  Knowledge admission. Actual rehydration requires authentic canonical
  source/actor/sealed lifecycle provenance and an applied derived historical
  index. This legacy candidate therefore requires either authentic lifecycle
  and source admission or a separately approved, signed legacy-import policy,
  followed by derived indexing. Operators must never edit the old production
  snapshot or synthesize lifecycle-v3 fields to make it admissible; ordinary
  `corpus-admit` alone cannot make it ready for rehydration.
- The 40 private questions require two truly independent signed exact-binding
  reviews, with independent conflict adjudication when required. Gold remains
  separate from execution. No aggregate count is evidence of question quality,
  claim support, retrieval quality, or reviewer independence.
- Qualification still requires three independent 240-outcome repetitions. Each
  repetition must pass every overall, corpus, and applicable locale gate; a
  failed repetition cannot be averaged away. Exactly-once create-only
  reservations, durable unknown-outcome handling, two truly independent signed
  answer and citation adjudications per repetition, independent conflict
  resolution when their decisions differ, retention, and derived-index
  cleanup/absence evidence remain mandatory.
- Every repetition and receipt must bind the exact source, accepted snapshot,
  Infinity Context SDK `0.2.4`, `gpt-5.6-sol` with reasoning effort `medium` and
  service tier `default`, release, request, prompt, policy, tokenizer, corpus,
  rubric, question, reviewer, and adjudication identities. A later generation
  or binding change requires new receipts and new executions.
- The original Craig recording, accepted final transcript, and meeting database
  remain authoritative evidence and are never cleanup targets. Failure or
  rejection of derived retrieval, answer, adjudication, or publication evidence
  cannot delete or invalidate them.

## Consequences

The observed 2026-09-05 generation remains **UNQUALIFIED / NO-GO**. It has no
new signed review or adjudication receipts and no three real, independently
passing repetitions. This decision fabricates no acceptance, signature, quality
result, or rollout authorization and does not enable serving.

Operators must generate and review immutable corpus material from the accepted
transcript and identity authority, seal its exact digests through installed
`corpus-admit`, and run the full release-bound campaign. Historical decoder
arithmetic remains useful only for its explicitly labelled test fixture.
