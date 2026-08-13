# Meeting Knowledge Q&A V1 implementation plan

Status: revised after three architecture/reliability/simplicity passes, implementation not started
Date: 2026-08-13
Selected V1 scope: Discord Reply Q&A for the current bot-authored final meeting
summary/transcript projection, using the complete authoritative local final
transcript, structured cited claims, restart-safe publication and RU/EN/mixed
language behavior. Infinity Context history, previous-answer replies, live
evidence and voice grounding are follow-on vertical slices with separate gates.

## Review outcome and release boundaries

The plan passed three distinct reviews against current product code, accepted
ADRs and Infinity Context v0.1.0: architecture boundaries, failure/recovery
semantics, and scope/simplicity. The original all-in-one baseline was
directionally sound but combined several independently releasable products and
was not implementation-ready.

The release boundary is now explicit:

1. **Local final Reply V1** ships useful grounded Q&A without Infinity Context.
2. **Historical memory V1.1** adds Infinity transcript projection and same-room
   retrieval after the official TypeScript SDK is immutable and deletion is
   proven.
3. **Text expansion V1.2** adds replies to previous grounded answers and live
   finalized-turn cutoffs.
4. **Voice grounding V1.3** adds abortable retrieval and cite-before-speak
   segments without weakening barge-in, cues or recording.

No later slice may weaken the V1 invariants. The final transcript and meeting
database remain authoritative, Infinity remains derived and rebuildable, and
every published factual claim must cite an admitted canonical turn.

### Sizing after review

| Deliverable | Approximate changed lines | Expected time |
| --- | ---: | ---: |
| Local final Reply V1 | 2,200-3,400 | 6-9 working days |
| SDK release/hardening (upstream) | 250-500 | 2-4 days plus publication lead time |
| Infinity shadow projection and document deletion | 1,600-2,600 | 6-9 days |
| Historical room retrieval | 700-1,200 | 3-5 days |
| Previous-answer plus live Reply | 900-1,500 | 4-7 days |
| Voice grounding | 1,500-2,500 | 6-10 days |
| Entire original selected scope | 7,500-12,000 | 25-40 days |

## Summary

Add a focused `Meeting Knowledge` feature inside the existing Meeting Core
package. Its first user-visible slice answers a Discord Reply to the current
bot-authored final meeting projection from the accepted local transcript. It
does not install or call Infinity Context.

The integration uses the existing official TypeScript SDK
`@infinity-context/sdk` inside an outbound anti-corruption adapter. The SDK is
already implemented in Infinity Context v0.1.0, but is not currently published
to npm. We do not write another HTTP client and do not add a Python SDK sidecar.
SDK publication blocks production activation of historical memory only; it does
not block core/application development against fakes or local final Reply V1.

The delivery order is deliberately incremental:

1. implement and privately qualify local final Reply V1;
2. release and pin the official TypeScript SDK independently;
3. shadow-project authoritative final transcripts;
4. enable same-room historical enrichment with local rehydration;
5. add previous-answer and finalized live evidence;
6. add voice grounding without weakening barge-in;
7. roll out each slice only after its own evidence, isolation and latency gates.

## Goals

- Answer a Discord Reply to the exact current bot-authored final meeting
  projection.
- Load the complete accepted final transcript from authoritative local state.
- Admit only turns whose speaker identity is proven human by the authoritative
  meeting participant/actor mapping; bot and unknown-role turns are excluded.
- Answer in the question language, with an explicit language request taking
  precedence.
- Publish only structured claims whose cited turn IDs belong to the exact
  admitted transcript version.
- Create at most one answer business effect per inbound Discord message across
  duplicate delivery, restart, rate limiting and unknown create outcomes.
- Keep recording, transcription, summary and publication independent from
  Q&A health.
- Keep the first release independent from Infinity Context availability and
  package publication.
- Roll out behind one empty-by-default private-guild allowlist.

## Non-goals for V1

- No Infinity Context dependency, projection or historical retrieval.
- No reply target other than the exact final summary/transcript projection.
- No live-meeting or voice Q&A change.
- No `/ask` fallback, placeholder/edit flow or long-answer attachment.
- No participant-name directory or recording deep-link contract.
- No corrected-transcript N/N-1 projection lifecycle.
- No automatic conversational memory from user questions or bot answers.
- No indexing of live partials, greetings, cues or Botik-generated turns.
- No guild-wide or cross-room search.
- No user-personal memory scopes.
- No direct auto-approved Fact writes from model output.
- No new review UI in the Discord bot. Existing Infinity Context review
  facilities are sufficient initially.
- No generic `MemoryService`, `shared` package or provider types in core code.
- No attempt to make Infinity Context authoritative for transcripts or meeting
  lifecycle.

## Current understanding

### Existing meeting platform

- Craig recording and the accepted final transcript are authoritative.
- Finalized live turns are derived but stable enough for in-call evidence.
- Live/final captions and summary use one stable mutable Discord message.
- Conversation currently admits one active and one queued turn, supports
  cancellation/barge-in, uses cues at 1.3/3.2 seconds and excludes memory/RAG.
- `ConversationBridge` serializes speech observations. A remote lookup in that
  chain would delay interruption and is forbidden.
- Meeting ingress knows Discord guild and voice-channel IDs, but current
  `MeetingSnapshot` and `LiveMeetingSnapshot` do not retain equivalent
  provider-neutral scope identity.
