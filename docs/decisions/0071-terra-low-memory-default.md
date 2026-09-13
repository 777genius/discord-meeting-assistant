---
id: ADR-0071
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0071: Terra low as the memory default

Accepted on 2026-09-08 following the owner's explicit model choice.

Meeting Knowledge owns the answer, semantic every-block coverage, and focused
evidence-selection profiles. All three now require `gpt-5.6-terra`, reasoning
`low`, and service tier `default`. Memory quality qualification and the isolated
real40 diagnostic use the identical answer profile. This changes only the model
choice previously frozen by ADR-0066; its other evidence requirements remain.
Final summaries retain Sol/medium; incremental summaries and conversation retain
Luna/low. Coding-worker profiles are outside this decision.

Answer policy v4, coverage v2, and evidence-select v2 bind the new profile.
Answer/coverage measurement identities also advance. Sidecar schemas, deployment
policy, audited launcher pins, signed release/spend admission, and diagnostic
manifest admission reject the previous memory profile. The changed launcher
bundle and release must be measured again; old Sol evidence cannot qualify Terra.
No production serving or quality-pass claim follows from this default change.

Output/evidence budgets, quality thresholds, independent adjudication, and the
create-only original/repair reservation and outcome-unknown rules are unchanged.
Only synthetic providerless fixtures validate this change; a separately
authorized real campaign must establish Terra quality with fresh exact bindings.
