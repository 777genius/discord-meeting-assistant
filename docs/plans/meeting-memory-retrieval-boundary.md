# Meeting memory retrieval boundary migration

Status: downstream deletion implemented; **deployment blocked pending the
checked ADR-0049 step-7 drain receipt**

Date: 2026-08-22

Owner: Meeting Knowledge, with upstream Infinity Context delivery and
Publishing/Conversation collaboration at their existing boundaries

Decision: [ADR-0049](../decisions/0049-locator-only-upstream-retrieval.md)

Baseline: [200-question baseline evidence note](../operations/meeting-memory-retrieval-baseline.md)

## Outcome and scope

Replace the duplicated historical retrieval mechanics introduced by PR #60
with an additive, purpose-specific, locator-only Infinity Context boundary.
Keep Meeting Knowledge authoritative for admission, alias resolution, local
current/hot evidence, final evidence composition, canonical rehydration,
citations, answer validation, and abstention. Keep Publishing authoritative for
durable Discord effects and Conversation authoritative for cancellation and
playback.

The original plan did not itself authorize implementation or deployment. The
2026-08-26 deletion slice is separately reviewed; deployment still requires the
operational drain receipt below.

## 2026-08-26 exact deletion disposition

| Symbol/file | Disposition | Deletion status |
| --- | --- | --- |
| `HistoricalFocusedRetrieval`, `FocusedRetrievalPolicyV1`, `DEFAULT_FOCUSED_RETRIEVAL_POLICY`, `validateFocusedRetrievalPolicy` | Generic downstream historical query engine | Deleted from Meeting Core and public exports. |
| `decomposeHistoricalQuery`, `mergeQualifiedHistoricalSearchResults`, `rerankHistoricalBlocks`, `normalizeProviderScore`, lexical/speaker/temporal score helpers and neighbor propagation | Query decomposition, score normalization/fusion and downstream reranking | Deleted. New V2 admission persists one unweighted `original-question`. |
| `SameRoomFocusedMemoryRetrieval`, `crossSourceRank`, `scoreFor`, `normalizedScore` | Legacy current/historical score fusion | Deleted. V2 composition uses deterministic provider order and explicit current/historical interleave bounds. |
| `HistoricalMemoryPort.searchRoom`, `InfinityContextHistoricalMemoryAdapter.searchRoom`, `validSearchRequest`, `candidateLocators`, `isHybridQualified` | Text-bearing `/v1/search` semantic read route and diagnostics qualification | Deleted from production ports and adapter. Indexing and deletion remain. |
| `FocusedMemoryReference.relevanceScore`, `decodeRelevanceScore` | Downstream provider/local score propagation | Deleted. Canonical reference identity and order remain. |
| `legacyRetrievalMigration`, rollout basis points, legacy profile selection, `PersistedRetrievalBindingRouter` | Constructible legacy migration routing for new jobs | Deleted. New admission is V2-only. |
| persisted protocol-1 bindings and `infinity_locator_v1` / `legacy_downstream_v1` literals | Historical schema readability | Retained only in codecs/value objects; `isComposedLocalBinding` rejects them, so execution fails closed. Delete only after a checked drain and retention review. |
| old `/v1/search` semantic qualification harnesses | Evidence for deleted behavior | Deleted or narrowed to indexing/deletion support. The production-composition E2E is back in default compilation and test discovery and uses only `/v1/context/retrieve` for focused reads. |

Deployment requires a retained check proving zero nonterminal or leased
old-path jobs, zero unresolved old-path effects, expired rollback, and drained
old-profile deletion. The repository snapshot contains no such operational
receipt, so this is a hard deployment blocker rather than an inferred pass.

## PR #60 audit identity and completeness

PR #60 merged as `7aa15f8aa2530d83d7e582af13b6ca1b487d05a8` with
first parent `986f9903193a5ded87a061f60431ee1ab2d62383` and PR head
`ff4d3b54f64edd10e64888abeb0e139efbbdec7f`. This ledger classifies
the PR's first-parent production delta: 31 production files and
`+1,218/-334` lines.

