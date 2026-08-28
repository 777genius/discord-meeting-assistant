# Meeting Knowledge limits ledger

Status: rollout disabled pending deployed-revision acceptance evidence

Owner: Meeting Knowledge / Meeting Platform
Review date: 2026-09-13

These limits implement ADR-0034's bounded-only answer-model grounding.

| Field | Pinned value | Source and rationale |
| --- | ---: | --- |
| Runtime package | `@vioxen/subscription-runtime@0.1.0-main.27` | Audited launcher/runtime contract |
| Answer model | `gpt-5.6-sol`, medium | Dedicated answer profile; summary/conversation profiles forbidden |
| Coverage model | `gpt-5.6-sol`, medium | Dedicated semantic every-block evidence-selection schema; no lexical completeness claim |
| Coverage request bytes | 131,072 per block | Strict serialized runtime request ceiling; oversize blocks fail unsupported before transport |
| Coverage safe input | 65,536 UTF-8 byte upper-bound units per block | Conservative token ceiling bound to the extractor profile and checkpoint identity |
| Coverage output reservation | 2,048 tokens per block | Exact runtime profile maximum |
| Coverage provider deadline | 60 seconds per block | Timeout leaves the checkpoint incomplete; it never advances the coverage bitmap |
| Canonical evidence block | 4,096 UTF-8 bytes, 64 turns | Deterministic turn-aligned final-human evidence only |
| Exhaustive room plan | 2,048 blocks; 8,388,608 cumulative evidence-budget bytes | Questions and per-turn envelope overhead are included; over-budget plans fail unsupported before provider calls |
| Exhaustive checkpoint attempts | 8 | Fenced durable retry budget; exhaustion terminates without synthesis |
| Infinity SDK request deadline | 10 seconds by default; 60 seconds maximum | A fresh composed deadline is created for every official-SDK request; caller cancellation and timeout listeners/timers are removed after settlement |
| Infinity resumable operation deadline | 300 seconds by default; 600 seconds maximum | Separately bounds one index/delete/search attempt across up to 100 documents; exhaustion preserves deterministic mutations and returns to durable retry/reconciliation |
| Retrieval V2 focused snapshot | 100 source candidates; 10 provider-ordered results; 16,000 UTF-8 evidence bytes; zero downstream neighbors | Matches accepted ADR-0052. Indexed current-final sources participate under their exact persisted generation; bounded local exact lexical admission is a separately fingerprinted path. |
| Live exact-document reconciliation | Official contract `infinity.document-exact-reconciliation.v1`; published SDK 0.2.0 does not satisfy it | Live external projection remains fail closed until an externally released, pinned official SDK supplies exact document ID, idempotency ID, generation and scope reconciliation; scoped listing is forbidden for unknown outcomes |
| Live cleanup inventory | Exact operations first; cursor inventory only when exact deletion cannot enumerate | Every cursor page must make deterministic progress under the operation deadline and bounded worker admission; 100, 101 and 2,209-document disposable suites must restart and retire to zero |
| Infinity historical sync lease | operation deadline plus 30 seconds; 630 seconds maximum | Durable claim always outlives the separately bounded provider operation; the margin covers bounded local plan/checkpoint settlement and no accepted configuration permits operation deadline >= lease |
| Exhaustive reduction | fan-in 8; 1,024 calls | Deterministic lossless union of locally validated semantic selections |
| Exhaustive synthesis | 64 selected blocks; 256 canonical turns | No truncation: an over-limit relevant selection is unsupported |
| Local input measurement | UTF-8 byte upper bound v1 | Conservative fail-safe that cannot undercount ordinary text tokens; exact tokenizer qualification remains an activation gate |
| Model context accounting ceiling | 400,000 units | Capacity ceiling only; does not itself admit a request |
| Focused safe input | 300,000 upper-bound units | Applies only to bounded locally rehydrated evidence and leaves 100,000 units outside input |
| Reasoning reservation | 32,768 units | Explicit reasoning headroom |
| Answer output reservation | 2,048 tokens | Exact runtime profile maximum |
| Drift reservation | 32,768 units | Launcher/model/tokenizer drift headroom |
| Focused answer request bytes | 1,572,864 | Bounds transport and measurement for focused evidence only; transcript size cannot widen it and no truncation is allowed |
| Focused candidates | 24 composed references | Retrieval V2 contributes at most 10 provider-ordered identities; bounded local current evidence may fill the remaining composition cap, canonical identities are deduplicated, and every selected turn is locally rehydrated |
| Focused cross-source order | live rank 1, historical rank 1, live rank 2, historical rank 2, continuing to the 24-turn cap | Deterministic Meeting Knowledge composition; no comparison of local and provider score scales |
| Canonical neighbors | 0 for focused historical V2 and local exact lexical fallback | Neighbor selection is not performed downstream; Infinity candidate order is locator-only and canonical blocks are rehydrated exactly |
| Discord actor-key profile | `discord-meeting:infinity-actor-key:v1`, output prefix `dactor1` | Versioned secret keyring in Discord custody; active key salts index generations and retained keys support bounded rotation filters |
| Answer message | 2,000 characters | One Discord message, all-or-nothing |
| Provider deadline | 180 seconds | One stateless answer call; two durable job attempts maximum |
| Job expiry | 900 seconds | Bounds raw question and authorization-principal retention |
| Worker concurrency | 1 per singleton process | Direct PostgreSQL lease polling; generation fenced |
| Requester rate | 6/hour | Atomic database-time reservation |
| Guild rate | 120/hour | Atomic database-time reservation |

The retained deterministic two-hour positional corpus validates full-corpus
candidate scanning, bounded reference-only selection, local canonical
rehydration, distant corrections, RU/EN retrieval, exact boundary admission,
oversize refusal, and omission of two-hour transcript bulk, prefixes, summaries,
and candidate text from the model prompt. Production activation additionally requires a retained
benchmark on the exact deployed model/runtime/launcher and an official
private-test-guild zero-or-one create test. A changed value or identity requires
replaying both qualification sets and binding the evidence to the deployed
revision.

Historical retrieval of an authoritative meeting at or above 7,200,000 ms
(from earliest admitted human turn start to latest end) or 400 admitted human
turns has the separately versioned `meeting-knowledge.two-hour-historical-retrieval.v1` gate. It defaults disabled
and is checked before focused provider search and before focused/exhaustive
canonical rehydration. The general Infinity search flag cannot enable it.

Historical retrieval and `exhaustive_coverage` remain rollout-disabled even
with these executable limits. Production activation still requires immutable
official-SDK package integrity, retained live Infinity qualification, and a
retained benchmark for the exact model/runtime/launcher profile. A timeout,
malformed semantic extract, stale generation, authorization change, incomplete
bitmap, or capacity breach abstains; Local Final Reply never silently converts
focused top-k into a completeness proof.
