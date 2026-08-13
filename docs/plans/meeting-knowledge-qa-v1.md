# Meeting Knowledge Q&A V1 - Local Final Reply

Status: ready for implementation; production rollout is NO-GO until every gate in
this plan has evidence

Date: 2026-08-13

## Outcome and scope

Deliver one coherent vertical slice: an authorized user replies to the one
Publishing-owned **current final meeting projection** in Discord and receives
one locally grounded answer from that projection's complete accepted final
transcript. The final projection is the single final summary message whose
versioned publication receipt binds the accepted transcript; replies to a live
draft, caption, playback link, previous answer, stale final message, or any other
artifact are ignored.

The original Craig recording, accepted final transcript releases, and Meeting
database are authoritative. The summary, model selections, generated claims,
indexes, and answers are derived. A factual claim is publishable only when its
citation is rehydrated to an existing eligible human turn in the immutable
transcript release admitted for that question.

V1 has no Infinity Context runtime, historical retrieval, live evidence,
previous-answer memory, or voice grounding. Historical Infinity shadow indexing
is the next independent, non-activatable slice described at the end of this plan.

### Product behavior

| Input or outcome | V1 behavior |
| --- | --- |
| Reply to an unrelated, wrong, or stale artifact | Ignore without creating a job |
| Valid target but requester is unauthorized | Return no transcript-derived content; emit a generic denial only when policy permits revealing the target, otherwise ignore |
| Valid but legacy/ineligible, unsupported size, busy, exhausted, or insufficient evidence | At most one bounded, localized, non-LLM response through the same publication-effect path |
| Valid supported question | One message containing every accepted claim and its citations |
| Ambiguous Discord create | Reconcile; never create with a new nonce or payload, and accept zero confirmed delivery rather than risk a duplicate |

The guarantee is **at most one Discord answer business effect**, not exactly-once
delivery. `delivery_unknown` can leave the user with no confirmed answer.

### Size and effort

| Deliverable | Approximate changed lines | Expected time |
| --- | ---: | ---: |
| Local Final Reply production slice | 1,700-2,400 | 6-9 working days |
| Private-guild qualification and retained evidence | 300-500 | 1-2 working days |

This is about 300-500 fewer production/test lines and 8-12 fewer crash
permutations than the original 1,900-2,900-line proposal. One evidence boundary,
one admission binding, a collapsed job state graph, and a Publishing-authoritative
delivery state remove duplicate machinery. Authorization, fencing, and bounded
provider processing are retained because they protect correctness.

## Goals

- Admit only an exact reply to the current final meeting projection.
- Authorize access to the complete transcript, not merely visibility of its
  summary, and reauthorize immediately before publication-effect reservation.
- Bind the question immutably to requester, policy, locale, source, meeting,
  transcript release, transcript binding epoch/hash, and final receipt.
- Cover every eligible turn of the complete accepted transcript or abstain; no
  prefix answer or partial-success fallback exists.
- Treat only positively identified human actors from a sealed v2 roster as
  evidence. Automation, unknown, legacy, absent, or conflicting identity fails
  closed.
- Publish only runtime-validated, bounded claims whose local citations are
  semantically supported and render as stable speaker/time/turn references.
- Bound ingress, storage, calls, tokens, provider time, cost, retry, lease,
  retention, and Discord effects across concurrency and restart.
- Keep recording, transcription, summary, meeting state, and final publication
  valid and available when Q&A components fail.
- Roll out only through an empty-by-default private-guild allowlist.

## Non-goals

- No reply target other than the current final meeting projection.
- No Infinity dependency, package, table, flag, indexing, backfill, or search in
  V1.
- No live-meeting or voice Q&A, previous-answer context, or conversational memory.
- No `/ask`, placeholder/edit flow, attachment, or multi-message answer.
- No cross-room, guild-wide, personal, Suggestions, or Facts search.
- No generic memory service, repository, unit of work, event bus, outbox,
  universal event/effect envelope, or `shared`/`common`/`utils` package.
- No new meeting-deletion command or speculative tombstone. Existing retention
  or withdrawal behavior is consumed through a versioned contract.

## Ownership and dependency direction

### Context map

| Owner / bounded context | Owns for this slice | Does not own |
| --- | --- | --- |
| Craig Voice Gateway | Authoritative original recording, durable recording spool, v2 producer capability and actor observations | Meeting, transcript, authorization, question, or answer policy |
| Meeting Lifecycle | Meeting/source identity and the monotonically enriched then sealed actor roster | Transcript releases, questions, or Discord effects |
| Transcription | Immutable accepted final transcript releases, turn identity/timing, current-release status, preservation and withdrawal facts | Retrieval, answer generation, or publication |
| Guild Installation & Configuration | Versioned meeting-Q&A requester policy and configured Discord scope | Live Discord permission observations or questions |
| Publishing | Current final projection metadata and receipt; the sole durable answer-delivery effect and reconciliation state | Transcript authority or answer truth |
| Meeting Knowledge | Immutable question admission, evidence-membership and grounded-answer invariants, bounded generation job, citations, and delivery-status projection | Other contexts' aggregates, repositories, tables, or authority |