- `PlatformRecordingIngress` currently receives normalized guild/channel
  identity but drops it when calling `Meeting.record`; local Reply V1 must close
  this boundary before any scoped reference can be admitted.
- The Discord Gateway client currently requests only the `Guilds` intent.

### Infinity Context and its TypeScript SDK

- PostgreSQL owns canonical Infinity lifecycle state. Qdrant and Graphiti are
  replaceable derived retrieval projections.
- The API supports spaces, memory scopes, meeting threads, documents, context
  building, citations, suggestions, health and capabilities.
- `packages/infinity_context_ts_sdk` already implements the official
  `@infinity-context/sdk` package with auth, AbortSignal, bounded retries,
  Retry-After, pagination and instrumentation.
- npm currently returns 404 for the package. The v0.1.0 GitHub release contains
  Python artifacts but not a TypeScript package.
- Existing endpoint parity checks prove path coverage, not complete request and
  response schema compatibility. Critical responses therefore still need
  runtime parsing in our adapter.
- Current SDK timeouts are evaluated per attempt and retry backoff is not yet
  proven to obey one caller-owned total deadline. Historical activation requires
  one `AbortSignal` to cancel attempts and sleep with no lingering retry.

## Accepted design decisions

### 1. SDK distribution boundary

| Option | Assessment | Approximate changes |
| --- | --- | ---: |
| **Publish the existing official TS SDK and consume it in our adapter** | 🎯 9/10 🛡️ 9/10 🧠 4/10 | 100-300 upstream, 350-650 adapter |
| Pin an exact Git commit/tarball temporarily | 🎯 8/10 🛡️ 7/10 🧠 2/10 | 20-80, test-only bridge |
| Add a Python SDK sidecar | 🎯 4/10 🛡️ 6/10 🧠 8/10 | 700-1,200 plus deployment |

Decision: publish the existing package in the next immutable Infinity Context
release, with the version assigned by the upstream release process, and pin its
exact version in this repository. A Git dependency is not accepted for
production. This gate applies to historical memory activation, not local final
Reply V1.

The SDK remains an infrastructure detail. SDK request/response/error types must
not cross the Infinity adapter boundary.

Historical composition remains disabled until all SDK activation gates pass:

- `npm view @infinity-context/sdk@X.Y.Z` resolves one immutable official
  release, pinned exactly in the catalog and lockfile;
- provenance and the packed tarball SHA256 are retained;
- a clean Node 24 ESM/CJS/typecheck consumer smoke passes;
- request, response and error fixtures for every used endpoint match OpenAPI,
  not only method/path strings;
- one caller abort and total deadline cover every attempt and retry delay;
- mutation retries require stable idempotency keys;
- scope fields required by our ports are runtime-validated even if SDK DTOs make
  them optional;
- exhaustive document/thread deletion and absence proof pass against a
  disposable Infinity deployment;
- server capabilities/version match the exact adapter contract.

Do not guess `X.Y.Z` before the upstream release assigns it.

### 2. Bounded-context ownership

ADR-0013 is already accepted and cannot be reused. Add ADR-0027 for Meeting
Knowledge. Following ADR-0015, implement the first slice as
`packages/meeting-core/src/features/meeting-knowledge` with a curated
`@discord-meeting/meeting-core/meeting-knowledge` entrypoint. Extract a separate
package only after ownership or release cadence demonstrably diverges.

Meeting Knowledge owns:

- the `MeetingQuestion` aggregate and immutable admission identity;
- evidence admission and citation invariants;
- grounded answer status and rendering-neutral claims;
- no external Discord or Infinity identity.

Meeting Core keeps ownership of conversation admission, queueing, cues,
barge-in and playback. Meeting Intelligence keeps ownership of summaries.
Publishing keeps ownership of Discord projections, final-reference lookup and
external answer effects. Meeting Knowledge stores only provider-neutral answer
settlement state; a Discord message ID remains in the Publishing receipt.

### 3. Scope hierarchy

Local V1 persists `MeetingSourceSnapshot`; the Infinity mappings and historical
scope values below activate only in the historical follow-on. Reuse the
provider-neutral source vocabulary already accepted by ADR-0013:

```text
MeetingSourceSnapshot: { scopeId, roomId }
Infinity space:        mapped from scopeId inside the adapter
Infinity memory scope: room:{roomId}
Infinity thread:       meeting:{meetingId}
```

Do not introduce `tenantId` as a synonym for `scopeId`. The inbound ACL already
normalizes provider identities. No default/global search is ever allowed.

Use two sealed scope values rather than optional fields:

- `MeetingProjectionScope { scopeId, roomId, meetingId }` for writes/deletion;
- `RoomHistoryScope { scopeId, roomId }` for historical search.

Space-only, blank, default, multi-room and global operations are unrepresentable
at the port and rejected again by the adapter.

- A referenced meeting is always read directly from Meeting Core.
- Historical retrieval is restricted to the same room scope.
- A future guild-global scope requires a separate ADR and permission model.
- Legacy meetings with missing context are not indexed or guessed. A backfill
  is allowed only when scope and room can be proven unambiguously.

### 4. Evidence authority and ordering

The V1 source is the exact accepted final transcript referenced by the final
publication receipt, filtered by an authoritative actor-role mapping. A bare
`speakerId` is not enough to infer that a turn is human; missing or unknown role
metadata excludes the turn and is observable. Follow-on source ordering is:

1. authoritative final transcript for a completed meeting;
2. finalized live turns up to the captured cutoff while a meeting is live;
3. evidence-backed summary entries rehydrated to their transcript turns;
4. active, non-stale Infinity candidates rehydrated to local authoritative
   transcripts.

Final and live variants for the same meeting are not mixed. Once a final
transcript is accepted, it replaces live evidence explicitly.

The model returns only `status`, bounded `locale`, and structured `claims[] {
text, evidenceTurnIds[] }`; there is no uncited answer-prose field. Every claim
must cite one or more admitted turn IDs. Unknown, empty, duplicate, stale or
cross-scope IDs reject the entire answer before rendering. Membership validation
proves citation integrity, not semantic entailment; RU/EN/mixed golden and
adversarial evals measure semantic support and abstention. The rollout corpus
must be human-labelled for whether each claim is actually entailed by its cited
turns; citation-ID validity alone is not a quality gate.

Model confidence numbers are not used as proof. If support is insufficient, the
answer status is `insufficient_evidence` and the user receives an honest
not-found response.

Long transcripts use a bounded local evidence-selection protocol, not silent
truncation:

1. deterministically partition every accepted turn into ordered, overlapping
   windows with stable local IDs;
2. run bounded candidate selection over every window batch, returning turn IDs
   only;
3. validate IDs locally, add a small deterministic neighbour context and repack
   to the final generation budget;
4. generate structured claims and validate their citations again.

Selection output is never evidence. Only reloaded canonical turns enter final
generation. If complete coverage cannot finish within the configured job
budget, the question remains retryable; it does not answer from a prefix and
does not pretend that missing evidence was absent. Selection checkpoints store
only policy version, next window index and validated candidate turn IDs, so a
restart resumes bounded work without retaining model prose or rescanning a
two-hour call from zero.

### 5. Historical post-call ingestion policy (follow-on)

- Never write live partials or finalized live turns to Infinity in the first
  historical-memory slice.
- Render only human turns from an accepted final transcript version.
- Exclude Botik answers, greetings and cues from long-term retrieval to avoid a
  self-reinforcing memory loop.
- Split a transcript deterministically at turn boundaries into bounded segment
  documents. A segment must stay below both configured character and turn
  limits.
- Store a local immutable segment manifest mapping the rendered segment and
  hash back to exact meeting/transcript/turn IDs and time ranges.
- Infinity document/chunk results are candidate locators only. The answer bundle
  contains rehydrated canonical turns, never unverified chunk prose.
- Do not index summary prose or topic prose.
- Do not write Suggestions or direct Facts. The current Infinity suggestion API
  is room-scoped and exposes no deletion operation that can prove erasure.
- Do not persist user questions or generated answers into memory.

### 6. Failure independence

Do not add Infinity work to the existing critical post-call queue. Each
authoritative producer writes its versioned integration fact in the same
PostgreSQL transaction that accepts the corresponding state. Meeting Knowledge
owns an idempotent consumer inbox, projection jobs, receipts and dead letters,
not a second producer outbox.

Initial event types:

- `FinalTranscriptAcceptedV1`;
- `MeetingKnowledgeDeletionRequestedV1`.

Events carry IDs and versions, not transcript bodies. The worker reloads current
authoritative state before every mutation. Infinity failure can delay knowledge
projection but cannot fail or roll back recording, transcript, summary or
Discord publication.

### 7. Discord Reply semantics

V1 resolves only the exact current bot-authored final projection through the
existing durable final publication receipt. Add a narrow indexed reverse lookup
only if the query plan requires it; do not create a universal polymorphic
artifact-binding registry.

The inbound adapter ignores bots, webhooks and self messages, verifies the
referenced author/application, resolves the binding, checks configured results
container and permissions, then passes provider-neutral input to Meeting
Knowledge.

`questionId` is derived from the inbound message ID. One `meeting_questions`
aggregate row owns admission, recoverable work and answer settlement; a bounded
poller may claim durable states without adding a second delivery queue.
Publishing uses one narrow answer-effect ledger, a deterministic nonce with
`enforceNonce`, and records the one external answer ID. Duplicate
Gateway deliveries and restarts create at most one answer business effect under
the admitted recovery model. Discord guarantees nonce uniqueness only for the
past few minutes, so an unresolved create is never blindly retried after that
window: Publishing first performs bounded history reconciliation; if absence
cannot be proven, it records `publication_unknown`, alerts, and requires an
operator decision. Availability is sacrificed rather than risking a duplicate.

The question text and evidence cutoff are immutable after admission. Message
edits/deletes do not silently mutate an in-flight question in V1.

### 8. Discord intents and fallback

Natural Reply Q&A requires:

- `GuildMessages` Gateway intent;
- privileged `MessageContent` intent enabled in the Discord Developer Portal;
- `ViewChannel`, `ReadMessageHistory`, `SendMessages`, `EmbedLinks`;
- `SendMessagesInThreads` only when configured publication actually uses a
  thread.

Guild setup must validate these capabilities. V1 keeps answers bounded to one
message. `/ask` and attachments are added only if measured product constraints
require them.

### 9. Voice integration point (follow-on)

