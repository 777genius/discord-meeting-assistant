# Meeting memory V4 qualification tooling

Status: **UNQUALIFIED / NO-GO**

This V4 slice contains a deterministic provider-free harness and the
production-faithful qualification boundary. It is not a quality result. No real
retrieval, answer, ASR, reviewer, cleanup, or three-repetition evidence is
committed, and serving remains disabled.

## Frozen topology

V4 retains the existing primary synthetic meeting at exactly 421 turns and
`8,418,500 ms` (2h20m18.5s). It replaces 16 routine turns that are not
referenced by any base gold, distractor, or other semantic binding, at their original
timestamps to add independent owner, date, numeric-limit, and explicit-negation
correction families plus exact and ambiguous participant aliases. The original
meeting count and duration do not change.

The automated set remains exactly 200 questions: 100 answerable and 100
unsupported. V4 attaches correction, contradiction, alias, temporal, and
cross-scope metadata without adding a 201st question. Twelve unsupported
questions name forbidden foreign locators.

Two auxiliary leakage meetings contain six synthetic 20-second turns apiece:

- a different room in the primary scope;
- the primary room identity in a different scope.

Four additional 25-turn meetings freeze one same-codename stale, contradictory,
wrong-room, and wrong-scope negative for each of the 25 target fact families.
Every answerable question explicitly references the four negatives for each fact
family it asks about. The 112 auxiliary turns make the total frozen fixture
duration `10,658,500 ms`; the long primary meeting remains unchanged.

The separate review-candidate set has exactly 40 natural questions:

| Classification | EN | RU | Mixed | Total |
| --- | ---: | ---: | ---: | ---: |
| Answerable | 6 | 6 | 8 | 20 |
| Unsupported | 6 | 6 | 8 | 20 |
| Total | 12 | 12 | 16 | 40 |

All 40 are marked `unreviewed`. Their tags overlap and include 11 authored ASR
text challenges, eight overlap cases, ten alias cases (four ambiguous), nine
correction cases, ten contradiction cases, 12 multi-hop cases, and 12
cross-scope attacks. `asr-text-challenge` means only that the synthetic text
contains a recognition-style difficulty. It is not an observed ASR result and
cannot qualify ASR.

## Canonical binding

[`semantic-quality-v4-manifest.ts`](../../packages/infinity-context-adapter/test/semantic-quality-v4-manifest.ts)
serializes canonical UTF-8 JSON with lexicographically sorted object keys and
order-preserving arrays. Every numeric value admitted to a hash must be a safe
integer. Proportions and thresholds use integer `{ numerator, denominator }`
records; floating-point scores are never hashed.

The manifest binds separate SHA-256 values for:

- the 421 primary turns and 16 frozen overrides;
- the 112 auxiliary turns, 100 fact-family negative records, and seven-meeting
  scope topology;
- the final 200 automated questions and their frozen patch records;
- the 40 unreviewed review candidates;
- the complete known-locator and global-forbidden-locator authority;
- the JSON manifest schema.

It then binds corpus and question-set digests into the root manifest digest.
Tests compare every base question relationship and its referenced turn content,
and reject content mutation, array reordering, count drift, malformed gold or
auxiliary references, topology drift, and answerable or unsupported
classification drift. The root also binds the exact threshold-profile digest.
The pinned root digest is
`e4ed7689cb399b0deeae0bcaf645afd336dbc9d9deccd0145c0dbb82a1a9dd17`.
The frozen manifest is
[`manifest.v4.json`](../../packages/infinity-context-adapter/test/fixtures/meeting-memory-v4/manifest.v4.json),
and the committed schema is
[`manifest.schema.json`](../../packages/infinity-context-adapter/test/fixtures/meeting-memory-v4/manifest.schema.json).

## Ordered locator input only