No aggregate or repository spans contexts. Meeting Knowledge builds no persistent
transcript corpus in V1. It reads independent local projections through opaque
meeting and transcript identifiers.

### Directional boundaries

```text
meeting-knowledge domain
  <- meeting-knowledge application + consumer-owned ports
  <- ACL/adapters for Lifecycle, Transcription, Configuration, Publishing,
     Discord, PostgreSQL, and Subscription Runtime
  <- Meeting Platform composition
```

Synchronous cross-context reads use a Meeting Knowledge-owned port implemented
by an anti-corruption adapter over the provider context's curated published
contract. Answer delivery uses a Publishing-owned command contract behind a
Meeting Knowledge-owned output port. Asynchronous facts are producer-owned,
versioned, runtime-validated, and idempotently consumed. There are no deep
imports, shared tables masquerading as repositories, or cross-context domain
imports.

The complete V1 application-port set is deliberately small and directional:

| Consumer-owned port | Implementing boundary |
| --- | --- |
| `MeetingEvidencePort` | ACL over curated Publishing, Lifecycle, and Transcription read contracts |
| `RequesterAuthorizationPort` | ACL over Configuration policy plus current Discord membership/permission observations |
| `QuestionJobStore` | Meeting Knowledge PostgreSQL adapter |
| `EvidenceCandidateSelector` | Subscription Runtime selector adapter |
| `GroundedClaimGenerator` | Subscription Runtime answer adapter |
| `AnswerPublicationPort` | ACL over Publishing's versioned answer-effect command |

Do not add a provider gateway, universal store, or second interface for the same
operation until an executable slice proves a distinct contract or failure mode.

The PostgreSQL adapter may form one repeatable read model from curated
Publishing, Lifecycle, and Transcription contracts. It is owned by the Meeting
Knowledge adapter boundary, is read-only with respect to those contexts, and is
classified as an explicit fail-closed edge. It cannot import their repositories,
aggregates, internal schema types, or implementation modules.

Craig's ACL means **anti-corruption layer**, not authorization. It translates
provider artifacts into application-owned recording inputs. Discord inbound and
outbound adapters translate through application ports. Discord/Craig SDK objects,
clients, errors, snowflake behavior, Subscription Runtime execution types, and
future Infinity/Pipecat SDK types stay in adapters and composition.

Add the real `packages/meeting-core/src/features/meeting-knowledge` module only
with this vertical slice and owner. Expose only
`@discord-meeting/meeting-core/meeting-knowledge`. The implementation change must
also add ADR-0027, update the architecture feature inventory and decision model,
extend `architecture/foundation/source-dependencies.yaml` fail-closed for every
new source/test file, and update the consumer-subpath policy. Engineering
Foundation remains development-only at the exact registry version `0.6.0`.

## Versioned contracts and authority

Each relationship has its own exact, runtime-validated V1/V2 schema with an
explicit schema version, stable idempotency identity where applicable, bounded
fields, and unknown-version rejection:

- Craig `AuthoritativeReady.v2` carries durable producer capability, normalized
  source, and the sealed actor roster.
- Lifecycle publishes a source/actor snapshot contract.
- Transcription publishes accepted/replaced/withdrawn final-release contracts
  and a canonical transcript read contract.
- Configuration publishes requester-policy identity/version; its ACL combines
  that policy with current Discord authorization observations.
- Publishing publishes current-final lookup and answer-effect command/receipt
  contracts.
- Subscription Runtime implements exact selector and grounded-answer schemas.

Contracts contain primitives and contract-owned values, never aggregates,
repositories, database rows, provider SDK/runtime types, or a universal event
envelope. TypeScript types do not replace runtime codecs. Contract tests cover
valid, invalid, unknown-version, duplicate, and out-of-order delivery.

Failure or malformed output from indexing, Q&A selection, generation,
publication, cleanup, or future Infinity processing must never delete, rewrite,
invalidate, or mark failed the original recording, any accepted transcript
release, the meeting record, or the original final projection.

## Source, actors, and migration

Meeting Lifecycle persists provider-neutral source identity and actor
observations from initial recording admission:

```text
MeetingSourceSnapshot { scopeId, roomId }
MeetingActorSnapshot { actorId, kind: human | automation | unknown }
ActorRoster { producerCapability, sealedAtAuthoritativeReady, actors[] }
```