All changed declarations are classified below. Imports and the
`meeting-knowledge/index.ts` barrel changes inherit the classification of the
underlying declaration and are not counted as separate production symbols.
Test-only changes are preserving evidence, not migration targets.

Classification meanings:

- `KEEP_*`: ownership and behavior remain at the named downstream boundary.
- `REWRITE_*`: preserve the downstream authority but narrow it to mapping,
  orchestration, or named local canonical behavior.
- `MOVE_TO_INFINITY`: implement and qualify the generic mechanic upstream
  before removing the downstream copy.
- `DELETE_AFTER_MIGRATION`: transitional behavior with the deletion gate below;
  it is not a fallback design.

## Complete production-symbol migration ledger

| Class | PR #60 file and changed symbol(s) | Target owner and dependency/contract | Preserving test or proof | Order and deletion gate |
| --- | --- | --- | --- | --- |
| `REWRITE_AS_THIN_ACL` | `apps/meeting-platform/src/composition/grounded-answer.ts`: `createPlatformGroundedMeetingAnswer`; `apps/meeting-platform/src/composition/meeting-knowledge.ts`: `createGroundedAnswerGenerator`, `createMeetingKnowledgeLocalFinalReply` | Meeting Platform composition accepts Meeting Knowledge's resolved question-speaker binding and wires the grounded-answer use case. The full configured alias map no longer enters provider options. | Subscription Runtime knowledge-answer contract name-binding/privacy tests and production composition E2E. | Phase 3, serve in Phase 5; remove raw-alias overload only at Phase 7. |
| `REWRITE_AS_THIN_ACL` | `apps/meeting-platform/src/composition/historical-memory.ts`: `createPlatformHistoricalMemory` | Infinity ACL maps an authorized scope, explicit query variants, opaque actor/time hints, and bounds to `LocatorOnlyRoomRetrievalPortV2` backed only by `/v1/context/retrieve`. | Production composition locator-only SDK to local-rehydration E2E; cross-room and generation tests. | Phase 3; delete `/v1/search` read path only at Phase 7. |
| `KEEP_IN_DISCORD_PROFILE_CUSTODY` | `discord-infinity-actor-keys.ts`: `DiscordInfinityActorKeys`, `decodeDiscordInfinityActorKeyring`; `apps/meeting-platform/src/composition/discord-infinity-actor-custody.ts`: `participantRetrievalAliasOwners` | Discord profile custody retains configured identities/names and maps each snowflake through a versioned purpose-scoped HMAC keyring. Projection uses the active actor key; alias filters use the same authority and retained rotation keys. | Discord keyring stability/rotation/fail-closed tests; production V2 composition inspects projection and request `actor_keys` for identical opaque values and snowflake/name leakage. | Keep. A key rotation changes the actor-key profile and therefore the historical index generation; missing authority disables the Infinity slice. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `answer-grounded-meeting-question.ts`: `AnswerGroundedMeetingQuestion.prepareFocused`; `historical-exhaustive-memory.ts`: `HistoricalExhaustiveMemoryRetrieval.retrieve` | Bind selected blocks to exact release/generation/locator identities. Focused/exhaustive routing and complete every-block coverage remain answer-authority policy. | Grounding-plan, historical-exhaustive, universal/absence, and voice-authority tests. | Keep. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `final-reply-checks.ts`: `referencesFromPlan`, `sameEvidenceSource`, `planUsesHistoricalEvidence`, `planEvidenceIsCurrent`; `publish-final-reply.ts`: `PublishFinalReply.publishCandidate` | Recheck local evidence generation and authorization before generator execution and before requesting a Publishing effect. The durable effect itself remains Publishing-owned. | Historical-generation E2E, publication fences, and zero-generator/zero-create after supersession. | Keep. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `grounded-question-internals.ts`: `deduplicateEvidenceTurns`; `select-focused-evidence.ts`: `focusedHydrationMatchesReferences`; `grounding-plan-internals.ts`: `compareCanonicalTurns`, `canonicalSourceKey`, `normalizeEvidenceSource`, `normalizeRehydratedTurns`; `focused-memory-contract.ts`: `focusedMemoryReferenceKey`, `decodeHistoricalSource`, `candidateKey`; `same-room-focused-memory.ts`: `referenceKey` | Canonical source identity, exact reference matching, and local identity deduplication are evidence mechanics, not relevance ranking. | Grounding-plan, post-selector rehydration, source-ordering, and codec tests. | Keep. Duplicate locator ownership must fail closed rather than use last-write-wins. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `domain/historical-evidence-source.ts`: `HistoricalEvidenceSource`, `historicalEvidenceSourceKey`; `domain/grounding-plan.ts`: `FocusedMemoryReference.historicalSource`, `RehydratedEvidenceTurn.source.historicalSource` | Persist exact local release/index/locator provenance for restart and freshness checks. Retrieval provenance from Infinity is diagnostic only. | Grounding-plan codec round-trip, partial-triple rejection, and cross-meeting ordering. | Keep. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `historical-focused-refresh.ts`: `refreshStrictFocusedBlocks`; `historical-retrieval.ts`: `HistoricalFocusedRetrieval.rehydrateCandidates`; `ports/historical-state.ts`: `HistoricalSyncStore.findCurrentCandidates`; `postgres-historical-memory-store.ts`: `PostgresHistoricalMemoryStore.findCurrentCandidates` | Batch lookup, desired-generation checks, accepted-final loading, retention checks, and canonical local rehydration stay downstream. | Stale/cross-room/generation-fence, deletion, and restart tests. | Keep; reject ambiguous or duplicate locator ownership. |
| `REWRITE_AS_THIN_ORCHESTRATOR` | `historical-retrieval.ts`: `HistoricalFocusedRetrieval.constructor`, `buildPlan`, `rehydratePlanNeighborhood` | Meeting Knowledge authorizes, calls `LocatorOnlyRoomRetrievalPortV2`, then rehydrates exactly returned locators. Historical neighbor choice moves upstream; local range/hash expansion occurs only when required by canonical evidence policy. | Authorization, excluded-current-source, stale-generation, local-rehydration, and abort tests. | Phase 3 to 5; delete old orchestration at Phase 7. |
| `REWRITE_AND_SPLIT_POLICY` | `historical-retrieval-policy.ts`: `FocusedRetrievalPolicyV1`, `FocusedRetrievalPolicyInputV1`, `DEFAULT_FOCUSED_RETRIEVAL_POLICY`, `isBoundedInteger`, `validateFocusedRetrievalPolicy` | Split generic query/fan-out/output/deadline maxima into the exact Infinity fingerprint and retain stricter Meeting Knowledge evidence-byte, selector, exhaustive, voice, and local canonical limits. | Exact-bound/one-over, no-clamping, selector-input, and answer-budget tests. | Define in Phases 1 and 3; retire unchanged v1 identity at Phase 7. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `historical-retrieval-ranking.ts`: `decomposeHistoricalQuery` | Meeting Knowledge constructs explicit meeting-question variants. Infinity executes supplied variants but does not infer meeting vocabulary, aliases, locale policy, or focused/exhaustive semantics. | RU/EN query construction, exhaustive-routing, and question-policy tests. | Keep under a new explicit policy identity; remove provider execution and generic reranker token mechanics from this helper. |
| `MOVE_TO_INFINITY` | `historical-retrieval-ranking.ts`: `minimumQualifiedScore`, `mergeQualifiedHistoricalSearchResults`, `rerankHistoricalBlocks`, `normalizeProviderScore`, `ignoredQueryTokens`, `relevantQueryTokens`, `lexicalScore`, `speakerScore`, `temporalScore`, neighbor score propagation | Infinity owns provider score provenance, generic lexical token preparation, registered opaque actor/time boosts, indexed-lane fusion, deterministic ranking, diversity, and same-source historical neighbor expansion under one fingerprint. | Move generic fusion, lexical-token, score, temporal, speaker-key, diversity, and neighbor fixtures upstream; retain local privacy/authority assertions. | Implement Phase 1, qualify Phase 4, then delete the downstream copies at Phase 7. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `historical-retrieval-ranking.ts`: `isRequestedMeeting`, `retainStrictSourceSubsets`, `historicalSourceKey`, `blockBytes` | Authorized source selection, excluded-current-source handling, canonical source identity, evidence-byte bounds, and the full-source prohibition remain downstream. Full-source suppression returns explicit `full_source_forbidden`/insufficient evidence. | Cross-room/current-source denial, full-source, and exact evidence-budget tests. | Keep; remove score-based side effects during Phase 3. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `speaker-alias-resolution.ts`: `SpeakerAliasMapV1`, `RequestedSpeakerAliasV1`, `AliasQuestionSpan`, `AliasCandidate`, `ambiguousEnglishAliasTokens`, `resolveRequestedSpeakerIds`, `resolveRequestedSpeakerAliases`, `matchAlias`, `hasConflictingOwner`, `aliasMentionIsUnambiguous`, `contiguousAliasSpan`, `escapeRegExp`, `orderedTokens` | Participant alias parsing and ambiguity rules are meeting-question semantics. A successful local resolution yields canonical opaque actor keys; Infinity may filter/boost those keys but never parses names or aliases. | Alias ambiguity, ordinary-mention rejection, RU/EN names, conflicting owner, and provider-prompt anonymity tests. | Keep. Narrow the upstream request mapping in Phase 3. |
| `DELETE_AFTER_MIGRATION` | `domain/grounding-plan.ts`: `FocusedMemoryReference.relevanceScore`; `focused-memory-contract.ts`: `decodeRelevanceScore`; `same-room-focused-memory.ts`: `scoreFor`, `normalizedScore` | Persisted evidence authority needs ordered locator/source/hash identity, not an uncalibrated cross-boundary relevance value. Upstream contributions remain bounded retrieval diagnostics outside the grounding plan. | Codec migration and deterministic order tests; no provider score in durable citation identity. | Delete only at Phase 7 after old jobs drain. |
| `REWRITE_AS_IDENTITY_MAPPING` | `same-room-focused-memory.ts`: `historicalPriorityCandidates`, `deduplicate`; `focused-memory-contract.ts`: `mergeFocusedHydrationReferences`, `decodeCandidates` | Retain local canonical binding and identity dedupe. Remove block-to-turn score decay and max-score arbitration. | Reference-only boundary, canonical hydration, source binding, and duplicate-locator tests. | Phase 3 to 5; old scoring branches deleted at Phase 7. |
| `DELETE_AFTER_MIGRATION` | `same-room-focused-memory.ts`: `crossSourceRank` | Final local current/hot plus historical composition remains Meeting Knowledge, but direct comparison of unrelated score scales does not. Replace it with an explicit versioned source quota/order and freshness policy. | Current-only, historical-only, mixed-source, stale-hot-tail, and deterministic source-policy tests. | Replacement in Phase 3; delete old comparator at Phase 7. |
| `REWRITE_AS_BOUNDED_CANONICAL_LOCAL` | `postgres-focused-memory-retrieval.ts`: `ScoredTurn`, `maximumQueries`, `minimumRelevanceScore`, `ignoredQueryTerms`, `termRoot`, `searchableTerms`, `queryTerms`, `scoreTurns`, `compareScored`, `selectFocusedTurns`, `referenceFor`, `PostgresFocusedMemoryRetrieval.constructor`, `retrieve` | Current/hot evidence has no Infinity admission surface. Meeting Knowledge retains a named bounded canonical exact/lexical selector with generation/human checks and explicit telemetry. It is never reported as hybrid or used as a permanent historical semantic reranker. | Current generation, human-only, corrections, RU/EN exact/lexical, abort, text-free reference, boundedness, and never-widen tests. | Rewrite in Phase 3. Historical fallback is the named mode or abstention; old generic formulas delete at Phase 7. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `postgres-final-reply-evidence.ts`: `PostgresFinalReplyEvidence.rehydrateSelectedEvidence`; `postgres-final-reply-historical-evidence.ts`: `ReferencedMeetingRow`, `CurrentHistoricalPlanRow`, `loadCurrentHistoricalReferenceRows`, `historicalReferenceMatches` | PostgreSQL authoritative snapshots, accepted plan, current release/generation, room/scope, range/hash, and human checks remain local. | Historical-generation E2E and post-selector exact rehydration. | Keep. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `postgres-historical-release-acceptance.ts`: `HistoricalMeetingMutationRow`, `acceptHistoricalReleaseInTransaction` | Durable desired generation, acceptance, supersession, and withdrawal are downstream index-intent authority, not retrieval ranking. | Historical sync replay, supersession, deletion, and transaction tests. | Keep; dual-write profile intent is added only in a later implementation slice. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `postgres-meeting-knowledge-codecs.ts`: `historicalEvidenceSourceSchema`, `groundingEvidenceSchema`, `decodeGroundingPlan` | Persist exact canonical historical source provenance for restart and pre-effect freshness validation. | Round-trip, hostile payload, and partial-triple rejection tests. | Keep. |
| `KEEP_IN_MEETING_KNOWLEDGE` | `knowledge-answer-request-mapper.ts`: `commonKnowledgeAnswerSystemPrompt` | Claim/citation rules, anonymous meeting/speaker references, and non-disclosure are grounded-answer policy. | Name-binding, citation, prompt-injection, and meeting-relative timestamp tests. | Keep. |
| `REWRITE_AS_THIN_ACL` | `knowledge-answer-request-mapper.ts`: `KnowledgeAnswerRequestOptions`, `buildSubscriptionRuntimeKnowledgeAnswerRequest`; `subscription-runtime-grounded-answer-adapter.ts`: `SubscriptionRuntimeGroundedAnswerAdapterOptions`, `validateRequestOptions` | Accept only already-resolved question speaker bindings and canonical anonymous evidence. Do not retain or forward the complete configured alias map. | Subscription Runtime privacy, attestation, request-size, and malformed-option tests. | Phase 3 to 5; remove raw alias option only at Phase 7. |