Run outcomes separate up to ten ordered opaque upstream seed locator IDs from
expanded neighbor locator IDs plus measurements;
they cannot supply a corpus, manifest, gold, exclusions, or overrides. The
public scorer reconstructs the committed fixtures and verifies their component,
question-set, locator-authority, corpus, schema, threshold, and root digests
before inspecting an outcome. Frozen question authority derives relevance
deterministically from canonical local turn/indexing IDs. Unknown locators,
duplicate ranks, and any result-supplied relevance are rejected. The evaluator
does not search, rerank, fuse lanes, normalize provider scores,
expand neighbors, or inspect locator text. Recall and rank metrics use only the
seed order before expansion. Meeting-specific local authority owns
forbidden-scope labels, canonical speaker/time references, expected claims, and
abstention labels. Each locally rehydrated turn carries both its canonical
`turnId` and the opaque `sourceLocatorId` of the production `record_block` that
admitted it. Retrieval Recall/MRR/nDCG score ordered block locators. Citation
membership, entailment, speaker, and time score canonical turns. Admission
requires `sourceLocatorId` in the retrieved seed-or-neighbor set; `turnId ===
locatorId` is not an authority shortcut. Neighbor results remain
eligible for leakage checks but cannot improve seed Recall@5.

Every outcome also binds its canonical question ID, locale, and exact
codename-ablated evaluation text digest. Evidence bytes and both exact model
input surfaces are recomputed. The original and permitted repair each account
for `systemPrompt + LF + userPrompt + LF + outputSchema`; either exceeding
16,000 UTF-8 bytes is rejected before provider execution. Whole-transcript inclusion is independently derived from those same
records and prompt rather than accepted from an outcome flag.

Every auxiliary locator from both wrong-room and wrong-scope meetings belongs to
one global forbidden set checked against every primary query; per-question attack
mappings remain descriptive labels only. Every expected question requires one
outcome. Missing outcomes are rejected. Retrieval or answer timeouts and failures
stay in the 240-question denominators; they are never dropped. An answerable
question passes coverage only when it is answered with at least one factual claim.
Empty, abstained, failed, and timed-out answerable results fail the zero execution
and coverage gate only when that factual claim has a finalized supported
adjudication. Latency includes all 240 outcomes.

Every generated claim has a deterministic identity derived from its
query, ordinal, generated-payload digest, factual classification, and canonical
citation set. The generator's factual flag is identity input only; the
independent adjudication assigns the factual/nonfactual scoring classification.
Finalized adjudications bind back to that identity one-to-one. Duplicate claim IDs and
exact repeated claim payloads are rejected. Repeated identical citations for
the same `(query, claim, turn)` are canonicalized to one unit; conflicting
speaker or time data for the same unit is rejected. Pending or unknown verdicts,
statuses, adjudication kinds, and malformed object shapes are invalid final
outcomes. Citation membership, speaker, and exact-time accuracy each use one
unit per citation-bearing claim: every canonical reference on that claim must
pass for the claim-level unit to pass. Every citation also has one finalized
entailment adjudication bound to its generated claim and local turn; all cited
turns must entail the claim for the claim-level unit to pass.

## Reported metrics and applicability

All ratios are retained as exact integer rationals. The same versioned report
schema is sealed separately for overall, automated, and real corpora.

- standard micro block-locator Recall@5 and Recall@10 over every relevant block;
- complete-question Recall@5 and Recall@10, where every relevant block must be
  present within K for the question to receive one hit;
- MRR@10 using exact reciprocal-rank units with denominator 2,520;
- macro per-question nDCG@10: each query uses frozen integer micro-discount
  weights (`1/log2(rank + 1)` rounded once): `1000000, 630930, 500000,
  430677, 386853, 356207, 333333, 315465, 301030, 289065`; integer gains use
  `2^relevance - 1`, and each query is floored to one-million score units before
  the exact macro average;
- cross-scope foreign-locator count;
- citation membership in the admitted local evidence set;
- exact canonical speaker and exact start/end time accuracy;
- whole-question final-answer recall over the real campaign's 137 answerable
  questions (100 automated plus 37 real): expected
  gold IDs are deduplicated within a question and the question receives one hit
  only when every expected claim is independently supported. The obsolete
  provider-free structural fixture had 120 answerable questions and is not the
  real 240-question campaign;