Rules:

- Every unversioned or v1 producer record restores with `actors: null` and is
  ineligible for Q&A and future historical indexing. No E2E assertion can
  retroactively prove which producer emitted an individual legacy record.
- Only `AuthoritativeReady.v2` from a durably identifiable producer revision
  whose capability declares the v2 semantics is trusted.
- The recording spool durably retains source, producer capability, and actor
  observations across restart before Meeting creation can complete.
- Before `authoritative_ready`, observations may add actors monotonically.
  Existing actors cannot disappear or change kind. An `actorId` kind conflict,
  capability conflict, or non-monotonic replay fails closed.
- At `authoritative_ready`, Lifecycle seals the complete roster. Late mutation is
  rejected; an exact duplicate is idempotent.
- Only actors positively classified `human` in the sealed roster can support an
  answer. `automation`, `unknown`, absent actors, and transcripts with no human
  evidence produce an honest ineligible response.
- No inference uses an audio track, snowflake, display/profile name, greeting
  configuration, or Botik-specific special case.

Required migration evidence includes v1/unversioned replay, v2 rolling upgrade
and downgrade, old/new producer overlap, spool restart, duplicate ready,
out-of-order ready, late human, late bot, conflicting kind, and seal replay.
Existing recording, transcription, summary, greeting, farewell, and publication
flows must remain unchanged for legacy meetings.

## Exact admission, authorization, and immutable binding

### Inbound adapter

The Discord adapter listens only for create events with `GuildMessages` and the
approved `MessageContent` intent. It ignores self, bots, webhooks, DMs, empty
content, edits, and deletes. The empty-by-default allowlist, expected bot
application, configured results container, current final message reference, and
bot permissions must all match.

It passes provider-neutral primitives: a namespaced opaque `QuestionId`, opaque
reply reference, normalized scope/container identity, bounded question text,
verified bot-application facts, and a keyed non-reversible requester subject.
It never queries Meeting Knowledge tables or resolves the meeting twice.

### Requester policy

The initial policy is `meeting_qa_requester_policy.v1`:

- the requester must be a current guild member;
- the requester must be either a positively identified participant in the sealed
  meeting roster or hold an administrator-configured Meeting Q&A role;
- current `ViewChannel` and `ReadMessageHistory` permission for the final
  container must be positively observed; and
- the guild/scope/room and current-final binding must match exactly.

Unknown membership, partial permission data, API failure, missing configuration,
policy-version mismatch, or identity-mapping ambiguity denies access. Persist the
policy ID/version, decision hash, decision time, requester subject, and facts'
expiry with admission. Re-evaluate the same policy against current membership,
roles, permissions, roster, and binding immediately before effect reservation;
the publication worker repeats the fail-closed current-permission and binding
check immediately before its first HTTP create. Revocation, departure,
replacement, or withdrawal cancels and scrubs a pre-send job/effect.

Transcript prompts may use only provider deployments whose approved
retention/training/residency configuration is pinned and attested in composition.
Missing or drifted attestation disables Q&A admission. Authorized recipients can
still copy answers; this residual disclosure risk is explicit in rollout docs.

### One evidence boundary and one binding

Meeting Knowledge owns one `MeetingEvidencePort`:

```text
resolveCurrentFinal(reference, scope) -> CurrentFinalEvidenceV1
loadAcceptedTranscript(immutableBinding, requireCurrent) -> AcceptedTranscriptV1
```

Its ACL composes only curated contracts in one repeatable database snapshot.
Zero or multiple matches fail closed. A narrow unique index resolves the current
final receipt; there is no polymorphic artifact registry.

Admission atomically inserts or validates one immutable binding:

```text
questionId, questionHash, requesterSubject
requesterPolicyId, requesterPolicyVersion, authorizationDecisionHash
expectedLocale, localePolicyVersion
scopeId, roomId, meetingId
transcriptReleaseId, transcriptVersion, transcriptBindingEpoch
transcriptBindingHash, finalProjectionReceipt, botApplicationIdentity
```

The binding hash covers the ordered turn IDs, normalized turn-content hashes,
speaker identities, actor classifications, timestamps, transcript release/version,
binding epoch, and current final receipt. A conflict in any field never rebinds.

Accepted transcript releases are immutable and preserved for at least the
24-hour maximum job age plus cleanup grace. Replacement creates a new release
and epoch; it never rewrites the admitted release. Existing authorized purge or
withdrawal emits a versioned fact and may remove source evidence only under the
source owner's policy—it does not originate in Q&A.