The ledger covers every PR #60 production file. Specifically, it covers five
Meeting Platform files, eighteen Meeting Knowledge files including the barrel,
six PostgreSQL adapter files, and two Subscription Runtime adapter files.

## Reply-to-answer call graph

```text
Discord messageCreate
  -> DiscordLocalFinalReplyHandler
     transport checks; opaque principal
  -> AdmitCurrentFinalReply
     fresh authorization; exact projection/binding; durable question job
     atomically bind immutable retrievalPath/profileFingerprint/cutoverEpoch
     before first execution
  -> ProcessFinalReplyJob
     fresh authorization and binding; reuse the persisted retrieval binding
     -> Meeting Knowledge question policy
        focused/exhaustive; aliases -> opaque actor keys; authorized sources
     -> in parallel where policy permits
        -> canonical current/hot selector -> text-free local references
        -> Infinity ACL -> POST /v1/context/retrieve
           -> indexed lanes/fusion/ranking/neighbors -> locator-only candidates
     -> Meeting Knowledge final composition
        source/freshness policy; no cross-scale score comparison
     -> PostgreSQL canonical rehydration and reauthorization
     -> SelectFocusedEvidence or exhaustive coverage
     -> GroundedMeetingAnswer
        authority recheck; bounded canonical turns; strict citations
     -> PublishFinalReply
        authority recheck
        -> Publishing DurableAnswerPublication
           reserve -> request_started -> one Discord create/reconcile

Conversation addressed question
  -> Conversation-owned GroundedKnowledgeAnswerPort
  -> the same Meeting Knowledge eligibility/rehydration/answer boundary
  -> Conversation authority recheck, cancellation, literal TTS, playback
```

