---
id: ADR-0052
status: proposed
supersedes: []
superseded_by: []
---

# ADR-0052: Production-faithful meeting-memory qualification evidence

## Status

Proposed on 2026-08-25. This proposal narrows qualification evidence without
changing ADR-0049 retrieval ownership or enabling serving.

## Context

Production Retrieval V2 ranks opaque `record_block` locators, while the V4
fixture treated transcript turn IDs as locators. The private real corpus also
contains prose expected answers rather than sealed atomic claims, and digest
shapes cannot establish independent review. Provider execution needs durable
unknown-outcome handling and exact original/repair input accounting.

## Proposed decision

- Rehydrated evaluation turns carry canonical turn identity and the opaque block
  locator that admitted them. Retrieval metrics score blocks; citation,
  entailment, speaker, and time metrics score canonical turns.
- One shared production/evaluation request snapshot uses result limit 10,
  evidence limit 16,000 UTF-8 bytes, neighbor radius zero, candidate limit 100,
  at most four queries, a 1,000 ms deadline, and a 16,384-byte response.
- The real path-injected 37-answerable/3-abstention RU/EN corpus replaces the 40
  unreviewed synthetic candidates. Two pinned Ed25519 reviewers bind exact
  corpus, question, input, and sealed atomic-rubric SHA-256 values.
- Both original and permitted repair model inputs count exact system prompt,
  user prompt, separators, and output schema. Either exceeding 16,000 UTF-8
  bytes is rejected before provider execution.
- A create-only reservation is durable before provider bytes may be sent. One
  terminal state follows; after restart, any reservation lacking an authenticated
  raw-envelope terminal is `outcome_unknown` and cannot resume or retry.
- Production authority is nominal and adapter-owned: PostgreSQL modules expose
  read-only constructor assertions, while the concrete gRPC module alone can
  issue an answer adapter. Prototype clones, structural fakes, public registration,
  post-construction dependency substitution, and zero-exchange objects cannot
  receive a production brand. Brands are minted only after the concrete operation.
- Each repetition needs two independent signed claim/citation adjudications and
  an independent conflict resolver when decisions differ. Three repetitions
  pass independently overall, per corpus, and per applicable locale.
- Final admission requires identical source, SDK, image, capability, profile,
  index, model, runtime, tokenizer, prompt, policy, corpus, rubric, question, and
  request bindings plus signed derived cleanup and canonical absence.
- The independent release root enters only through a launcher-owned inherited
  descriptor. The anchor pins the executing verifier module set. Resolved loaded
  SDK/runtime/prompt/tokenizer modules are measured directly; operator-selected
  artifact paths are not provenance inputs. Both remote services sign a fresh
  campaign/attempt/process/endpoint-bound execution attestation for their running
  service/image and workload identity.
- Every concrete retrieval and original/repair answer exchange additionally
  requires an independently signed receipt over its exact attempt, provider run,
  request/response digests, ordinal, process, endpoint, service generation, and
  measured model/prompt/tokenizer identity before the corresponding brand exists.
- The bounded-context owner is Discord's qualification tooling. Its one
  executable composition is
  `packages/infinity-context-adapter/test/semantic-quality-v4-production-composition.ts`; it
  orchestrates the already classified `adapters.infinity-context` production
  runner and exact consumer-owned ports without adding a generic platform.
- All 240 retrievals, canonical PostgreSQL rehydrations, capability/profile,
  structural, leakage, and retrieval thresholds pass before the production
  answer port is created. A create-only worst-case repetition spend reservation
  is required before answer execution.
- Standard micro block-locator Recall@5/@10 and complete-question Recall@5/@10
  are separate exact ratios. Both @5 forms gate at 9/10 overall and per
  applicable locale; both @10 forms and nDCG@10 are report-only. Overall,
  automated, and real reports are independently sealed.
- Exact v1 campaign and run manifests replace caller-asserted run digests and
  failure lists. Admission recomputes the root, outcomes, metrics, thresholds,
  answer/evidence/adjudication bindings, and cleanup bindings locally.
- The root additionally seals the exact turn-to-block mapping, locator/canonical
  authority, threshold/applicability profile, and role-separated pinned-key
  registry. Runtime capability bytes and all prepared request snapshots must
  exactly equal the corresponding observed outcome fields.
- Private artifacts use a versioned A256GCM envelope authenticated by root,
  canonical attempt, artifact kind, key ID, and plaintext digest. Artifact
  retention, derived Infinity deletion, and authoritative canonical absence are
  separate signed bindings.

## Consequences

Provider-free fixtures remain arithmetic evidence only. Private text stays in
path-injected encrypted create-only artifacts; public manifests contain safe
counts, metrics, digests, versions, and signatures. This proposal does not set
`ACCEPTED_TWO_HOUR_QUALIFICATION`, enable Retrieval V2 serving, or establish a
quality pass.