Every load checks release ID/version/hash. Before publication-effect reservation,
`requireCurrent=true` rechecks the entire binding in a fresh snapshot. Replacement,
withdrawal, missing turns, changed roster, changed final receipt, or deletion
cancels and scrubs the job. The effect reservation adapter rechecks that local
binding while mutating only Publishing's effect state. No Q&A failure can mutate
the source authorities.

## Grounded generation

### Evidence identity and citations

The application derives deterministic question-local opaque `EvidenceId` values
and holds only `EvidenceId -> turnId`; the immutable source tuple is stored once
in the admission binding. Models never receive naked turn IDs.

Candidate selection is not evidence. Before generation and again before render,
the application reloads canonical turns from the admitted release, rejects
unknown/duplicate/cross-release IDs, and validates human membership. Every
accepted claim retains a non-text citation binding:

```text
transcriptReleaseId, transcriptVersion, turnId,
speakerLabel, startMs, endMs
```

The rendered citation is stable and comprehensible, for example
`[Speaker 2, 00:12:34-00:12:49, turn 184]`. Citation bindings contain no
transcript text and live under the authoritative source-retention policy. An
authorized source deletion cascades the binding; hashes alone never pretend the
turn remains auditable.

Rendering is all-or-nothing. It emits every accepted claim exactly once with all
its citations and only fixed localized non-factual wrapper text. The complete
rendered payload, reply metadata, and hidden deterministic marker must fit one
Discord message. Oversize output is rejected and replaced by a fixed bounded
failure response; no claim, citation, or rendered payload is ever truncated.

### Locale

`answer-locale-policy.v1` deterministically derives `ru`, `en`, or `mixed` from
the bounded question; an explicit supported answer-language request wins.
Admission persists the expected locale and policy version. The runtime result
must match it exactly. Fixed denial, busy, unsupported, abstention, and failure
responses use the same expected locale without an LLM. Unsupported or ambiguous
locale fails closed to a configured neutral response.

### Complete transcript coverage

Launch qualification supports at most 5,000 eligible turns and 400,000
normalized characters, including a realistic two-hour fixture below both
ceilings. This is an operational launch bound, not a promise that all two-hour
meetings fit. Larger transcripts settle `unsupported_size`; the system never
answers from a prefix.

Before any provider call, reject a normalized turn over 12,000 characters as
`unsupported_turn_size`. This avoids invented fragment evidence. Otherwise:

1. Partition ordered turns into windows of at most 120 turns and 12,000
   normalized characters.
2. Every window consumes at least one previously unseen turn. Overlap is
   `min(8, consumedTurns - 1)`, so `nextStart > currentStart`; assert this strict
   progress and a finite window count before calling a provider.
3. Batch at most six windows per selector call and request only candidate
   `EvidenceId` values.
4. After each successful batch, persist one compact checkpoint containing the
   binding/window-plan hash, next batch index, bounded candidate turn IDs,
   per-batch attempt counts, and cumulative usage reservations. It does not copy
   the source tuple or transcript text.
5. Deduplicate, canonically reload, add at most two neighboring human turns on
   each side, repack to the final budget, and generate structured claims once.

The no-retry expected ceiling is `ceil(windowCount / 6) + 1`. At launch the hard
worst-case limits, including retries and lost outcomes, are:

- 45 windows, 8 selector batches, 3 attempts per batch, and 3 generation
  attempts: at most 27 provider calls;
- 1,500,000 cumulative input tokens and 24,000 cumulative output tokens;
- 15 minutes cumulative provider wall time and USD 5.00 conservative
  cost-equivalent per job; and
- 24 hours from admission to terminal settlement.

All numbers are validated configuration with a pinned policy version. Reserve
calls, maximum tokens, maximum time, and maximum cost atomically before each
provider request; charge the conservative maximum when an outcome is lost.
Usage, batch attempts, and total budgets survive restart. Budget exhaustion is
terminal, never partial success.

Selector responses are capped at 64 KiB and answer responses at 128 KiB before
full decoding. A streaming guard rejects excess bytes, nesting deeper than 8,
more than 2,048 JSON nodes, invalid encoding, or trailing data before the exact
runtime codec runs. Each request deadline is shorter than its database lease.

### Runtime schemas

Meeting Knowledge owns separate provider-neutral ports because selection and
grounded answers have different contracts and failure modes:

```text
discord_meeting.knowledge.select_evidence.v1
discord_meeting.knowledge.answer.v1
```

The Subscription Runtime adapter owns prompt mapping, pre-codec guards, strict
codecs, attestation, and bounded failure mapping. Subscription Runtime is a
replaceable adapter, never evidence authority.

The answer schema has exact keys only:

```text
status: answered | insufficient_evidence | not_a_question
locale: ru | en | mixed
claims: [{ text, evidenceIds[] }]
```

