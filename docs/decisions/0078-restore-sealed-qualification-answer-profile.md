---
id: ADR-0078
status: accepted
supersedes: [ADR-0071]
superseded_by: []
---

# ADR-0078: Restore the sealed qualification answer profile

Accepted on 2026-09-13 following the qualification owner's explicit release
profile correction.

The official sealed V2 memory quality campaign requires `gpt-5.6-sol`, reasoning
`medium`, and service tier `default` for every evaluated answer. Its signed
release document, spend reservations, provider accounting, execution
attestations, and all three 240-answer repetitions must bind that exact profile.
Terra/low qualification evidence is stale and cannot be reused.

This decision supersedes only ADR-0071's quality-campaign profile. Terra/low
remains the application memory answer, every-block coverage, focused evidence
selection, and isolated real40 diagnostic default. The campaign's corpus
admission, retrieval limits, thresholds, durable-effect controls, evidence
custody, and three-repetition requirements remain unchanged. The correction
does not qualify a release or authorize provider execution; fresh signed
release, spend, execution, and review bindings are required first.
