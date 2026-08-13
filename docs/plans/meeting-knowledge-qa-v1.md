# Meeting Knowledge Q&A V1 - Local Final Reply

Status: implementation-ready after independent architecture, reliability, and
simplicity reviews

Date: 2026-08-13

## Summary

Deliver one complete vertical slice: when a user replies in Discord to Botik's
current final transcript/summary message, answer the question from the complete
accepted local transcript, in the question language, with locally validated
citations.

V1 does not depend on Infinity Context. Historical memory, replies to earlier
answers, live evidence, and voice grounding are later slices with separate ADRs,
plans, flags, and qualification gates. This keeps the first release useful and
small without compromising the future memory architecture.

The accepted local transcript and Meeting database are authoritative. Retrieved
or model-produced text is never authority. Every factual claim must cite a
question-local evidence reference which is rehydrated to one exact human turn in
the admitted transcript version.

### Expected size and quality

| Deliverable | Approximate changed lines | Expected time |
| --- | ---: | ---: |
| Local Final Reply V1 | 1,900-2,900 | 5-8 working days |
| Private-guild qualification | 250-450 tests/evidence | 1-2 days |

Forecast after the gates in this plan:

- Clean Architecture / DDD fit: 9.2/10.
- SOLID / DRY fit: 9/10.
- Recovery correctness: 9/10.
- Semantic answer quality: 8.5-9/10, measured rather than assumed.
- Future Infinity replaceability: 9/10.

The estimate includes the currently missing source/participant identity
boundary, two Subscription Runtime schemas, durable claims, Discord
unknown-outcome reconciliation, and the two-hour fixture. It excludes historical
memory and voice.

## Goals

- Admit only a Discord Reply to the exact current bot-authored final projection.
- Bind admission immutably to scope, room, meeting, transcript ID/version,
  final publication receipt, question hash, and inbound message identity.
- Load all eligible human turns from the complete accepted final transcript.
- Never infer a human from the existence of an audio track; Botik has an
  authoritative track too.
- Answer in Russian, English, or mixed language according to the current
  question; an explicit requested answer language wins.
- Publish only bounded structured claims with valid local evidence references.
- Create at most one Discord answer business effect per inbound message across
  duplicate delivery, concurrent workers, restart, rate limiting, and ambiguous
  remote outcomes.
- Keep recording, transcription, summary, and final publication independent
  from Q&A health.
- Ship behind one empty-by-default private-guild allowlist.

## Non-goals

- No Infinity Context dependency, indexing, historical retrieval, or backfill.
- No reply target other than the current final transcript/summary projection.
- No live-meeting or voice Q&A.
- No conversational memory from user questions or Botik answers.
- No `/ask`, placeholder/edit flow, attachment, or multi-message answer.
- No guild-wide, cross-room, personal, Suggestions, or Facts search.
- No corrected-transcript N/N-1 lifecycle.
- No generic memory service, repository, unit of work, event bus, outbox, or
  `shared` package.
- No V1 meeting-deletion command or speculative tombstone model.

## Current code facts

- `MeetingSnapshot` currently lacks provider-neutral source identity and a
  durable participant roster.
- recording ingress receives `scopeId` and `roomId` but drops them at
  `Meeting.record`.
- Craig contract v1 carries participant IDs but not an explicit actor-kind
  vocabulary. ADR-0011 establishes that Botik is excluded from recovered human
  participants while its track remains in final transcription.
- final publication receipt stores an opaque external publication ID and
  idempotency key; a narrow reverse lookup does not yet exist.
- Discord composition currently requests only the `Guilds` intent.
- Subscription Runtime binds exact purposes to exact structured schemas; one
  answer schema cannot also represent evidence selection.
- Discord officially guarantees `enforce_nonce` uniqueness only for the past
  few minutes. History absence is not proof that a message was never created.
- the official Infinity TypeScript SDK exists in the Infinity Context source
  repository, but `@infinity-context/sdk` is not published to npm and the
  current v0.1.0 release contains only Python artifacts.

## Architecture decisions