`answered` has 1-12 bounded non-empty claims and each claim has 1-8 unique
admitted evidence IDs. Other statuses have no claims. Unknown keys/types,
control/bidi characters, mention payloads, duplicate IDs, locale mismatch,
cross-release IDs, or bounds violations reject the whole output. Model confidence
and citation membership never substitute for semantic entailment.

## Durable job and publication effect

### Meeting Knowledge job

Use one small application-owned job, not a workflow aggregate:

```text
admitted -> running(select | generate) -> ready
admitted | running | ready -> cancelled | unsupported | exhausted
ready -> delivered | delivery_unknown | cancelled   # projection of effect only
```

`insufficient_evidence`, `not_a_question`, busy, and denial are bounded answer
outcomes, not extra workflow states. Technical fields are `claimGeneration`,
`leaseUntil`, `nextAttemptAt`, stage/batch attempts, cumulative budgets,
`terminalEpoch`, and bounded failure reason.

Claiming uses database time and one conditional claim operation. Every
checkpoint and settlement must match state, generation, `leaseUntil >
database_now()`, and the monotonic terminal epoch. Equality at expiry is expired.
A provider deadline ends before the lease. Reclaim increments generation. No
stale generation can checkpoint, settle, reverse terminal state, or resurrect
scrubbed text.

### Publishing-authoritative fenced effect

Publishing owns the only delivery authority:

```text
reserved -> claimed
claimed -> send_started | cancelled
send_started -> delivered | reconciling
reconciling -> delivered | delivery_unknown
reserved -> cancelled
claimed(g) -> claimed(g+1)                 # lease expired before send
reconciling(g) -> reconciling(g+1)         # reconciliation lease expired
```

The deterministic effect ID is derived from the immutable question identity.
Reservation persists the exact target/reply reference, bot application, answer
marker version, nonce, exact rendered payload bytes, payload hash, binding epoch/
hash, authorization policy/decision version, `firstSendStartedAt`, conservative
`nonceValidUntil`, nullable receipt, claim generation, database-time lease, and
terminal reason. `firstSendStartedAt` is null until the send-start CAS. A repeated
reservation must match every immutable byte/field.

Effect rules:

1. Reauthorization and a current-binding recheck occur immediately before the
   single idempotent reservation. Failure cancels without an HTTP effect.
2. Claim/reclaim is single-flight and uses a database-time generation and lease.
   Only an expired pre-send or reconciliation claim can increment generation. A
   worker must still own the unexpired fence immediately before transitioning to
   `send_started`; there is no await or external work between that CAS and
   beginning the bounded HTTP call. A generation that loses its fence cannot
   begin HTTP.
3. The HTTP deadline is shorter than the lease. `send_started` never returns to
   `reserved`; lease expiry permits only a separately fenced reconciliation
   claim, not a fresh effect.
4. Send with `enforceNonce`, disabled allowed mentions, and `repliedUser: false`.
   Any retry uses the stored identical payload, nonce, marker, and target.
5. A rejection proven before remote acceptance may retry by policy. After an
   ambiguous create, the identical request may be retried only after the prior
   HTTP deadline and while the conservative nonce window is definitely open.
6. After that window, an exact observed marker may prove delivery; history
   absence never proves non-creation. Forbidden/incomplete history, deletion,
   conflict, multiple matches, or no exact match converges terminally to
   `delivery_unknown`; no later create is authorized.
7. Marker reconciliation checks author/application, container, reply target,
   nonce, marker version, and payload hash. Only a confirmed receipt reaches
   `delivered`.

An idempotent convergence worker projects `delivered`, `delivery_unknown`, or
`cancelled` onto the QuestionJob and scrubs temporary content. The question row
never independently claims publication success and never mirrors effect claim
states. A paused stale sender, reconciler, and scrubber cannot produce divergent
terminal states.

Qualification uses an independent official test-bot Discord observer to count
actual matching messages after committed-create/lost-response and restart. A
database effect count is not delivery evidence.

## Admission, abuse, retention, and privacy

Admission performs immutable dedupe and quota reservation in one PostgreSQL
transaction. A duplicate matching binding returns the existing outcome without
consuming quota; a conflicting duplicate fails closed. Initial limits are:

- question text: 4,000 normalized characters;
- requester: 3 new jobs per 10 minutes and 20 per UTC day;
- guild: 10 per 10 minutes and 100 per UTC day;
- global: 20 per 10 minutes and 200 per UTC day;
- active jobs: 2 per guild and 4 globally; queued raw question bytes: 2 MiB
  globally; and
- provider spend: USD 5.00/job, USD 20.00/guild/day, USD 50.00/global/day,
  reserved conservatively before work.