- claim precision as finalized supported factual claims divided by distinct
  factual generated claims;
- abstention precision and recall;
- unsupported or stale factual-claim count;
- retrieval p95 microseconds, timeout count, failure count, request/response
  bytes, prompt/evidence totals and maxima, and whole-transcript inclusion.

Abstention precision is true abstentions divided by every answer the model
marked as abstained. Abstention recall is true abstentions divided by every
question whose expected result is abstention. The implementation uses exact
integer ratios; a missing predicted or expected denominator fails that gate
instead of passing vacuously. The same arithmetic is applied independently to
the overall, EN, RU, and mixed groups whenever the group is applicable.

Both Recall@5 forms gate at 9/10. Automated and overall reports apply EN, RU,
and mixed locale gates; the real report applies EN and RU only. Both Recall@10
forms and nDCG@10 are reported only. Final-answer recall is a hard gate at 9/10
overall and separately for each applicable locale.

## Preregistered threshold decision

The threshold evaluator applies exactly these gates:

| Gate | Exact representation |
| --- | ---: |
| Micro block-locator Recall@5 | at least 9/10 |
| Complete-question Recall@5 | at least 9/10 |
| Both Recall@5 forms, each applicable locale | at least 9/10 |
| Complete final-answer recall, overall | at least 9/10 |
| Complete final-answer recall, each of EN / RU / mixed | at least 9/10 |
| Codename-free Recall@5 | at least 23/25 |
| Codename-free degradation from named-anchor Recall@5 | at most 1/20 |
| MRR@10 | at least 4/5 |
| Speaker accuracy | at least 19/20 |
| Exact-time accuracy | at least 19/20 |
| Citation membership | 1/1 |
| Citation entailment | 1/1 |
| Cross-scope leakage | 0 |
| Claim precision | at least 97/100 |
| Abstention precision | at least 19/20 |
| Abstention recall | at least 9/10 |
| Unsupported or stale factual claims | 0 |
| Retrieval p95 | at most 3,000,000 microseconds |
| Whole-transcript inclusion | 0 |
| Prompt bytes per question | at most 16,000 |
| Evidence bytes per question | at most 16,000 |
| Answerable execution and factual-claim coverage failures | 0 |

The 16 KB limits are the evaluation profile's preregistered bounds. They do not
claim equivalence to a different production serializer or production limit.

## Qualification gates still open

The canonical manifest deliberately records zero of three required exact-binding
real runs, zero independent question-review receipts, and zero independent
answer-adjudication receipts. Its status is fixed to `unqualified`.
The structural readiness evaluator binds the automated and human question-set
digests, corpus, root manifest, threshold profile, run result, and adjudicated
outcome digests. It rejects provider-free fixtures, mismatched bindings,
non-1/2/3 repetitions, failed thresholds, malformed digest structure, and fewer
than two independent review or adjudication records. Digest shape cannot prove a
real run, authorship, independence, or human review. The production-faithful
admission path verifies real Ed25519 signatures against explicitly pinned,
role-scoped keys. The predecessor synthetic-manifest readiness function remains
permanently unqualified and is not the trusted admission path.

Qualification still requires all of the following outside this provider-free
slice:

1. two independent reviews of the 40 candidate questions, with conflict
   adjudication where needed, bound to the exact corpus and question digests;
2. three real retrieval and production answer-runtime repetitions sharing one
   exact source, service, SDK, profile, model, runtime, tokenizer, corpus, and
   question binding;
3. independent per-claim answer adjudication receipts for those bound runs;
4. real ASR evidence if any ASR-system quality claim is desired;
5. the real load, cleanup, shadow, and rollout evidence required by the accepted
   Meeting Knowledge decisions.

Structural test outcomes are explicitly marked `synthetic_structural_fixture`;
their supported verdicts test arithmetic only and cannot self-certify support.
Real claim precision requires externally adjudicated outcomes bound into each
run. No fixture arithmetic, authored perfect outcome, provider-free test, or
digest-shaped placeholder can satisfy the residual gates.