When the voice slice begins, extract the already-proven evidence-bundle policy
behind a consumer-owned port reusable by text and voice. Do not introduce a
speculative `BuildMeetingQuestionContext` abstraction during local Reply V1.
The voice call must occur inside the detached active-turn executor after
conversation admission, never in `ConversationBridge`'s serialized speech
chain.

- Retrieval receives the active turn `AbortSignal`.
- Barge-in, meeting end and supersession cancel retrieval immediately.
- Cues retain their existing timing and cancellation semantics.
- Live Infinity lookup has one total deadline, initially 500-800 ms, and no
  mutation/retry loop on the critical path.
- Local current-meeting evidence remains available when Infinity times out.
- The versioned conversation runtime contract gains a structured
  `evidenceContext`; memory is never concatenated into `systemPrompt`.
- The versioned runtime emits atomic `GroundedSpeechSegment { text,
  evidenceIds }` events. Pipecat validates each segment before admitting it to
  TTS. If cite-before-speak streaming is unavailable, buffer and validate the
  complete grounded answer before TTS; terminal attestation is never the first
  grounding check.
- Botik audio remains excluded from live STT and enters the authoritative track
  only after Craig sends it successfully.

Voice answers are concise, targeted to roughly 45 seconds. A text companion
with the complete answer and citations is published under the meeting
projection so the conversation can continue through Reply.

### 10. Language behavior

- Default to the language of the current question.
- An explicit request for another answer language takes precedence.
- Mixed Russian/English keeps technical terms unchanged.
- The grounded answer contract returns locale plus claims; the renderer chooses
  Discord text or voice presentation.
- Unsupported locale falls back to text if the configured TTS profile cannot
  pronounce it safely.

## Proposed architecture

```text
Discord Reply inbound adapter
        -> final publication reference ACL
        -> AnswerFinalMeetingQuestion
             -> FinalMeetingReferenceReader
             -> MeetingQuestionStore
             -> GroundedAnswerGenerator
             -> local citation validation
             -> MeetingAnswerPublisher

Historical follow-on only:
        -> HistoricalEvidenceSearch (Infinity adapter)
        -> CandidateEvidenceRehydrator (authoritative local turns)
        -> the same local citation validation
```

### Planned package boundaries

```text
packages/meeting-core/src/features/meeting-knowledge
  domain <- application <- consumer-owned ports

packages/discord-adapter and packages/postgres-adapter
  -> curated meeting-knowledge application entrypoint

apps/meeting-platform/composition
  -> selects all concrete implementations

packages/infinity-context-adapter (historical follow-on only)
  -> curated meeting-knowledge application entrypoint
  -> @infinity-context/sdk
  -> adapter-owned runtime codecs
```

Every production/test source path must be classified fail-closed in
`architecture/foundation/source-dependencies.yaml`. No package is created before
its executable vertical slice.

### Consumer-owned ports

V1 owns four use-case-shaped interfaces:

- `FinalMeetingReferenceReader` resolves one exact final publication reference
  to a provider-neutral meeting/transcript snapshot;
- `MeetingQuestionStore` admits and settles one aggregate state machine;
- `GroundedAnswerGenerator`
  returns `answered`, `insufficient_evidence` or `not_a_question` plus locale
  and cited claims; application policy owns provider failures;
- `MeetingAnswerPublisher` creates or recovers one idempotent external effect.

`MeetingQuestionStore.settleWithPublicationIntent` is the one use-case-shaped
atomic boundary between Meeting Knowledge settlement and Publishing's
provider-neutral desired effect. Its PostgreSQL adapter writes both owned rows
in one transaction; no Discord field crosses the port and neither context
imports the other's aggregate.

Historical, live and voice ports are added only with their executable slices.
Do not add a generic repository, writer, memory service or unit of work.

The PostgreSQL anti-corruption mapping joins the pinned transcript to the
authoritative meeting participant/actor identity before returning knowledge
evidence. Domain/application receive `human` evidence only; Discord user/bot
types and role heuristics never enter Meeting Knowledge.

### MeetingQuestion state machine

The aggregate has explicit transitions rather than boolean flags:

```text
admitted -> selecting_evidence -> generating -> ready_to_publish
generating -> ready_to_publish(answered | insufficient_evidence)
           -> ignored_not_a_question
ready_to_publish -> publishing -> published | publication_unknown
retryable technical failure -> the last durable non-terminal state
```

Optimistic revision and attempt identity reject stale completions. Temporary
question text and grounded claims may be retained only while required to resume
the workflow; `published`, `ignored_not_a_question` and
resolved publication failures clear them according to retention policy.
`publication_unknown` clears Meeting Knowledge copies but Publishing retains the
minimum encrypted bounded desired payload, payload hash and marker needed for
reconciliation until the outcome is resolved or the retention owner makes an
explicit fail-closed purge decision. The aggregate stores an opaque
provider-neutral publication receipt reference, while Publishing owns nonce,
Discord IDs and reconciliation details.

### Adapter validation

The historical Infinity adapter must:

- call the official SDK only;
- use an absolute abortable deadline. Until the SDK supplies abortable backoff,
  critical reads use `maxAttempts: 1` plus an outer `AbortSignal`;
- map SDK failures into bounded port failures;
- parse critical context, citation and write receipts at runtime;
- require exact scope inputs and reject empty/default scope;
- discard `is_instruction=true`, stale, superseded or unexpected item types;
- remove control/bidi characters and cap item count/length;
- never execute retrieved URLs or treat evidence as system/tool messages;
- resolve every meeting source through the local segment manifest and Meeting
  DB before admission;