### Bounded-context placement

Add one real feature module:

```text
packages/meeting-core/src/features/meeting-knowledge
  domain values and invariants
  application orchestration and consumer-owned ports
```

Expose only `@discord-meeting/meeting-core/meeting-knowledge`. Do not add a new
workspace package until ownership or release cadence actually diverges.

Meeting Knowledge owns:

- immutable admission identity;
- human-evidence and citation invariants;
- grounded-answer status and claim invariants;
- the durable question workflow vocabulary.

Publishing remains the existing feature owner of Discord projection mechanics
and external-effect reconciliation. Meeting Knowledge does not import its
aggregate or tables. Cross-feature collaboration uses curated contracts and
consumer-owned ports.

### Domain versus workflow state

Do not model every technical lease transition as a rich DDD aggregate. Tactical
DDD is used only for business invariants:

- `AdmittedMeetingEvidence` proves exact scope/transcript/human-turn membership;
- `GroundedAnswer` proves status/claim/citation consistency;
- `QuestionId`, `EvidenceId`, `QuestionHash`, and immutable admission identity
  are value objects.

Lease, retry, and backoff fields belong to an application-owned durable
`QuestionJob`. This avoids a fake aggregate while keeping domain logic
deterministic and infrastructure-free.

### Dependency direction

```text
meeting-knowledge domain
        <- application and consumer-owned ports
        <- Discord / PostgreSQL / Subscription Runtime adapters
        <- Meeting Platform composition
```

No Discord, PostgreSQL, Subscription Runtime, Infinity, Pipecat, environment,
clock, randomness, or timer type crosses into domain/application code. Clock,
ID, and scheduling decisions are supplied as values by adapters/application
composition.

Update ADR-0027, the architecture overview's feature inventory, package exports,
Foundation's fail-closed source graph, and the Meeting Core consumer-subpath
policy in the same vertical-slice change. Do not amend accepted ADR-0010; voice
grounding gets its own ADR when implemented.

## Provider-neutral source and actor admission

### New Meeting Lifecycle data

Persist at initial recording admission:

```text
MeetingSourceSnapshot {
  scopeId
  roomId
}

MeetingActorSnapshot {
  actorId
  kind: human | automation | unknown
}
```

`MeetingSnapshot` gains:

```text
source: MeetingSourceSnapshot | null
actors: MeetingActorSnapshot[] | null
```

Rules:

- new meetings require non-null source and actor roster;
- restore maps absent legacy fields to `null` and emits explicit `null` on the
  next snapshot;
- legacy/null meetings remain valid for existing workflows but are ineligible
  for Q&A and historical indexing;
- duplicate recording admission compares source and actor roster in addition to
  publication target and recording identity;
- conflicting actor kinds for one actor fail closed;
- transcript turns from `automation`, `unknown`, or absent actors are excluded;
- a transcript with no eligible human evidence produces an honest abstention.

### Craig contract rollout

Add a backward-compatible v2 lifecycle/authoritative-ready contract carrying a
provider-neutral actor roster. The Craig ACL maps Discord users/bots to
`human | automation | unknown`; provider types stay outside Meeting Core.

Contract v1 may be admitted only where its existing `participantIds` semantic is
proven by contract/E2E evidence to mean human participants and to exclude all
automation, not only Botik. Otherwise v1 meetings restore with `actors: null` and
Q&A is denied. Do not infer actor kind from snowflake, profile names, configured
greeting names, or the presence of a speaker track.

The durable recording spool must retain the normalized actor roster through
completion so final Meeting creation cannot lose it.

## Exact Discord Reply admission

### Inbound adapter responsibilities

The Discord adapter:

- listens only with `GuildMessages` and approved `MessageContent` intents;
- ignores self, bots, webhooks, DMs, empty content, edits, and deletes;
- requires an empty-by-default guild allowlist and configured results container;
- verifies message/reference shape, bot application author, guild/container,
  and required permissions;
- converts the Discord message ID into a namespaced opaque `QuestionId` and
  passes an opaque reference, normalized guild/results-container identity,
  question text, and a keyed non-reversible requester subject used only for
  bounded admission.