Static leakage checks reject locator IDs, 40-to-64-character digest tokens,
synthetic marker vocabulary, and gold claim/locator identifiers in questions.
The automated answerable set freezes 25 codename-free and 75 named-anchor
questions. The codename-free stratum is content-matched at 8 EN, 12 RU, and 5
mixed questions. Codename ablation and leakage checks use Unicode-normalized,
case-folded token boundaries. Four question-specific same-codename negatives per
fact family plus canonical distractors form hard-negative authority independently
of gold relevance.

## Provider-free checks

Use exact Node `24.18.0` and pnpm `11.18.0`. On the hosted evaluation worker,
prepend the exact Node toolchain to `PATH` and invoke pnpm by its stable absolute
path so the package-manager version cannot drift:

```bash
PATH=/var/data/toolchains/node-v24.18.0/bin:$PATH /usr/local/bin/pnpm \
  --filter @discord-meeting/infinity-context-adapter \
  run test:semantic-quality-v4:gate

PATH=/var/data/toolchains/node-v24.18.0/bin:$PATH /usr/local/bin/pnpm \
  --filter @discord-meeting/infinity-context-adapter \
  run test:semantic-quality-v4

PATH=/var/data/toolchains/node-v24.18.0/bin:$PATH /usr/local/bin/pnpm \
  --filter @discord-meeting/infinity-context-adapter \
  run typecheck:prepared
```

The gate script runs the V4 Vitest files serially with an explicit bounded
`30,000 ms` per-test timeout. It includes hostile locator/turn, signature,
privacy, journal/resume/unknown-outcome, byte-bound, drift, three-repetition,
and cleanup assertions;
the timeout is not a qualification threshold and does not alter the 240-outcome
structural runner.

## Production-faithful real-run preflight

`test:semantic-quality-v4:real-preflight` is path-injected. It accepts no corpus
text on the command line and prints only digests, safe categories/counts,
structural ceilings, signed-receipt digests, and the frozen request snapshot.
The private schema must contain exactly 2,209 ordered turns, eight speakers, 40
questions (37 answerable, three abstention), 22 EN and 18 RU questions, declared
safe category counts, evidence IDs, and speaker/time metadata. Prose expected
answers are never scoring authority; they must be replaced by a pre-sealed
atomic-claim rubric. Two independent signed exact-binding review receipts are
mandatory.

The real corpus replaces the 40 synthetic review candidates. It never augments
them: one repetition is exactly 200 automated plus 40 real questions, and a
campaign is exactly three independent 240-question repetitions. Mixed-language
gates apply to the automated corpus only. Preflight builds a sealed
gold-turn-to-production-block mapping and stops before spend if complete
Recall@5 is structurally incapable of reaching 90% overall, EN, or RU.

The shared release-candidate request uses result limit 10, evidence limit
16,000 UTF-8 bytes, neighbor radius zero, candidate limit 100, at most four
queries, a 1,000 ms deadline, and a 16,384-byte response. Qualification and a
future canary must share its exact request snapshot. The full profile must be
`locator-v2-full-<index digest>` with healthy, qualified `postgres_keyword` and
`qdrant_dense` lanes; degraded, lexical-only, or drifted profiles fail closed.

Provider execution uses a create-only stable attempt ID derived from root
binding, repetition, and question ID. `provider_reserved` is fsynced before
bytes may cross the runtime boundary, followed by one create-only terminal
state. `outcome_unknown` is never resumable. The evaluator adds no cache or
retry; the production adapter permits only its existing single schema repair.
Private prompts, answers, evidence, and adjudication details belong in
caller-encrypted create-only content-addressed artifacts. Public manifests may
contain only safe counts, metrics, versions, digests, signatures, and cleanup
evidence.