- repack admitted evidence to a local token budget instead of trusting provider
  rendered text.

## Data and persistence design

### Meeting context evolution

Local Reply V1 adds the existing provider-neutral source identity to every new
final meeting snapshot:

```text
MeetingSourceSnapshot {
  scopeId
  roomId
}
```

Creation requires context. Restore accepts legacy `null`; knowledge projection
and Q&A for such a meeting are skipped with an observable reason. Existing
recordings and summaries remain valid. `scopeId` and `roomId` are supplied from
the normalized recording ingress; they are never inferred from a publication
channel. `LiveMeetingSnapshot` remains unchanged until the live slice.

### Durable records

V1 adds one aggregate-oriented `meeting_questions` table containing immutable
question/meeting/transcript identity, question hash, temporary question text,
temporary grounded claims, state, attempt identity, optimistic revision and an
opaque publication receipt reference. Publishing owns the provider-specific
answer effect in one narrow `meeting_answer_publication_effects` table,
including desired state, payload hash, deterministic nonce, reconciliation
state and nullable Discord message ID. The question result and desired effect
are committed atomically in PostgreSQL. It may add a narrow index for reverse
lookup of the existing final publication receipt. It does not add a universal
binding/effect table, a second publication outbox or a new BullMQ workflow.

The effect row is the recoverable Publishing work list. A crash before the
question/effect transaction repeats generation only; a crash after it finds the
same desired effect. External Discord create never runs inside that transaction.

Historical projection later adds producer-owned fact outboxes in the same
transactions as authoritative acceptance, plus a Meeting Knowledge consumer
inbox, projection jobs/dead letters, transcript segment manifests, Infinity
document receipts, deletion tombstones and purge receipts. There are no
Suggestion receipts or speculative current-version pointer in this release.

Do not store Infinity SDK DTOs. Store stable IDs, versions, hashes, scope and
provider-neutral receipts.

### Version switch

The current Meeting aggregate accepts one final transcript and rejects a
different completion. V1 projects only that accepted transcript identity and
supports idempotent replay. An N/N-1 replacement state machine is deferred until
a separate authoritative transcript-correction ADR and use case exist.

### Deletion and retention

Local Reply rollout requires a bounded retention policy: terminal questions
clear raw question, candidate and claim text; `publication_unknown` retains only
the minimum encrypted/bounded desired payload needed for reconciliation and
raises an operational alert. A local tombstone immediately rejects new Q&A and
cancels unstarted work. V1 does not claim to delete the authoritative recording,
transcript, summary or final publication.

Historical-memory write rollout is additionally blocked until provider deletion
is proven:

1. persist a local tombstone to reject new historical reads immediately;
2. enqueue deletion for all known Infinity transcript documents;
3. reconcile unknown outcomes using stored receipts/fingerprints;
4. verify document absence;
5. verify the exact `(space, room scope, meeting thread)` no longer admits the
   meeting and record one purge receipt;
6. retain no question/answer text beyond the configured retention.

Suggestions remain disabled until Infinity exposes a thread-scoped purge plus
runtime-parseable absence proof. Reject/expire is not deletion.

## Detailed implementation phases

# Phase 0 - Architecture contract for local final Reply

## Summary

Fix ownership and the dependency graph before adding the executable V1 slice.

## Detailed implementation steps

1. Add ADR-0027, preserving ADR-0013 and amending ADR-0010 only for later
   admitted grounded meeting-question turns.
2. Add the `meeting-knowledge` feature with one curated entrypoint in the
   existing Meeting Core package; no speculative package or empty DDD folders.
3. Declare `domain <- application <- adapters <- composition` and every new
   production/test path fail-closed in Foundation, package exports and
   consumer-subpath policy before source is added.
4. Keep application commands/results, producer integration facts, Publishing's
   reference contract and conversation transport DTOs as distinct surfaces.
5. Define the `MeetingQuestion` aggregate, evidence/claim value objects and the
   four V1 ports with domain/application tests before real adapters.
6. Persist `MeetingSourceSnapshot { scopeId, roomId }` on every new final
   meeting; allow legacy `null` only on restore and deny it for Q&A.

## Tests

- Domain citation/admission/conflicting-replay tests without mocks.
- Architecture graph, deterministic-code and curated-export checks.
- Contract tests proving no Discord/SDK/database type crosses inward.

## Rollback / kill switch

No runtime behavior changes. The guild allowlist remains empty.

## Acceptance criteria

- ADR-0027 has no numbering collision and preserves accepted ADRs.
- Package creation is tied to an executable slice.
- Domain/application import no Discord, Infinity, Pipecat, database, environment,
  clock, randomness or timer.

# Phase 1 - Local grounded final Reply V1

## Summary

Deliver the first useful behavior from authoritative local state only.

## Detailed implementation steps

1. Add an exact Subscription Runtime purpose returning status, locale and cited
   claims only, with RU/EN/mixed/injection tests. Its adapter implements bounded
   candidate selection across every deterministic transcript window before
   final generation when the transcript does not fit one request.
2. Add one `meeting_questions` aggregate row keyed by inbound message identity.
   Admission verifies immutable fields on conflict; terminal settlement clears
   raw question/candidate/claim text and retains bounded
   hash/identities/status/publication-receipt reference.
