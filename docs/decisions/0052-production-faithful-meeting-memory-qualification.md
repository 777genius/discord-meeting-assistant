---
id: ADR-0052
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0052: Production-faithful meeting-memory qualification evidence

## Status

Accepted on 2026-08-26. The production runner now establishes the executable
qualification boundary without changing ADR-0049 retrieval ownership or
enabling serving.

## Context

Production Retrieval V2 ranks opaque `record_block` locators, while the V4
fixture treated transcript turn IDs as locators. The private real corpus also
contains prose expected answers rather than sealed atomic claims, and digest
shapes cannot establish independent review. Provider execution needs durable
unknown-outcome handling and exact original/repair input accounting.

## Decision

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
- The bounded-context owner is the quality-campaign module in Discord's Infinity
  adapter. Its operational sources live under
  `packages/infinity-context-adapter/src/quality-campaign`; they
  orchestrate the already classified `adapters.infinity-context` production
  runner and exact consumer-owned ports without adding a generic platform.
- The custody seal never authorizes provider execution. A separate signed,
  expiring execution authorization binds the exact acceptance receipt, corpus,
  and release root. The main workflow root binds exactly 200 sealed automatic
  and 40 independently reviewed questions plus two signed locator authorities
  derived from one frozen authoritative database snapshot.
- A separately authorized 30-question holdout has its own root, key namespace,
  receipts, report, and cleanup. Admission compares all question and locator
  digests against the frozen main-run load inventory; the holdout report is
  explicitly non-qualifying and cannot change main campaign metrics.
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
- Terminal replay reconstructs the complete reserved exchange and accepts a
  terminal only when its signed inner payload and create-only wrapper bind the
  same attempt, call identity, campaign, question, repetition, request, state,
  result, exact release root, and signed spend-reservation digest. Corrupt or
  foreign evidence is an explicit blocked state, and replay never causes a new
  provider effect.
- Every provider effect and replay entry re-verifies the canonical signed release
  document and signed repetition spend reservation against pinned authority keys
  at an explicit deterministic time. The core checks provider/model/reasoning,
  exact attempt and call kind, expiry, and projected call/token/encrypted-byte
  totals before the effect port can be reached; digest strings are not authority.
- Operator/composition constructs one immutable role-separated authority policy.
  Requests carry only exact key-ID references and signed documents; they never
  carry public keys. Release, spend, provider-result, main-review, repetition,
  locator, gold-relevance, inventory, cleanup, adjudicator, resolver, holdout-provider,
  artifact-custody, main-proof, and holdout keys have distinct IDs and canonical
  fingerprints, and the signed release binds the complete policy digest.
- The durable attempt journal appends one bounded create-only budget claim before
  exchange. Append order atomically determines the one admitted claim per exact
  attempt and cumulative call, call-kind, token, and encrypted-byte ceilings.
  Unknown outcomes remain charged. Authenticated terminal reconciliation changes
  outcome state but never refunds the claim; restart derives state from the claim
  and attempt records without leases, wall-clock guesses, or orphan locks.
- Each effect carries an explicit deadline bounded by the signed reservation and
  an abort signal. The durable claim binds the exact request digest, campaign,
  repetition, call kind, ordinal, spend reservation, and attempt before the
  exchange port is reachable.
- Final admission consumes signed repetition documents containing the exact
  3x240 outcomes rather than caller-attested pass booleans or opaque report
  digests. It reconstructs question membership, attempt identity, structural
  success, overall/corpus/locale Recall@5 thresholds, root bindings, the complete
  retained-artifact inventory, authenticated stored-envelope AAD, and cleanup
  absence for the exact deletion targets.
- Each repetition contains exactly the same 200 automatic and 40 independently
  reviewed main questions. Ordered ranked locator IDs, relevant locator IDs,
  canonical-turn speaker/time comparisons, citation entailment, factual-claim
  support, and abstention observations replace caller-supplied metric counts;
  Recall@5, complete Recall@5, MRR@10, citation, precision, speaker/time, and
  abstention thresholds are reconstructed from those closed bounded structures.
- Retained artifact kinds have one closed call-kind/ordinal ownership map. The
  final-adjudication digest is the SHA-256 of the authenticated retained
  plaintext. Final admission reads canonical envelope bytes and pinned key
  custody through narrow ports and performs AES-256-GCM authentication in the
  core; a structural assertion that storage already opened an envelope is not
  admissible evidence.
- Cleanup targets come only from an independently signed campaign-created
  inventory whose authority key is pinned by the verified release. The absence
  receipt enumerates all and only those derived IDs and separately enumerates
  every protected original still present; no caller-authored replacement
  manifest participates in final admission.
- A conflict resolver receives both complete independently signed decisions.
  The core reverifies them and requires the resolver result to bind their exact
  signed receipts, raw outcome, question, attempt, and encrypted evidence.
- Holdout admission reconstructs its signed 30-question receipt, exact locator
  set, independently authorized root, and root-derived encryption namespace.
  The main-proof, holdout-question, and holdout-authorization keys are
  cryptographically independent; namespaces cannot be reused across roots.
- Reviewer, adjudicator, and resolver independence is established by distinct
  signer key IDs and distinct canonical public-key fingerprints. Role labels do
  not establish independence.
- Public operator status uses only closed blocker/error vocabularies, bounded
  counters, and named SHA-256 fields. Private handler text is never status data.

## Consequences

Provider-free fixtures remain arithmetic evidence only. The installed production
entrypoint admits the exact sealed manifest and separate execution authorization,
runs a bounded deadline-bound 3 x 240 schedule with durable exact-attempt recovery,
composes external review, exact derived cleanup and isolated holdout execution,
and delegates final qualification to exact campaign admission. Private text stays
in path-injected encrypted create-only artifacts; public manifests contain safe
counts, metrics, digests, versions, and signatures. This decision does not set
`ACCEPTED_TWO_HOUR_QUALIFICATION`, enable Retrieval V2 serving, or establish a
quality pass.

The production runner must adapt to the exported core contracts before it can
claim this proof: pass the signed pinned release document, signed spend
reservation, deterministic effect time, and authoritative usage totals into
every exchange; give the resolver both signed decision receipts; provide
canonical envelope bytes and pinned AES key custody; emit signed repetition
evidence with ordered locator/turn/claim structures and correct per-kind attempt
identities; sign the authoritative campaign-created cleanup inventory and exact
absence/presence receipt; and provide the separately signed holdout-question receipt.
Until then, runner integration is intentionally unavailable rather than
silently accepting legacy caller-attested evidence.