All three repetitions must pass independently overall, per corpus, and per
applicable locale. Each repetition requires two independent signed
claim/citation adjudications and a third independent conflict resolver when the
first two decision digests disagree. A failed repetition cannot be averaged
away. Final admission requires identical bindings across repetitions and a
pinned signed derived-Infinity cleanup/canonical-absence receipt. This code does
not populate `ACCEPTED_TWO_HOUR_QUALIFICATION` and does not enable serving.

## Executable real campaign state machine

The cardinality is exact and non-additive: **200 automated + 40 independently
reviewed human questions = 240 outcomes per repetition, 720 outcomes across
three repetitions**. The real 40 replace the synthetic review candidates; no
command executes a further 40 questions.

The former `test:semantic-quality-v4:real-run` command is rejected. Each process
owns one phase and one create-only monotonic transition:

The production operator transport now lives under
`packages/infinity-context-adapter/src/quality-campaign`. Its command vocabulary
is `verify-bind`, `preflight`, `execute`, `resume`, `status`, `adjudicate`,
`adjudicate-resume`, `retention`, `cleanup-absence`, `final-admission`, and the
four isolated `holdout-*` phases. It emits only digest/count status receipts.
Exit 0 is completed, 20 is a safe custodian pause, 21 is an outcome with unknown
external effect, and 1 is invalid or failed. Private text is never a status field.

| Durable stage | Command | Successful meaning |
| --- | --- | --- |
| `prepared_admitted` | `real-execute` pre-provider admission | Exact release/corpus/rubric/reviewer/runtime bindings and three spend authorizations are bound |
| `executing` | `real-execute` | One stable attempt per question/repetition is being reserved and executed |
| `awaiting_adjudication` | `real-execute` | All 720 terminal raw outcomes and encrypted exchanges exist; exit 20 is a pause, not qualification |
| `adjudicated` | `real-adjudicate` | Two signed exact-outcome reviews exist for every answer, with an independent resolver for disagreement |
| `awaiting_retention` | `real-adjudicate` | The exact retained-artifact inventory binding is published; exit 20 |
| `retained_awaiting_cleanup` | `real-retention` | A signed retention receipt was consumed and a separately authorized derived-index cleanup request is published; exit 20 |
| `cleaned_awaiting_admission` | `real-cleanup` | Signed cleanup/canonical-absence evidence is durably retained; exit 20 is a pause, not qualification |
| `cleaned_qualified` | `real-final-admission` | Durable cleanup evidence and every independently signed admission input were consumed and every threshold passed locally |
| `terminal_unqualified` | `real-cleanup` | Evidence was retained and derived cleanup proved, but a local gate failed; exit 1 |

Every transition binds the exact root and previous transition digest. Files are
created with `O_EXCL`, fsynced, and exact-byte replay is idempotent. A changed
file, stale root, forked head, conflicting duplicate receipt, missing reviewer,
or skipped stage fails closed. A crash after fsync resumes from the new stage.
`provider_reserved`, `outcome_unknown`, or another terminal attempt is never
automatically retried. Resume/status commands do not construct retrieval or
answer ports.

The `awaiting_adjudication` create-only handoff contains question ID/digest,
repetition, stable attempt ID, terminal classification, and encrypted
evidence/answer/raw-outcome envelope digests only. It contains no transcript,
prompt, answer, evidence text, raw provider bytes, encryption key, credential,
or signing secret. Reviewers access the exact encrypted artifacts through the
controlled evidence workflow. The repository retains public Ed25519
verification material only.

No answer port exists while retrieval gates run. The spend receipt reserves 240
logical requests and at most 480 original-plus-repair executions, with 16,000
input bytes and 2,048 output tokens per execution. A caller cannot supply
`failedThresholdIds` or a free-form run-result digest.

The execution journal fsyncs each create-only file and its containing directory. Newly
created journal/artifact directories and their parents are fsynced too. After
crash/reopen, a reservation without an authenticated terminal envelope is
reported as `outcome_unknown`; it is never exposed as pending or resumable.
Runtime observations carry the same canonical
`sqv4-<sha256>` attempt derived from root + repetition + question.