Counters use database time, survive restart, and cannot be bypassed by concurrent
admission. A requester receives at most one quota notice per reason/window; the
rest are silent, so rejection cannot amplify a flood. Limits and keyed-subject
rotation have a versioned operational policy.

Raw question, candidate IDs, claims, and payload are scrubbed in the terminal
transaction for delivered, cancelled, ignored, unsupported, exhausted, and
insufficient outcomes. A nonterminal job is forcibly settled and scrubbed by 24
hours. `delivery_unknown` retains its bounded immutable payload for at most 7
days for reconciliation, then becomes terminal `abandoned_fail_closed` and
scrubs.

Operational terminal metadata expires after 30 days. A minimal non-text
question/effect dedupe key and confirmed receipt remain only until the source
meeting's retention expires, preventing late event replay without unbounded
standalone growth. Citation bindings follow transcript retention and cascade on
authorized source deletion. A fenced sweeper cannot race a worker to restore
text. Logs, metrics, traces, and labels never contain raw question/evidence/claim
text, Discord snowflakes, actor/meeting IDs, tokens, or high-cardinality provider
IDs.

## Ordered implementation and acceptance evidence

### Phase 1 - Decisions, boundaries, and v2 identity

Owners: Meeting Lifecycle owner for source/roster; Craig owner for v2 ACL/spool;
Meeting Knowledge owner for feature boundary; architecture owner for enforcement.

1. Accept ADR-0027 and update the overview, dependency model, feature inventory,
   exports, Foundation classification, and consumer allowlist with the real
   slice.
2. Add runtime-validated Craig v2 capability/roster contracts, spool retention,
   monotonic enrichment/seal, and Lifecycle restore/replay behavior.
3. Add the Meeting Knowledge feature with domain/application tests and only the
   source directories used by this slice.

Acceptance evidence: architecture gates show no unclassified/deep/provider
edge; exact Foundation `0.6.0` is development-only; rolling-upgrade/replay tests
pass; legacy and unknown actors are ineligible; original workflows are unchanged.

### Phase 2 - Admission, authorization, and local answer

Owners: Meeting Knowledge owner for policy orchestration/job/domain; Lifecycle,
Transcription, Configuration, and Publishing owners for their curated contracts;
Subscription Runtime owner for its two adapters.

1. Implement current-final lookup, requester policy, one immutable binding, and
   canonical release load/recheck through consumer-owned ports and ACLs.
2. Implement deterministic windowing, checkpoint/budget fencing, strict runtime
   schemas, canonical reload, grounded-answer invariants, locale policy, stable
   citations, and all-or-nothing renderer.
3. Implement atomic dedupe/quota, terminal settlement, retention, and scrub.

Acceptance evidence: an admitted binding survives restart but cannot drift;
replacement/deletion at every checkpoint cancels; every supported window is
visited; overlong/oversize/malformed/budget cases terminate; every rendered fact
rehydrates to an eligible turn; no source authority is mutated by failures.

### Phase 3 - Fenced Discord delivery

Owners: Publishing owner for effect state/reconciliation; Discord adapter owner
for ingress/egress/observer; Meeting Knowledge owner for the output port and
delivery projection.

1. Add listener lifecycle, intents/config validation, exact target filtering,
   fresh pre-reservation authorization, and current-binding checks.
2. Implement the complete effect state machine, DB-time leases/generations,
   identical nonce/payload retry, marker reconciliation, terminal convergence,
   and scrubbing.
3. Prove actual remote count with an independent observer.

Acceptance evidence: duplicates/concurrent workers/restarts yield at most one
observed Discord message; a stale generation never begins HTTP; ambiguous
post-window outcomes never create again; mentions are inert; no payload is
truncated; all terminal effect states converge to one job projection.

### Phase 4 - Qualification and rollout

Owners: Meeting Knowledge owner signs local/semantic evidence; Reliability owner
signs PostgreSQL crash evidence; Discord test owner signs private-guild evidence;
product/security owner approves requester and provider-data policies.

1. Run deterministic domain/application/contract suites and the disposable
   PostgreSQL crash matrix.
2. Run the frozen semantic corpus and providerless two-hour fixture.
3. In an approved private test guild only, use official test bots, test-only
   channels/identities, and synthetic text/audio. Retain bounded receipts from the
   independent observer.
4. Run `pnpm run check:changed`, `pnpm run check:fast`, and the complete
   `pnpm run check` before PR/rollout.

Acceptance evidence is a versioned manifest binding source revision, policy and
codec versions, fixtures, seeds/replays, PostgreSQL crash results, semantic
scores, observer message counts, effect receipts, and all three repository checks.
No user account, self-bot, public guild, production channel, real user project,
or production/user data is a qualification target.

## Test and qualification matrix

### Direction, authority, and contracts