Remote Infinity text never appears on this graph. PostgreSQL accepted transcript
turns are the only citation text.

## Shadow, cutover, rollback, and deletion sequence

### Phase 0: accepted decisions and preregistration

- Accept ADR-0049 in Discord and a corresponding upstream Infinity ADR.
- Pre-register exact security, quality, performance, and fallback metrics and
  numeric thresholds. The currently unavailable 200-question metrics cannot be
  invented after the run.
- Keep every behavior flag disabled.

### Phase 1: upstream locator-only capability

- Add `/v1/context/retrieve` without changing `/v1/search`.
- Publish exact SDK request/response types and reject every unknown field.
- Use the single `retrieval-capability-fingerprint.v1` algorithm: remove only
  the top-level `capability_fingerprint` member from the strict capability
  object; preserve array order; recursively sort every object key by unsigned
  UTF-8 byte order; serialize the result as compact `JSON.stringify` JSON
  encoded as UTF-8; and emit its lowercase hexadecimal SHA-256 digest. The
  producer emits that digest in both the capability document and every
  retrieval response. Consumers recompute it from the exact capability before
  accepting the emitted value; any field, value, order, or digest mismatch is
  unqualified.
- Implement fingerprinted multi-query execution, indexed-lane fusion,
  provenance, typed filters/boosts, ranking, and same-source neighbors.