3. Resolve only the existing final publication receipt and complete accepted
   transcript. Cover all deterministic windows; never silently truncate or
   answer from only the first prompt-sized prefix.
4. Add Discord Reply ingress with `GuildMessages`/`MessageContent`, strict bot
   author, configured channel, permission and empty-by-default guild allowlist
   checks.
5. Generate first, then create one bounded reply using a deterministic nonce,
   `enforceNonce` and disabled allowed mentions. On an unknown create outcome,
   Publishing performs bounded nonce/history reconciliation before any retry.
   A retry is allowed only inside Discord's nonce-deduplication window or after
   absence is proven; otherwise the effect becomes `publication_unknown`. No
   placeholder/edit/attachment.
6. Add low-cardinality metrics without raw text or user/meeting IDs.
7. Persist the generated result and its one narrow Publishing effect atomically;
   use the question/effect rows themselves as recoverable work lists instead of
   introducing generic outboxes or another queue.
8. Add selection checkpoints and local tombstone/retention cleanup so long-call
   retries resume safely and terminal content is not retained indefinitely.
9. Add the participant/actor anti-corruption join; exclude bot or unknown-role
   turns before windowing and fail closed if identity evidence is inconsistent.

## Edge cases

- Missing Message Content or permissions.
- Reply references a deleted, foreign, non-bot or non-final message.
- User replies with thanks rather than a question.
- A one-hour or two-hour transcript exceeds one model request and candidate
  selection fails, times out or returns invalid IDs midway.
- Discord returns 403, 429 or an unknown create outcome.
- Answer is multilingual, too long or contains mention-like text.
- A transcript contains Botik output or a speaker missing authoritative role
  metadata.
- Duplicate delivery, concurrent admission or restart occurs at every boundary.

## Tests

- Domain citation, abstention and conflicting-replay tests.
- PostgreSQL uniqueness, concurrent replay and crash-boundary integration tests.
- Crash-before/after question-result/effect commit and publisher-claim fencing
  tests.
- Inbound author/reference/guild/channel/permission filtering tests.
- Discord nonce recovery and unknown-outcome reconciliation tests.
- Nonce-window expiry tests proving no blind retry and no duplicate effect.
- RU/EN/mixed, negation/correction, injection and oversized-meeting fixtures.
- Synthetic two-hour transcript fixtures with relevant facts near the start,
  middle and end, plus a bounded-call-count assertion.
- Botik/self-loop and unknown-role fixtures proving those turns cannot support
  an answer.

## Rollback / kill switch

Empty `MEETING_QA_GUILD_ALLOWLIST` disables the slice without affecting existing
meeting behavior.

## Acceptance criteria

- One inbound message resolves to at most one final meeting.
- Reference resolution and evidence reads match `scopeId`, `roomId`, meeting,
  transcript ID and version together; legacy unscoped meetings fail closed.
- One inbound message creates at most one answer business effect.
- An unprovable Discord create outcome becomes visible `publication_unknown`
  rather than a late duplicate retry.
- Every rendered factual sentence is a cited claim from the exact transcript.
- Every cited turn has authoritative human-role evidence; bot/unknown turns are
  never admitted.
- Missing support produces an honest abstention in Russian and English.
- A qualified synthetic two-hour transcript is fully covered without silent
  truncation and answers facts placed near the start, middle and end.
- Recording, transcription, summary and final publication remain unchanged.

# Phase 2 - SDK release and shadow historical projection

## Summary

Release the official SDK, then project authoritative final transcripts into
Infinity without serving user answers. This phase cannot block Phase 1.

## Detailed implementation steps

1. Upstream: verify Node 20/24, package metadata, `npm pack` consumer install,
   trusted publishing/provenance, `.tgz`/SHA256 and used-endpoint schema fixtures.
2. Add an absolute abortable SDK deadline; until released, product reads use one
   attempt plus an outer abort signal.
3. Pin the immutable npm version and Infinity image digest; capability mismatch
   disables historical memory only.
4. Consume the V1 `MeetingSourceSnapshot { scopeId, roomId }`; legacy `null` is
   skipped, never guessed.
5. Have the authoritative transcript producer emit its versioned fact atomically
   with acceptance; consume through an idempotent inbox/non-critical worker.
6. Implement runtime-coded Infinity document projection, deterministic
   human-only segmentation, manifests and provider-neutral receipts.
7. Implement tombstone-first document deletion and unknown-outcome
   reconciliation. Do not write Suggestions or Facts.
8. Run shadow retrieval and rehydrate every candidate to canonical local turns.

## Edge cases

- Unicode emoji/combining characters in rendered segments.
- Transcript exceeds one document or API limits.
- Network failure after a committed mutation.
- Provider mutation commits but the response is lost.
- Old derived candidates remain after deletion.
- Botik turns dominate a meeting transcript.

## Tests

- Renderer/manifest determinism and Unicode property tests.
- Disposable Infinity tests for auth, scopes, 409/retry and stale candidates.
- Injection evidence, malformed response and unavailable service tests.
- Deletion and re-ingestion recovery tests.
- Exact SDK payload tests for `MeetingProjectionScope` and `RoomHistoryScope`.

## Rollback / kill switch

