---
id: ADR-0077
status: accepted
supersedes: [ADR-0066]
superseded_by: []
---

# ADR-0077: Admit only the exact authoritative qualification generation

## Status

Accepted on 2026-09-13. This decision corrects the candidate identity in
ADR-0066 and closes the installed corpus-admission schema around that identity.

## Context

The authoritative audit identified meeting `HQogFSdvy0tf` as 1,779 ordered,
unique transcript turns from seven speakers. Its source SHA-256 is
`fc92b9d76f4b4c9613e19f78b87fe3a38e4b772b3d4943cde486ed75ac0a72e4`,
and the canonical ordered-turn SHA-256 is
`3940285ace11a4449a7489bdc631833fffaeda3339b581316d48bf6358fc5c82`.
The associated independently reviewed set has 40 cases: 29 answerable and 11
abstention, with 10 EN and 30 RU.

The 2,209-turn, eight-speaker, 37/3 answerability, 22/18 locale fixture belongs
to another meeting. Treating it as a qualification profile, even as a selectable
legacy profile, permits evidence from the wrong meeting to enter the campaign.
Sealing caller-supplied source and snapshot digests alone does not reject that
substitution.

## Decision

- Installed corpus admission accepts only
  `meeting_knowledge.semantic_quality_sealed_corpus.v2`. The corpus carries a
  closed `authoritativeGeneration` value with the exact meeting ID, source and
  canonical-turn digests, transcript-turn and speaker counts, and reviewed-case
  answerability and locale counts above.
- Admission recomputes the answerability and locale counts from the 40
  `independent_review` execution/gold entries and exact-compares them with the
  generation. Mixed-locale reviewed entries and any target, digest, count, or
  schema mismatch fail before publication or provider construction.
- The top-level source digest must equal the authoritative generation's source
  digest. The artifact-custody signed V2 turn-mapping receipt must bind the exact
  authoritative-generation digest and source digest together with the snapshot and
  mapping digest. The forbidden-locator receipt remains separately snapshot-bound.
- The old V1 sealed-corpus schema and the selectable 2,209/8 decoder are not
  qualification inputs. Historical arithmetic may be examined outside the
  installed qualification path, but it cannot be admitted, transformed, or
  used as a fallback.
- This decision adds no transcript, question, gold, claim, or fact content to
  the repository. The listed aggregate counts and cryptographic identities are
  safe provenance only and are not evidence of quality.
- ADR-0052's inherited thresholds, independent review and adjudication,
  three-repetition, retention, cleanup, and exactly-once unknown-outcome
  controls remain unchanged. This correction does not alter the separately
  accepted model/reasoning/service-tier profile.

## Consequences

Any existing V1 corpus packet requires regeneration and fresh exact-binding
custody, review, authorization, release, and execution receipts. Evidence for
the other meeting cannot be replayed or migrated into this generation. No
qualification, provider execution, serving enablement, or production-data
mutation follows from accepting this decision.