- Prove keyword and dense lanes use real feature adapters and prove reuse with
  at least one non-meeting corpus.

### Phase 2: new profile and safe projection migration

- Introduce a new identity-bearing projection/index profile with the generic
  locator attributes from ADR-0049.
- Dual-write only locally admitted final-human evidence and rebuild every
  eligible current release.
- Keep deletion reconciliation active for both profiles. Partial rebuild or
  ambiguous deletion cannot serve.

### Phase 3: downstream ACL and shadow

- Add the thin consumer-owned locator retrieval port and official SDK ACL.
- Run the new query only after ordinary Meeting Knowledge authorization.
- Canonically rehydrate and reauthorize its locators, but do not pass shadow
  results to selection, generation, Publishing, Conversation, or user output.
- Retain locator digests, reason codes, fallback mode, and aggregate metrics;
  retain no question, alias, transcript, provider payload, or raw locator.

### Phase 4: qualification gate

- Pass the gates below on the exact SDK, service, source tree, profile,
  capability fingerprint, dataset, and release.
- Investigate disagreements within a bounded, preregistered process.
- A missing baseline remains NO-GO; authored fixtures are not substitutes.

### Phase 5: final-reply canary and rollback

- Canary final Discord replies at staged percentages before voice.
- At admission, before first execution, deterministically select and atomically
  persist immutable `{retrievalPath, profileFingerprint, cutoverEpoch}` on the
  durable question job. The selection uses stable job identity and the named
  cutover epoch; no worker-local or execution-time percentage choice is valid.