Disable `INFINITY_CONTEXT_ENABLED`. Derived documents can be purged and rebuilt
without changing authoritative meetings.

## Acceptance criteria

- No bot/live-partial content is indexed.
- Projection replay creates no duplicate document business effect.
- Every admitted historical candidate resolves to current local turns.
- Infinity outage changes only projection lag/health.
- Deletion produces a verified purge receipt.

# Phase 3 - Same-room historical enrichment

## Summary

Enrich the already working final Reply with optional same-room history.

## Detailed implementation steps

1. Search exactly one `RoomHistoryScope`; never a space-only/default scope.
2. Treat provider output only as candidate locators and diagnostics.
3. Rehydrate candidates in batches from current authoritative meeting state,
   reject tombstoned/stale/cross-scope references, then repack locally.
4. Keep referenced-meeting evidence first and useful when Infinity times out.
5. Add Recall/MRR, abstention and injection corpora before allowlist rollout.

## Edge cases

- The same text occurs in different rooms or transcript versions.
- A candidate points to a deleted, legacy-unscoped or superseded meeting.
- Infinity returns instruction-like, malformed or over-budget content.
- Retrieval times out after partial candidates were received.

## Tests

- Cross-scope denial at port, adapter payload and rehydration layers.
- Timeout/unavailable/malformed-provider fallback to referenced meeting evidence.
- Stale/deleted candidate and prompt-injection rejection.
- Offline Recall@8, MRR@8 and unsupported-question abstention evaluation.

## Rollback / kill switch

Disable `INFINITY_CONTEXT_ENABLED`; local final Reply continues unchanged.

## Acceptance criteria

- Every admitted historical candidate resolves to current canonical turns.
- Cross-guild/room leakage is zero.
- Infinity outage does not remove referenced-meeting Q&A.

# Phase 4 - Live text evidence

## Summary

Allow replies to the live projection while preserving an exact finalized-turn
cutoff.

## Detailed implementation steps

1. Capture live meeting revision and last finalized turn at admission.
2. Read a repeatable snapshot/timeline through the existing atomic reader.
3. Reject partials and all turns after the cutoff.
4. Prefer final evidence if finalization completed before generation begins;
   otherwise remain explicitly preliminary for that request.
5. Include optional same-room history candidates within bounded budgets.
6. Mark live answers as preliminary and link the current meeting projection.

## Tests

- Partial/final race and cutoff enforcement.
- Live-to-final replacement while a question is running.
- Late turn, duplicate turn and stale projection rejection.
- Infinity timeout fallback to local finalized turns.

## Rollback / kill switch

Keep final Reply enabled and disable live-target admission independently.

## Acceptance criteria

- No answer cites a partial or a turn after its cutoff.
- Final replacement does not duplicate/rebind the question.
- Live fallback remains useful without Infinity.

# Phase 5 - Voice context Q&A

## Summary

Enrich the existing addressed Botik turn after admission while keeping its
current queue, cues, cancellation and playback guarantees.

## Detailed implementation steps

1. Add `ConversationContextPort` to the active-turn executor.
2. Propagate AbortSignal from barge-in/meeting-end/supersession.
3. Set an initial 500-800 ms total retrieval deadline and one live attempt.
4. Extend the versioned conversation contract with structured evidence items,
   source mode and atomic `GroundedSpeechSegment { text, evidenceIds }` events.
5. Update Pipecat and Subscription Runtime mapping to treat evidence as
   untrusted quoted data.
6. Validate each segment's evidence IDs before that segment reaches TTS. If the
   runtime cannot provide cite-before-speak streaming, buffer and validate the
   whole grounded answer before TTS.
7. Preserve current cues, four-second real-answer guard and one-active/one-queued
   admission.
8. Collect answer text/citations and publish a compact Discord companion under
   the meeting projection.
9. Keep ordinary non-meeting Botik questions on the existing general answer
   policy; meeting-memory claims require grounded evidence.

## Edge cases

- Retrieval is still running when speech interruption arrives.
- Two speakers overlap and address Botik.
- Infinity is slow but the current meeting has enough local evidence.
- The model returns invalid evidence IDs.
- TTS locale is unsupported or the answer exceeds voice duration.
- Bot output appears in the authoritative final transcript.

## Tests

- Providerless Pipecat/gRPC/PCM E2E with memory success, timeout and abort.
- Cue timing and four-second answer guard regression tests.
- Barge-in during retrieval and during TTS.
- RU/EN grounded voice fixtures and unsupported locale fallback.
- Self-loop prevention and Botik-track send evidence.
- Opt-in private Discord E2E with official test bots and synthetic audio only.

## Rollback / kill switch

Disable `VOICE_CONTEXT_QA_ENABLED`. Existing stateless conversation behavior
continues unchanged.

## Acceptance criteria

- Retrieval never delays speech observation/cancellation.
- Existing conversation queue and barge-in invariants remain green.
- Invalid grounding cannot reach TTS.
- Memory outage does not disable ordinary conversation or meeting recording.

# Phase 6 - Rollout, backfill and hardening

## Summary

Promote from private test guild to production only after quantitative gates.

## Detailed implementation steps

1. Enable local final text Reply in the private test guild without Infinity.
2. Exercise duplicate delivery, restart and unknown Discord outcome recovery.
3. Run historical shadow ingestion/retrieval for new meetings only after the SDK
   and deletion gates pass.