Exact retrieval HTTP request/response bodies, original and executed-repair
runtime request/response bodies, original and repair model-input surfaces,
normalized response/runtime evidence, locally rehydrated evidence, answer, and
adjudication bytes use create-only A256GCM v1 envelopes authenticated by root,
attempt, artifact kind, key ID, plaintext digest, campaign/run, process,
endpoint/service, measured release, and exact exchange ordinal. A durable phase reservation
precedes each retrieval or answer provider boundary. Missing or tampered raw
exchange envelopes fail run reconstruction. Artifact retention, derived Infinity
deletion, and authoritative canonical absence remain distinct signed bindings.

The private decoder derives and exact-compares 37/3 answerable/abstention,
22/18 EN/RU, and category counts 8/8/7/5/5/4/3. Participant-map keys equal the
eight canonical speakers; involved speakers occur in cited evidence. The
declared transcript digest equals the raw transcript file. Five explicit time
windows are decoded and exact-compared with canonical evidence bounds.

The reviewer registry and release artifact binding are authenticated by an
Ed25519 release root supplied by the independent launcher on an inherited file
descriptor; no release-root key is stored in this workspace. The loaded SDK
entrypoint, dynamically imported Discord runtime, prompt mapper, tokenizer/config
module, and executing verifier module set are hashed from their resolved runtime
locations. A separately signed observation binds those measurements to the
campaign/run, stable attempt, current Node process, endpoints, service processes,
model identity, and ordinal contract. Infinity and subscription-runtime services
must additionally sign current-attempt attestations binding their running process,
service/image release, endpoint, workload identity, and the same nonce. Re-signing
the release-value map or hashing an unrelated configured artifact is insufficient.
Before a production brand is issued, independently signed per-exchange receipts
also bind the exact attempt, provider run, original/repair/retrieval ordinal,
request/response byte digests, campaign, process, endpoint, service generation,
model/prompt/tokenizer revisions, and sealed artifact ordinals. Pinned
registries reject duplicate Ed25519 public keys under different IDs.
Exact role schemas reject unknown fields, missing or unrelated receipts, and
uniform digest placeholders. Question/rubric, run/answer/evidence/adjudication,
retention, deletion, and absence bindings are verified independently.

The sole provider-capable executable is the repository-owned production composition in
`semantic-quality-v4-production-composition.ts`. Its strict operator file may
name only credentials, private/artifact/receipt paths, a campaign/run ID,
endpoints, and isolated scope topology. Configured SDK/runtime/image provenance
paths are not accepted. The composition loads the corpus and rubric, derives production
turn-to-block authority from current PostgreSQL plans, constructs the official
Infinity V2 adapter without transport injection, creates the concrete gRPC
grounded-answer runtime only after retrieval admission, and constructs the
journal and branded A256GCM store internally. External adjudication results are
accepted only with two exact-input/result signatures from anchor-authorized
reviewers; arbitrary JSON is never relabeled. It locally seals metric
applicability, thresholds, independently anchored provenance, capability bytes,
and all 240 prepared request snapshots. No operator-supplied port, reviewer-key
registry, scoring mapping, authority, or threshold is accepted. Its operator
configuration also names an absolute create-only `workflowRoot`; it cannot name
an executable implementation.

Use exact Node 24.18.0. Each command requires a distinct custodian handoff:

```bash
export PATH=/var/data/toolchains/node-v24.18.0/bin:$PATH
export pnpm_config_verify_deps_before_run=false

SEMANTIC_QUALITY_V4_OPERATOR_CONFIGURATION_PATH=/absolute/private/operator-configuration.json \
  /usr/local/bin/pnpm --filter @discord-meeting/infinity-context-adapter \
  run test:semantic-quality-v4:real-execute

SEMANTIC_QUALITY_V4_WORKFLOW_ROOT=/absolute/private/workflow \
SEMANTIC_QUALITY_V4_TRUST_ANCHOR_PATH=/absolute/public/release-anchor.json \
SEMANTIC_QUALITY_V4_PHASE_INPUT_PATH=/absolute/private/adjudication-phase.json \
  /usr/local/bin/pnpm --filter @discord-meeting/infinity-context-adapter \
  run test:semantic-quality-v4:real-adjudicate

SEMANTIC_QUALITY_V4_WORKFLOW_ROOT=/absolute/private/workflow \
SEMANTIC_QUALITY_V4_TRUST_ANCHOR_PATH=/absolute/public/release-anchor.json \
SEMANTIC_QUALITY_V4_PHASE_INPUT_PATH=/absolute/private/retention-phase.json \
  /usr/local/bin/pnpm --filter @discord-meeting/infinity-context-adapter \
  run test:semantic-quality-v4:real-retention

SEMANTIC_QUALITY_V4_WORKFLOW_ROOT=/absolute/private/workflow \
SEMANTIC_QUALITY_V4_TRUST_ANCHOR_PATH=/absolute/public/release-anchor.json \
SEMANTIC_QUALITY_V4_PHASE_INPUT_PATH=/absolute/private/cleanup-phase.json \
  /usr/local/bin/pnpm --filter @discord-meeting/infinity-context-adapter \
  run test:semantic-quality-v4:real-cleanup

SEMANTIC_QUALITY_V4_WORKFLOW_ROOT=/absolute/private/workflow \
SEMANTIC_QUALITY_V4_TRUST_ANCHOR_PATH=/absolute/public/release-anchor.json \
  /usr/local/bin/pnpm --filter @discord-meeting/infinity-context-adapter \
  run test:semantic-quality-v4:real-status
```

Exit `0` means a provider-free status query or final `cleaned_qualified`; exit
`20` means a successful durable pause awaiting a custodian; exit `1` means
terminal unqualified or a failed gate. Another nonzero exception means no later
transition was admitted. Neither exit 20 nor a provider-free structural pass is
a quality qualification. Cleanup scope is `derived_index_only`; the original
recording, accepted final transcript, and meeting database are never cleanup
targets.

## Remediation validation — 2026-08-25

The hosted validation used Node `v24.18.0` and pnpm `11.18.0`, confirmed by
`node --version` and `/usr/local/bin/pnpm --version` after setting
`PATH=/var/data/toolchains/node-v24.18.0/bin:$PATH`. The worker also set
`pnpm_config_verify_deps_before_run=false` because its read-only Corepack cache
cannot service pnpm's automatic dependency-status install; every pnpm command
below was still invoked through `/usr/local/bin/pnpm` at version `11.18.0`.

The exact documented gate command now covers `4` files and `54/54` tests with no
skips. This count includes constructor-name spoofing,
operator-generated key/synthetic-anchor, artifact substitution, and missing or
tampered exact-envelope attacks, plus nine hostile workflow crash/replay/root/
review/cardinality/retention-order cases.

The direct structural command
`/usr/local/bin/pnpm --filter @discord-meeting/infinity-context-adapter run test:semantic-quality-v4`
passed with exactly `240` outcomes. It reconstructed `200` automated questions,
`40` human-review candidates, `25` fact families, and `100` fact-family
negatives: exactly `25` each of `stale`, `contradictory`, `wrong_room`, and
`wrong_scope`. Its pinned digests were:

- root manifest: `e4ed7689cb399b0deeae0bcaf645afd336dbc9d9deccd0145c0dbb82a1a9dd17`;
- corpus: `f6b78fa91d1763519c5d3189e1b38b4f54060e4eb22ee1ae1dcfa86cd7e740f0`;
- automated question set: `465e81440b9be0b5d9321596ea1791307e93cba23f8cdfbd6c5a333c28a34c15`;
- human candidate set: `a8a2ee0782561c1aab2a2b7cb18430a6909bf4e52a4037e227402cc0593625b1`;
- fact-family negatives: `be626b92a996b4191e4bf92b8109500db461da6aa8dc48423dbf0a48bf01fb39`;
- threshold profile:
  `b39d24f57a99e86ff2ef30b8ef517cbc0146ebf43743d023bc6d562f63908390`.