- Retries, lease recovery, and resumed or replacement workers must reuse that
  persisted binding. A missing or conflicting binding fails closed instead of
  selecting from the current rollout configuration.
- Select exactly one candidate path per request. Never union or rerank legacy
  and new candidate sets.
- One read flag rolls admission of only not-yet-bound jobs back to the PR #60
  path under a new named cutover epoch. Already-bound jobs continue on their
  immutable path and profile. Dual-write, rebuild, and deletion continue during
  rollback so derived state remains reconcilable.
- Report `infinity_locator`, `canonical_local_exact_lexical`, and `abstained` as
  distinct outcomes. Local mode is never hybrid success.

### Phase 6: voice canary

- Begin only after final-reply stability.
- Apply stricter latency, cancellation, replacement, no-late-PCM, and
  playback-authority gates.
- Rollback disables new voice use without changing final-reply or deletion
  reconciliation.

### Phase 7: exact deletion point

Delete the old generic reranker and `/v1/search` retrieval adapter only when all
of these are simultaneously proven:

- new reads have remained at 100% through two qualified releases;
- the rollback window has explicitly expired;
- no old release pod or worker exists;
- zero old-path jobs are nonterminal or leased after at least the 900-second
  job-retention and 540-second lease windows;
- zero old-path effects are unresolved, including unknown outcomes awaiting
  reconciliation;
- retained terminal old-path job and effect audit rows are explicitly excluded
  from both zero gates and need not be deleted;
- old writes have stopped and old-profile deletion/reconciliation is fully
  drained;
- retained evidence binds those facts to the deployed release.

Then delete `mergeQualifiedHistoricalSearchResults`,
`rerankHistoricalBlocks`, `normalizeProviderScore`, `ignoredQueryTokens`,
`relevantQueryTokens`, historical `lexicalScore`, `speakerScore` and
`temporalScore`, historical neighbor propagation, `crossSourceRank`,
diagnostics-derived `isHybridQualified`/`candidateLocators`, relevance-score
persistence, and the adapter's `/v1/search` call. The 2026-08-26 slice deleted
those symbols plus `decomposeHistoricalQuery`. Keep alias resolution, hard
source selection, exhaustive routing, bounded exact-token current/hot fallback,
deterministic final composition, rehydration, citations, abstention, Publishing
effects, and Conversation playback.