4. Enable same-room history, then live Reply after cutoff/fallback evidence is
   retained.
5. Enable voice context for the test guild only after cite-before-speak proof.
6. Expand each slice through its own allowlist and watch its
   error/latency/abstention metrics.
7. Backfill only meetings with provable scope/room context, in bounded batches.
8. Exercise outage, restart, stale-index and deletion drills before widening
   the corresponding slice.

## Rollback / kill switch

A master Q&A kill switch stops new questions and aborts active Q&A without
restarting the platform. Separate final Reply, historical enrichment, live Reply
and voice controls allow rollback of one slice without disabling earlier proven
behavior. Recording, transcription, summary and publication remain active.

## Acceptance criteria by release boundary

Local final Reply V1:

- Cross-scope leaks: 0.
- Invalid published citations: 0.
- Duplicate answer business effects after replay/restart: 0.
- Unsupported-question abstention recall at least 0.95 on the committed RU/EN
  corpus.
- Recording/transcription/summary/final-publication regressions: 0.

Historical memory:

- Infinity outage impact on authoritative meeting flows and local Reply: 0.
- Offline Recall@8 at least 0.90 and MRR@8 at least 0.75 on the synthetic
  meeting evidence corpus.
- Projection lag p95 target at most 15 seconds after final transcript acceptance.
- Document deletion absence and unknown-outcome reconciliation are proven.

Live and voice:

- Healthy live retrieval p95 at most 500 ms and p99 at most 800 ms in the
  qualified hosting profile.
- Warm first real audio p95 target at most 4.5 seconds for simple grounded
  questions and at most 7 seconds for complex ones.
- No invalid grounded speech segment reaches TTS.
- Injection corpus never changes tool/system behavior.

## Cross-cutting edge cases

- Same text exists in two guilds, rooms or transcript versions.
- Participant display/real name changes after the meeting. Identity remains the
  immutable participant ID; rendering resolves the current approved name.
- A future corrected meeting version supersedes indexed documents while requests
  run; this requires its own authoritative correction lifecycle before support.
- A user asks about a previous bot answer. It is conversational context only,
  never evidence; original citations are revalidated.
- A user asks for information that was never said, was negated, quoted or later
  corrected.
- A transcript contains prompt injection, bidi controls, mention payloads,
  credentials or URLs.
- Infinity returns a stale Qdrant/Graphiti candidate after canonical deletion.
- An SDK mutation times out after the server may have committed it.
- Discord creates a message but the client loses the response.
- Feature flags change while retrieval or generation is active.

## Observability

Record low-cardinality metrics for:

- question admission, rejection, dedupe and queue state;
- reference resolution and scope denial;
- retrieval latency/outcome/provider diagnostics;
- candidates returned, discarded and rehydrated;
- citation coverage and validation rejection;
- answer status, generation latency and language group;
- Discord 429/unknown outcome and effect reconciliation;
- voice cue, first-audio, cancellation and fallback latency;
- projection outbox depth, lag, retries, dead letters and purge receipts.

Never label metrics or log events with raw question/evidence text, user IDs,
meeting IDs, tokens or high-cardinality provider request IDs. Correlation IDs
remain sanitized operational fields.

## Verification commands

During implementation in this repository:

```text
pnpm run check:changed
pnpm run check:fast
pnpm run check
```

Use `tsc7 --noEmit` as a fast local preflight only when the project config is
compatible. The project-pinned full check remains authoritative.

For Infinity Context SDK release work:

```text
npm ci --prefix packages/infinity_context_ts_sdk
npm run verify --prefix packages/infinity_context_ts_sdk
npm pack --prefix packages/infinity_context_ts_sdk
make infinity-context-test-quality
```

New integration/E2E scripts must run only against disposable Infinity
databases, synthetic meeting fixtures and the private test Discord guild. No
real user project or public guild is an allowed test target.

## Final acceptance checklist

- ADR-0027, dependency graph and documentation match the implemented slice.
- Domain/application code imports no Infinity, Discord, Pipecat, database or
  provider SDK type.
- Every new source file is classified fail-closed.
- Final transcript remains authoritative.
- Every V1 factual answer claim has locally valid evidence from the exact final
  transcript version.
- Unsupported questions abstain in RU and EN.
- Final Reply is restart-safe and idempotent.
- Private synthetic final-Reply E2E evidence is retained before rollout.

Historical activation additionally requires:

- SDK is immutable, provenance-verified and exactly pinned.
- Scope/room/thread is explicit on every memory operation.
- Bot-generated content cannot become memory evidence.
- Infinity remains rebuildable and every candidate is rehydrated locally.
- Document deletion, outage and stale-index recovery are proven.

Live/voice activation additionally requires cutoff, abort, cite-before-speak,
barge-in and private synthetic voice E2E evidence.

## Quality forecast

- Clean Architecture / DDD fit: 9/10.
- Replaceability: 9/10.
- Post-call text Q&A after gates: 9/10.
- Live voice Q&A: 8/10.
- Local final Reply readiness after implementation: 9/10.
- Historical readiness before SDK publication/deletion proof: 5/10.
- Expected verified full-scope reliability: 8.5-9/10.

The remaining gap to 10/10 is primarily semantic ambiguity in speech, STT
errors, memory poisoning risk and the operational maturity of Infinity Context
v0.x, not the adapter architecture.