The synthetic structural thresholds passed, but the result remained honestly
`unqualified` with blockers `exact_binding_real_runs`, `threshold_runs`,
`question_review_receipts`, `answer_adjudication_receipts`, and
`independent_evidence_unverified`. There are still zero of three exact-binding
real retrieval/production-model repetitions and zero independently human-reviewed
receipts for the 40-candidate set. No production-model or human qualification is
claimed.

The following exact-toolchain validations also passed:

- package `typecheck:prepared`;
- root `lint:type-aware` with warnings denied;
- `architecture:source` and `architecture:documentation` with Foundation
  `0.6.0` and zero diagnostics;
- `architecture:patterns` plus all `7/7` architecture pattern tests;
- the Meeting Core import boundary verifier and all `4/4` architecture-baseline
  tests.

If dependencies are unavailable, JSON parsing, cardinality probes,
`git diff --check`, and source line-count checks remain honest syntax and
determinism checks; they are not substitutes for Vitest or TypeScript.

## Hosted remediation validation — 2026-08-23

The hosted validation used Node `v24.18.0` and pnpm `11.18.0`, confirmed by
`node --version` and `/usr/local/bin/pnpm --version` after setting
`PATH=/var/data/toolchains/node-v24.18.0/bin:$PATH`. The worker also set
`pnpm_config_verify_deps_before_run=false` because its read-only Corepack cache
cannot service pnpm's automatic dependency-status install; every pnpm command
below was still invoked through `/usr/local/bin/pnpm` at version `11.18.0`.

The exact documented gate command ran twice consecutively. Both repetitions
passed `2` files and `32/32` tests with no skips: the first in `47.71 s` and the
second in `47.87 s`.

The direct structural command
`/usr/local/bin/pnpm --filter @discord-meeting/infinity-context-adapter run test:semantic-quality-v4`
passed with exactly `240` outcomes. It reconstructed `200` automated questions,
`40` human-review candidates, `25` fact families, and `100` fact-family
negatives: exactly `25` each of `stale`, `contradictory`, `wrong_room`, and
`wrong_scope`. Its pinned digests were:

- root manifest: `2ae979123e912128fd7ac90767319eb48da43323b825bbe3517378a3af704c5e`;
- corpus: `f6b78fa91d1763519c5d3189e1b38b4f54060e4eb22ee1ae1dcfa86cd7e740f0`;
- automated question set: `465e81440b9be0b5d9321596ea1791307e93cba23f8cdfbd6c5a333c28a34c15`;
- human candidate set: `a8a2ee0782561c1aab2a2b7cb18430a6909bf4e52a4037e227402cc0593625b1`;
- fact-family negatives: `be626b92a996b4191e4bf92b8109500db461da6aa8dc48423dbf0a48bf01fb39`;
- threshold profile: `aac253363462aff6f57cc79bfe3a680b1e39e00c93b9ab6dd4b0d98f8d77dd2e`.

The synthetic structural thresholds passed, but the result remained honestly
`unqualified` with blockers `exact_binding_real_runs`, `threshold_runs`,
`question_review_receipts`, `answer_adjudication_receipts`, and
`independent_evidence_unverified`. There are still zero of three exact-binding
real retrieval/production-model repetitions and zero independently human-reviewed
receipts for the 40-candidate set. No production-model or human qualification is
claimed.

The following exact-toolchain validations also passed:

- package `typecheck:prepared`;
- root `lint:type-aware` with warnings denied;
- `architecture:source` and `architecture:documentation` with Foundation
  `0.6.0` and zero diagnostics;
- `architecture:patterns` plus all `7/7` architecture pattern tests;
- the Meeting Core import boundary verifier and all `4/4` architecture-baseline
  tests.

If dependencies are unavailable, JSON parsing, cardinality probes,
`git diff --check`, and source line-count checks remain honest syntax and
determinism checks; they are not substitutes for Vitest or TypeScript.