## Security gates

- The SDK schema and hostile-wire tests prove responses cannot contain text,
  snippets, citations, arbitrary metadata, answer content, query echoes, alias
  echoes, or unknown fields, including in diagnostics and telemetry.
- Forged scope/source keys, cross-tenant and cross-room access,
  excluded-current-source bypass, stale profile/generation replay, locator
  tampering, duplicates, and cross-source neighbor expansion fail closed.
- Fuzz typed filters, operators, arrays, UTF-8 sizes, duplicates, numbers,
  timestamps, enums, cursor/response amplification, and malformed provenance.
- Test startup-qualified then per-request fingerprint/profile/lane downgrade.
- Prove admission persists one immutable retrieval binding before execution,
  deterministic canary selection is stable, and retry, lease recovery, worker
  resumption, and rollback cannot change a bound job's path, fingerprint, or
  cutover epoch.
- Prove revocation between query, rehydration, generation, effect reservation,
  Discord send, and voice playback denies the later action.
- Prove timeout, retry, canary, and rollback cannot cause two Discord creates or
  two voice playbacks.
- Prove authorized deletion progresses with retrieval/indexing disabled or an
  invalid capability.

## Performance gates

- Benchmark p50/p95/p99 and hard deadline/cancellation with real disposable
  PostgreSQL, keyword retrieval, Qdrant, official SDK transport, one original
  question, zero neighbor expansion, and at least 40 meetings/500 blocks.
- Include concurrent Discord and voice load plus shadow doubling.
- Bound CPU, memory, database calls, fan-out, pagination, and response bytes
  when most top candidates are stale or unauthorized.
- Qualify rebuild and deletion throughput/recovery at the 500-document bound.
- Bind thresholds and results to the exact fingerprint and release; a unit test
  of request-local lexical caching is not an endpoint performance result.

## Evaluation gates

- Run the exact 200-question corpus baseline and post-migration comparison on a
  disposable, release-attested, non-mock profile with verified cleanup.
- Report Recall@5 overall and per locale, abstention precision/recall, citation
  membership, request/evidence bytes, and retrieval/generation/total latency.
- Add or explicitly waive Recall@10, MRR, nDCG, distinct prompt/evidence bytes,
  and per-category speaker/temporal/correction/contradiction/multi-hop metrics.
- Repeat the identical binding at least three times and retain distributions.
- Independently adjudicate answers before reporting claim precision, answer
  recall, citation validity, or answer abstention quality.
- Retain separate real-population retrieval evidence required by ADR-0045 and
  ADR-0037; the synthetic corpus does not qualify population-level serving.

Authored `perfectOutcome` objects validate evaluation arithmetic only. The
legacy seven-question 7/7 recall manifest validates a different corpus and is
not migration readiness, parity, or 200-question retrieval quality evidence.

## Exact GO/NO-GO state

**Infinity Context is conditional GO for upstream-first contract work and
NO-GO for reusing `/v1/search`.** Work may start only with an accepted upstream
ADR, additive `/v1/context/retrieve`, exact SDK/fingerprint, generic vocabulary,
real keyword/dense feature paths, and reusable non-meeting proof. Authorization,
alias resolution, exhaustive routing, evidence, citations, Publishing, and
Conversation policy must not move upstream.

**Discord Meeting Assistant at parent `bfe3ad5e80261275e2b3c7c0f464301d10a3f02c`
is NO-GO for behavior-changing implementation.** Shadow-only integration is
GO only after the immutable official SDK/service contract and fingerprint
exist, the new profile can be rebuilt and deleted safely, and deterministic
contract/security fixtures pass. Final-reply serving is GO only after retained
shadow quality, isolation, fallback, performance, and release gates pass. Voice
is GO only after final-reply stability and voice latency/cancellation/fencing
qualification. Deletion is allowed only at Phase 7's exact gate.