- domain/application import no provider SDK/runtime, environment, wall clock,
  randomness, timer, database, queue, or adapter type;
- curated cross-context ports/ACLs reject unknown contract versions and
  duplicate/out-of-order conflicts;
- recording, transcript releases, meeting state, and final projection remain
  valid after every Q&A/runtime/publication failure;
- Foundation fail-closed classification and consumer subpath enforcement cover
  every new source/test file.

### Admission, identity, authorization, and locale

- wrong/stale/current target, zero/multiple match, immutable duplicate conflict,
  transcript/version/hash/epoch/receipt drift, missing turn, replacement, and
  withdrawal at every checkpoint and immediately before reservation/send;
- participant, configured role, nonparticipant, revoked role, departed member,
  cross-room, permission loss, API failure, policy upgrade, and expired decision;
- all legacy/v1/v2 rolling and roster enrichment/seal cases named in Phase 1;
- expected RU/EN/mixed locale, explicit override, mismatch, unsupported input,
  and localized fixed responses.

### Processing and abuse

- strict window forward progress, one-turn windows, overlap boundaries, maximum
  window/batch counts, an overlong turn, exact ceiling, and just-over ceiling;
- timeout, malformed/oversize/deep response and crash before/after every batch
  call/checkpoint with persisted attempts and conservative lost-outcome charge;
- total call/token/time/cost exhaustion and provider-retention attestation drift;
- concurrent dedupe/quota at requester/guild/global scope, spend/byte caps,
  restart, keyed-subject rotation, quota-notice suppression, and sustained
  synthetic flood.

### Claims, rendering, and semantic quality

- unknown/duplicate/cross-release/cross-human evidence IDs; negation,
  correction, quotation, uncertainty, prompt injection, and conflicting turns;
- property tests prove each accepted claim/citation appears once, stable
  speaker/time/turn rendering survives terminal scrub, mentions remain inert,
  and one-byte-over payload rejects without truncation;
- a frozen unseen human-labelled corpus contains at least 100 answerable and 100
  unsupported questions for each of RU, EN, and mixed, plus at least 60 examples
  in each adversarial category (examples may overlap locale sets);
- invalid citation, cross-scope admission, and duplicate observed effect counts
  are zero; one-sided 95% confidence lower bounds meet 0.95 claim-entailment
  precision, 0.85 supported-question recall, and 0.95 unsupported-question
  abstention recall for every locale and adversarial slice, not only aggregate;
- two independent adjudicators resolve disagreements before scores are frozen.

An LLM judge may supplement but never replace the committed human labels.
Recurring provider qualification detects drift.

### Fencing, crashes, and external effects

Use separate PostgreSQL processes/connections and inject loss before/after
admission, quota reservation, every checkpoint/settlement, lease equality and
expiry, reclaim, terminal scrub, effect reservation/claim/send-start, Discord
request/response, receipt, reconciliation, convergence, and retention sweep.

Test a paused stale sender before and after nonce expiry; 403, 429, proven
pre-accept rejection, committed-create/lost-response, incomplete history,
deleted message, marker collision, payload mismatch, multiple marker matches, and
scrubber/reconciler races. Valid recovery reaches only the preceding or succeeding
durable state and never a mixed binding, skipped window, resurrected text, new
post-window create, or second independently observed message.

## Observability, rollout, and no-go gates

Only low-cardinality reason, state, retry/age, locale, window coverage, budget,
effect/reconcile, authorization-policy, and scrub metrics are emitted. Alerts
cover oldest job/effect age, lease churn, budget denial, authorization drift,
codec rejection, `delivery_unknown`, observer disagreement, and cleanup lag.

Rollback is the empty-by-default `MEETING_QA_GUILD_ALLOWLIST`. Disabling it stops
new admission and pauses unstarted generation. Already-started ambiguous effects
continue reconciliation, cleanup continues, and pre-send jobs are cancelled or
drained by policy. Recording, transcription, summary, existing final publishing,
playback, greetings, farewells, and live conversation remain active.

Production remains NO-GO until all are true:

- product/security approve `meeting_qa_requester_policy.v1` and provider
  retention/training/residency attestation;
- v2 producer capability, sealed roster, immutable transcript release, and
  current-final receipt survive rolling upgrade/replay;
- authoritative binding and authorization rechecks cancel every drift/revocation
  case before external create;
- two-hour bounds, provider budgets, pre-codec limits, and atomic quotas pass;
- PostgreSQL crash/fence matrix and independent Discord at-most-one evidence pass;
- per-locale/adversarial semantic confidence gates pass;
- architecture, changed, fast, and full repository checks pass; and
- rollback/drain and terminal retention evidence is retained and signed by the
  named owners.

## Decision ledger