It does not query Meeting Knowledge tables or resolve the meeting twice.

### One authoritative application query

The adapter's verified author/application facts are immutable command fields;
they are not falsely described as PostgreSQL state. `FinalMeetingEvidenceReader`
resolves the durable portion in one repeatable database snapshot:

```text
{
  guildScope,
  resultsContainer,
  opaqueFinalReference
}
  -> {
    scopeId,
    roomId,
    meetingId,
    transcriptId,
    transcriptVersion,
    transcriptHash,
    finalReceiptRef,
    eligibleHumanTurns
  }
```

Its PostgreSQL ACL composes the narrow Publishing final-reference contract with
Meeting Lifecycle/Transcription state. It must match the exact encoded final
receipt, guild scope, results container, meeting source, room, meeting,
transcript ID and version. The command's already-verified author/application
identity is persisted in hashed/namespaced form as part of immutable admission.
Zero or multiple durable matches fail closed.

Add a narrow unique reverse-lookup index for the current final receipt. Do not
add a polymorphic artifact-binding registry.

Admission inserts or validates one immutable record containing every returned
identity plus `questionHash`. A conflict compares every immutable field. The
same inbound identity with changed text, reference, scope, or transcript never
rebinds.

## Evidence and generation protocol

### Question-local evidence identity

Never expose naked transcript turn IDs to a model. Build deterministic opaque
`EvidenceId` values scoped to the admitted question and map them locally to:

```text
{
  scopeId,
  roomId,
  meetingId,
  transcriptId,
  transcriptVersion,
  turnId
}
```

Only canonical human turns from the immutable admission map are evidence.

### Long transcript coverage

V1 qualifies transcripts up to 5,000 eligible turns and 400,000 normalized
characters; the committed corpus must include at least one realistic two-hour
meeting below those ceilings. Larger inputs settle as `unsupported_size`; they
do not loop or answer from a prefix. Duration is not used as an admission bound
because silence and speaking rate make it an unreliable size proxy.

Application policy:

1. deterministically partition every eligible turn into ordered windows of at
   most 120 turns or 12,000 normalized characters, with an eight-turn overlap;
2. batch at most six windows per selector call;
3. request candidate `EvidenceId` values only;
4. reject unknown/invalid IDs, deduplicate, reload canonical turns, add at most
   two neighbouring turns on each side, and repack to the final budget;
5. generate structured claims once and validate all references again.

The expected call ceiling is `ceil(windowCount / 6) + 1` including final
generation. Selection output is never evidence.

For two-hour calls, persist a compact checkpoint after each successful batch:

```text
transcriptHash
questionHash
selectionPolicyVersion
windowPlanHash
totalWindows
nextWindowIndex
validatedCandidateEvidenceIds
```

Checkpoint CAS uses the active claim generation. A crash resumes without
skipping or silently rescanning completed windows. Invalid output or exhausted
budget settles visibly; it never degrades to partial-prefix answering.

### Runtime ports and schemas

Use five focused interfaces:

- `FinalMeetingEvidenceReader` - exact authoritative admission query;
- `QuestionJobStore` - admission, claims, checkpoints, settlement, cleanup;
- `EvidenceCandidateSelector` - selector-only structured result;
- `GroundedClaimGenerator` - final grounded structured result;
- `MeetingAnswerPublisher` - deterministic external effect and recovery.

The two model ports are justified because their contracts and failure modes are
different. The Subscription Runtime adapter implements two exact purposes:

```text
discord_meeting.knowledge.select_evidence
discord_meeting.knowledge.answer
```

Application owns windowing, canonical reload, checkpointing, budgets, and both
validation passes. The adapter owns prompt mapping, strict runtime codecs,
attestation, and bounded provider-failure mapping.

The answer schema has exact keys only:

```text
status: answered | insufficient_evidence | not_a_question
locale: ru | en | mixed
claims: [{ text, evidenceIds[] }]
```

Invariants:

- `answered` has 1-12 non-empty claims;
- every claim has 1-8 unique admitted evidence IDs;
- non-answer statuses have no claims;
- claim text, total output, IDs, arrays, and control characters are bounded;
- unknown keys/types, bidi controls, mention payloads, invalid locale, duplicate
  IDs, or any unknown/cross-transcript ID reject the whole output;
- renderer emits every accepted claim exactly once with its citations and adds
  only fixed non-factual wrapper text;
- model confidence is never proof.

## Durable workflow and bounded recovery

### Question job state

```text
pending -> selecting -> selected -> generating -> ready_to_publish
generating -> ready_to_publish(answered | insufficient_evidence)
generating -> ignored_not_a_question
any claimed generation state -> pending          (bounded retry)
any nonterminal state -> retry_exhausted | unsupported_size | cancelled
ready_to_publish -> published
```

Technical fields include `claimGeneration`, `leaseUntil`, `attemptCount`,
`nextAttemptAt`, bounded failure code, and timestamps. Claiming uses the database
clock and one atomic `FOR UPDATE SKIP LOCKED`/conditional-update operation.
Every checkpoint and completion CASes state plus claim generation. Provider
deadline is shorter than its lease; stale workers cannot complete after reclaim.

Initial operational bounds:

- at most three attempts per selector or generator stage;
- exponential backoff capped at five minutes;
- maximum nonterminal age 24 hours;
- global worker concurrency 2 initially;
- at most 2 active jobs per guild;
- excess admission is recorded with a low-cardinality reason and produces one
  deterministic, non-LLM bounded response through the same idempotent
  publication-effect path.

These are validated configuration values, not domain constants. Exhaustion is
observable and terminal; there is no infinite retry loop.

### Separate Publishing effect

Publishing owns one narrow `meeting_answer_publication_effects` record:

```text
pending -> creating -> published | publication_unknown
```

The question row does not mirror `creating` or `publication_unknown`. The
publisher deterministically reserves/upserts the same effect before any Discord
create. A crash between `ready_to_publish` and reservation is safe because the
poller repeats with the same effect ID. After a confirmed receipt, Meeting
Knowledge records only an opaque receipt and scrubs temporary content.

This uses two narrow tables and no generic outbox, BullMQ flow, universal effect
ledger, or cross-feature unit of work.

## Discord publication and ambiguous outcomes

Persist before sending:

- deterministic effect ID, nonce, and answer-marker version;
- exact guild/container and original reply target;
- bot application identity;
- payload hash and bounded desired payload;
- `firstSendStartedAt` and conservative `nonceValidUntil`;
- reconciliation state and nullable external message receipt.

Send one bounded reply with `enforceNonce`, disabled allowed mentions, and
`repliedUser: false`.

Recovery rules:

- deterministic local/validation failures before create may retry by policy;
- a 429 or transport rejection proven to occur before acceptance may retry with
  the identical effect;
- after an ambiguous create, retry only the identical payload/nonce while the
  recorded conservative nonce window is definitely open;
- after that window, an exact marker match can prove success;
- no match, incomplete/forbidden history, deleted message, conflict, or multiple
  matches becomes terminal `publication_unknown`;
- Discord history absence never proves non-creation and never authorizes a new
  post-window create.

Marker reconciliation verifies application/author, container, original reply
target, payload hash, marker version, and nonce. Availability is sacrificed
instead of risking a duplicate.

## Retention and privacy

V1 has no meeting tombstone because no meeting-deletion use case exists yet.

Default maximum retention:

| State | Raw question / candidates / claims / payload |
| --- | --- |
| published, ignored, insufficient, rejected | scrub in the terminal transaction |
| retry_exhausted, unsupported_size, cancelled | scrub in the terminal transaction |
| abandoned nonterminal job | scrub after 24 hours |
| publication_unknown | retain bounded payload for at most 7 days, then transition to `abandoned_fail_closed` and scrub |

