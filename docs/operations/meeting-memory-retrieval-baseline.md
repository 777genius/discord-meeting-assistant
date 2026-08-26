# Meeting memory retrieval migration baseline

Status: **unavailable / NO-GO**

Evidence date: 2026-08-22

Baseline source revision:
`bfe3ad5e80261275e2b3c7c0f464301d10a3f02c`

Baseline source tree:
`d03edcf3bd8d742539ddd7ac0ec6bf3145fca157`

## Result

The exact 200-question pre-migration retrieval and answer-quality baseline is
unavailable. No retrieval-quality, answer-quality, latency, or resource score
was measured, and none may be inferred from retained authored fixtures or the
older seven-question corpus.

The hosted baseline worker started from a clean exact checkout but could not
execute the suite:

- the worker had Node `24.16.0`; the repository requires
  `>=24.18.0 <25`;
- pnpm could not register its store because the available location was
  read-only;
- the checkout had no installed Vitest binary;
- the offline package cache was incomplete and network registry access was
  unavailable.

Executed semantic tests: **0**. Passed: **0**. Failed: **0**. No
semantic-quality result artifact was produced. These are unavailable metrics,
not zero-quality measurements.

The focused deterministic suite that was attempted contains 19 tests: 15
semantic evaluation tests and four semantic qualification tests. The captured
failed-attempt log digests were:

- pnpm attempt:
  `sha256:168b7da0fe7c7d71e56ebf00e750e8cda2b1ed2f4708c1195f53fe513db7fd99`;
- direct Vitest attempt:
  `sha256:700f9e2fc4dc0aad584dcc68e358ee842339fe524f41b4c2375ca454b30d788e`.

Those logs prove only why execution was blocked. They are not quality evidence.

## What the 200-question corpus actually contains

The retained generator in
[`semantic-quality-corpus.ts`](../../packages/infinity-context-adapter/test/semantic-quality-corpus.ts)
defines 421 synthetic human turns spanning `8,418,500 ms`, approximately
2h20m18.5s. It defines 200 authored questions: 100 answerable and 100
unsupported. Locale composition is 63 English, 62 Russian, and 75 mixed.

| Coverage | Retained corpus evidence |
| --- | --- |
| Languages | RU, EN, and mixed questions and transcript turns. |
| Speakers | Four synthetic speakers: Maria, Vitalii, Nazar, and Mark. |
| ASR noise | Seven profiled turns and 28 tagged answerable questions using authored stutters, `[audio drop]`, and `[crosstalk]`. This is textual simulation, not ASR-system output. |
| Overlap/interruption | Six timestamp-overlap positions and 24 tagged questions. |
| Corrections/contradictions | Narrow coverage: Fjord's stale 12-workspace value is corrected to nine; four answerable questions cover that fact family. Unsupported cases also include explicit negation. |
| Paraphrase | Questions avoid unique marker/sentinel wording and include natural paraphrases. |
| Multi-hop | Five answerable questions require distant evidence. |
| Speaker reference | 25 `speaker-reference` variants. |
| Temporal content | Dates, times, durations, and order appear, but the corpus has no distinct temporal tag or per-temporal-category score. |
| Unsupported | 100 quoted-question, explicit-negation, future-agenda, and open-question cases. |
| Prompt injection | One synthetic transcript instruction-injection turn. |

This is a substantial synthetic corpus, but it is not statistically broad in
every category. Correction/contradiction coverage is concentrated in one fact
family, and its ASR noise was authored rather than emitted by an ASR system.

## Metrics that remain unavailable

| Metric | Current harness support | Baseline value |
| --- | --- | --- |
| Recall@5 | Overall and per locale | Unavailable |
| Recall@10 | Not implemented | Unavailable |
| MRR / nDCG | Not implemented | Unavailable |
| Speaker/time accuracy | Citation speaker and exact timestamp checks exist; question-category accuracy does not | Unavailable |
| Abstention precision/recall | Implemented | Unavailable |
| Citation membership | Fail-closed bounded-evidence validation exists; no aggregate metric | Unavailable |
| Citation validity, claim precision, answer recall | Implemented but requires independent adjudication | Unavailable |
| Prompt bytes | No distinct metric | Unavailable |
| Evidence/request bytes | Full serialized request bytes only; no evidence-only split | Unavailable |
| Retrieval, generation, total latency | p50/p95/max support exists | Unavailable |

The `perfectOutcome` values in
[`semantic-quality-evaluation.test.ts`](../../packages/infinity-context-adapter/test/semantic-quality-evaluation.test.ts)
are authored inputs that test evaluation arithmetic, repetition handling, and
receipt validation. They are not retrieval or model outputs. The harness also
sets `productionQualityQualified: false`; a generated answer artifact remains
pending independent adjudication.

## Why the legacy corpus is not this baseline

The older qualification corpus has seven focused questions over 421 turns and
requires Recall@5 of `1.0`. Its retained manifest reports 7/7 with cleanup.
That corpus has a different question set, purpose, release, and qualification
contract. It does not establish the 200-question pre-migration baseline,
population-level retrieval quality, migration parity, or rollout readiness.

Likewise, the 200-question delivery plan calls for preregistered gates but does
not retain numeric acceptance thresholds. Thresholds must be approved before a
new run; they cannot be selected after observing results.

## Required later execution

Use the repository's pinned Node version and installed dependencies, plus a
disposable Infinity HTTP service with a release-attested, non-mock Qdrant
embedding profile. The retrieval command is:

```bash
INFINITY_CONTEXT_SEMANTIC_E2E_DISPOSABLE=YES_DELETE_ALL_TEST_DATA \
INFINITY_CONTEXT_SEMANTIC_E2E_URL=http://DISPOSABLE_SERVICE_ROOT/ \
pnpm --filter @discord-meeting/infinity-context-adapter run test:semantic-quality
```

Answer evaluation without a paid model runs only when an approved non-paid,
authenticated transport is also available; otherwise the answer run remains
pending. Its environment is:

```bash
INFINITY_CONTEXT_SEMANTIC_ANSWER_E2E=1
INFINITY_CONTEXT_SEMANTIC_ANSWER_TRANSPORT_MODULE=/absolute/transport/module
INFINITY_CONTEXT_SEMANTIC_E2E_REPETITION=1
INFINITY_CONTEXT_SEMANTIC_E2E_RUN_ID=...
```

The later qualification must:

1. verify exact source, SDK, service, capability fingerprint, index profile,
   corpus, question-set, and cleanup identities;
2. run all 200 questions and retain Recall@5 overall/per-locale plus abstention,
   byte, and latency metrics;
3. add or explicitly waive Recall@10, MRR, nDCG, prompt/evidence byte split,
   and per-category speaker, temporal, correction, contradiction, multi-hop,
   and unsupported reporting;
4. repeat the identical binding at least three times and retain distributions;
5. independently adjudicate every answer before reporting citation validity,
   claim precision, answer recall, or answer abstention quality;
6. compare the preregistered baseline and post-migration runs without mixing
   legacy and locator-only candidate sets;
7. retain separate real-population evidence required by ADR-0045 and ADR-0037.

Until that work is executed and accepted, the exact evaluation state remains
**NO-GO**.

The later provider-free V4 corpus, hashing, and metric harness is documented in
[`meeting-memory-quality-v4.md`](meeting-memory-quality-v4.md). It adds no
measurement to this unavailable baseline and remains explicitly unqualified.