| Decision | Disposition and reason |
| --- | --- |
| Exact current-final local reply is the only V1 | Fixed; it is the smallest useful product behavior |
| Explicit context ownership and directional ports/ACLs | Fixed; prevents a distributed Meeting aggregate and provider leakage |
| One evidence port and one immutable source binding | Fixed and simplified; avoids duplicate queries and copied tuples |
| Immutable release epoch/hash, preservation, cancellation, and pre-effect recheck | Fixed; prevents mixed-version claims |
| Versioned requester policy and immediate reauthorization | Fixed; summary visibility alone cannot authorize transcript disclosure |
| All v1/unversioned actors ineligible; v2 roster enriches monotonically then seals | Fixed; a plain human-ID set was rejected because unknown/conflicting actor observations and migration provenance must fail closed |
| Collapsed QuestionJob states; Publishing effect is delivery authority | Fixed and simplified; removes two competing publication invariants |
| Persist compact successful-batch checkpoints | Fixed; rejecting checkpoints was not accepted because bounded two-hour retries otherwise repeat paid work and weaken total-budget/restart evidence |
| Requester/guild/global quotas and spend bounds | Fixed; concurrency alone does not bound ingress, storage, or provider cost |
| Stable non-text citation binding and all-or-nothing render | Fixed; terminal scrub cannot make published citations meaningless |
| Unsupported quality forecasts | Removed; only measured gates remain |
| Historical Infinity removed entirely | Rejected; product requires it, so it remains only as the explicitly non-activatable next slice below |
| Live, previous-answer, and voice grounding | Deferred to separate ADRs/plans after V1 qualification; no source or package is added now |
| New deletion/tombstone model | Deferred; consume existing versioned withdrawal only and add deletion behavior with a real authorized use case |

## Next independent slices

### Historical Infinity Context shadow indexing

This section constrains a later ADR/plan; it authorizes no V1 code, dependency,
flag, table, traffic, or activation.

- Use only the official immutable `@infinity-context/sdk` TypeScript package,
  never a custom HTTP client or Python sidecar. Activation waits for npm
  publication, provenance/tarball pinning, Node 24 consumer smoke, capabilities/
  version match, bounded abort behavior, and disposable endpoint fixtures.
- Transcription's application layer writes a narrow producer-owned
  `FinalTranscriptAccepted.v1` fact to its transactional outbox in the same local
  transaction that accepts the release. This is purpose-specific, not a generic
  outbox/event service.
- The consumer uses deterministic mutation IDs derived from scope, meeting,
  transcript release, operation, and policy version. Local state records pending,
  applied, superseding, deleting, reconcile, and terminal/dead-letter outcomes
  with bounded attempts.
- Replacement indexes the new accepted release and marks the old release
  superseded; search results are never evidence and local current-release checks
  reject stale candidates. Authorized deletion produces deterministic delete
  mutations for every derived object. Deletion and ambiguous-mutation
  reconciliation keep draining even when search/write serving flags are off.
- Lost remote responses reconcile by deterministic mutation identity and an
  independently qualified absence oracle; they never retry with a new identity.
  Crash tests cover local commit, remote commit, lost response, supersession,
  delete, dead letter, reconciliation, and verified absence.
- Only accepted final human transcript turns are indexed. No summary prose, live
  partial, automation/Botik output, Suggestions, Facts, question, or generated
  answer enters Infinity.
- Infinity is a derived same-room candidate locator. Every candidate is locally
  rehydrated to exact scope/room/meeting/release/version/turn and current
  authorization before use. Local authority remains useful when Infinity fails.

Historical activation is a separate rollout gate after Local Final Reply is
qualified.

### Previous-answer and live-text grounding

- Previous Botik answers are context, never evidence; their original citations
  are revalidated.
- Live evidence captures an immutable finalized-turn cutoff, excludes partials
  and late turns, and is never silently mixed with final evidence.
- The evidence epoch/cutoff and requester authorization are rechecked before an
  external effect.

### Voice grounding

- Reuse Meeting Knowledge's provider-neutral evidence and grounded-claim
  application contracts, not Discord, Infinity, Pipecat, Subscription Runtime,
  or database infrastructure types.
- Retrieval runs in the detached active-turn executor; barge-in, meeting end,
  and supersession abort it. Evidence uses a versioned structured contract, not
  `systemPrompt` prose, and cite-before-speak validation occurs before factual
  audio reaches TTS.
- Preserve existing cue timing, queues, four-second answer guard, playback, and
  recording invariants. Qualify only with official bots, a private test guild,
  test identities, synthetic audio, and bounded retained evidence.

Each next slice gets its own owner, ADR, plan, executable behavior, tests, and
fail-closed source classification. No speculative package is created in V1.