After scrubbing retain only hashes, low-cardinality status, timestamps, policy
versions, and opaque receipts needed for audit/deduplication. A retryable sweeper
uses fenced claims; crash/restart and sweeper/worker races cannot resurrect raw
content.

## Implementation phases

### Phase 1 - Architecture and identity foundation

Implement together with tests, not as empty scaffolding:

1. ADR-0027 and architecture overview update.
2. `meeting-knowledge` feature, curated export, Foundation boundary, exact
   consumer edges, and test ownership.
3. source plus actor roster in Meeting Lifecycle and recording spool.
4. Craig v2 actor contract and backward-compatible ACL.
5. legacy restore and replay-conflict behavior.

Acceptance:

- no unclassified source/test file or undeclared dependency;
- new meetings retain exact source and actors through restart/finalization;
- Botik/automation/unknown actors cannot support an answer;
- existing recordings, summaries, greetings, farewells, and publication remain
  unchanged.

### Phase 2 - Local grounded application slice

1. domain value objects and invariant/property tests;
2. exact final evidence reader and immutable admission;
3. durable claims, lease expiry, retry exhaustion, checkpointing, and cleanup;
4. selector and answer runtime schemas/adapters;
5. two-hour deterministic coverage and semantic evaluation corpus.

Acceptance:

- every eligible window is visited exactly once per completed plan;
- stale workers cannot settle reclaimed work;
- every accepted factual claim maps to exact admitted human evidence;
- supported and unsupported questions cannot game the quality gate through
  always-answer or always-abstain behavior.

### Phase 3 - Discord ingress and publication

1. intents/config/startup validation and listener lifecycle;
2. exact reference ACL and reverse lookup;
3. effect reservation, nonce/marker publication, reconciliation, scrubbing;
4. private-guild allowlist and low-cardinality observability.

Acceptance:

- one inbound ID binds to one immutable source tuple;
- duplicate delivery/restart produces at most one answer effect;
- ambiguous post-window create never triggers a new create;
- mentions are inert and renderer preserves every citation.

### Phase 4 - Qualification and rollout

1. deterministic fake/providerless suites;
2. disposable PostgreSQL crash matrix;
3. private test guild only, official test bot and synthetic questions;
4. retain bounded evidence for reference binding, answer marker, nonce timing,
   publication receipt, citations, and no-duplicate replay;
5. run `check:changed`, `check:fast`, and full `check` before PR/rollout.

No public guild, user account, self-bot, production channel, or real user project
is an E2E target.

## Test matrix

### Domain and application

- exact admission/conflicting replay and question-local evidence identity;
- answered/abstention/not-question cardinality and citation invariants;
- negation, correction, quotation, uncertain claims, injection, RU/EN/mixed;
- concurrent claimers, lease expiry/reclaim, stale completion, exact N-attempt
  exhaustion, backoff restart, size ceiling, and cleanup races;
- property tests for renderer citation preservation.

### PostgreSQL and crash boundaries

Inject process/connection loss before and after:

- admission;
- every selection checkpoint;
- selected/generating/ready settlement;
- effect reservation and claim;
- Discord request and response;
- effect receipt;
- question published/scrub;
- retention sweep.

Every recovery must yield the preceding or succeeding valid durable state, never
a mixed binding, skipped window, duplicate external effect, or resurrected text.

### Discord contracts

- wrong guild, room, container, author/application, reference, meeting,
  transcript/version, stale receipt, or multiple match;
- bot/webhook/self/DM/edit/delete/permission/Message Content filtering;
- lost response after committed create, deletion before reconciliation, 403,
  429, incomplete history, marker collision, payload/reference mismatch;
- nonce retry just inside/outside the conservative deadline;
- disabled mentions and `repliedUser: false`.

### Two-hour qualification

- deterministic fixture with unique sentinels across all windows and facts near
  start, middle, and end;
- exact ordered complete coverage and call ceiling;
- crash after every checkpoint and resume without skipped/rescanned windows;
- invalid selector IDs, timeout midway, restart, and fixture just over the
  supported maximum.

### Semantic quality gates

Human-labelled RU/EN/mixed corpus must achieve:

- invalid citation IDs: 0;
- cross-scope admissions: 0;
- duplicate answer business effects: 0;
- claim-entailment precision: at least 0.95;
- supported-question answer recall: at least 0.85;
- unsupported-question abstention recall: at least 0.95.

Citation membership alone is not semantic entailment. An LLM judge may
supplement, never replace, the committed human-labelled corpus.

## Observability and rollback

Low-cardinality metrics only:

- admission/rejection/dedupe/rate-limit reasons;
- reference resolution/scope denial;
- state, claim, retry, exhaustion, and age buckets;
- selector/generator latency/outcome and window coverage;
- citation rejection and answer locale/status;
- Discord create/reconcile/unknown outcome;
- scrub/sweeper outcome.

Never log or label raw question/evidence/claim text, user/meeting IDs, Discord
snowflakes, tokens, or high-cardinality provider IDs.

Rollback is the empty-by-default `MEETING_QA_GUILD_ALLOWLIST`. Disabling it
stops new admission; already ambiguous sends continue reconciliation, while
unstarted generation pauses. Recording, transcription, summary, final
publication, greetings, farewells, and ordinary live conversation remain active.

## Final acceptance checklist

- ADR-0027, overview, dependency graph, exports, and implementation agree.
- Domain/application import no provider or infrastructure type.
- Source and actor identity are durable, replay-validated, and fail closed for
  legacy/unknown data.
- Exact reply reference resolves once to one immutable admission tuple.
- Complete transcript coverage is proven for the qualified two-hour fixture.
- Every rendered factual claim has locally valid human evidence.
- Retry/lease/retention bounds prevent immortal jobs and unbounded text storage.
- Ambiguous Discord outcomes cannot create late duplicates.
- Quantitative semantic gates pass without an always-abstain loophole.
- Private synthetic E2E evidence is retained before rollout.
- Full repository check passes.

## Future compatibility constraints

These are invariants for later plans, not V1 source or tables:

### Historical Infinity Context slice

- use the official immutable `@infinity-context/sdk`, never a custom HTTP client
  or Python sidecar;
- production activation waits for npm publication, provenance/tarball digest,
  Node 24 ESM/CJS consumer smoke, used-endpoint OpenAPI fixtures, one total
  abortable deadline, stable mutation idempotency, capabilities/version match,
  and disposable deletion/absence proof;
- project only accepted final human transcripts after the authoritative producer
  emits a narrow versioned fact atomically with transcript acceptance;
- Infinity is a derived candidate locator, never evidence authority;
- every candidate is rehydrated to local exact scope/room/meeting/transcript/
  version/turn state before use;
- no summary prose, live partials, Botik output, Suggestions, Facts, user
  questions, or generated answers are indexed;
- historical search is same-room only and fails closed on missing scope;
- search/projection flags may stop serving/writes, but deletion and ambiguous
  mutation reconciliation must keep draining while derived data exists;
- tombstones appear only with the executable authorized deletion use case.

This slice receives its own ADR and plan after Local Final Reply is qualified.

### Previous-answer and live-text slices

- previous Botik answers are conversational context, never evidence; their
  original citations are revalidated;
- live evidence captures an immutable finalized-turn cutoff and excludes
  partials/late turns;
- final and live evidence are not silently mixed;
- feature epoch/cutoff is rechecked before external publication.

### Voice grounding slice

- retrieval runs in the detached active-turn executor, never the serialized
  speech-observation chain;
- barge-in, meeting end, and supersession abort retrieval immediately;
- local evidence remains useful when Infinity times out;
- evidence enters a versioned structured contract, never `systemPrompt` prose;
- cite-before-speak validation occurs before any factual segment reaches TTS;
- existing cue timing, queue, four-second answer guard, playback, and recording
  invariants remain unchanged;
- only official bots, private test guild, synthetic audio, and retained bounded
  evidence qualify the slice.

Each future slice reuses domain concepts only after V1 proves them. It may add
ports or packages only together with executable behavior, owners, tests, and a
closed dependency classification.
