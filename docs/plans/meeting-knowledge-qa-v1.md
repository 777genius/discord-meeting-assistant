# Meeting Knowledge Delivery Plan

Status: ready for phased implementation; every production capability is disabled
by default until its own acceptance evidence is bound to the deployed revision

Date: 2026-08-13

## Outcome

Deliver four independent vertical slices without coupling Discord, Infinity
Context, voice transport, or model providers to the Meeting Knowledge domain:

1. **Trusted evidence baseline** - a final transcript can prove its source,
   sealed human roster, producer semantics, and current final Discord projection.
2. **Canonical Projection Reply** - an authorized participant replies to
   Botik's exact current live-transcript projection while its meeting is active,
   or to the current final summary/transcript projection after finalization, and
   receives one locally grounded answer.
3. **Same-room historical memory** - accepted human transcript turns are indexed
   through the official Infinity Context TypeScript SDK; search results are only
   candidates and are locally rehydrated and reauthorized before generation.
4. **Grounded voice reuse** - the active conversation asks Meeting Knowledge for
   a validated answer, then speaks the complete answer through the existing
   literal-speech path with normal barge-in and meeting-end cancellation.

Greetings, farewells, recording, transcription, summary publication, and normal
conversation stay independent. Failure or rollback of any knowledge slice never
invalidates the recording, meeting, transcript, summary, or existing voice flow.

## Three-pass review synthesis

This revision incorporates three independent hosted reviews: DDD/SOLID,
reliability/security/E2E, and simplicity/DRY.

### Accepted findings

- The earlier plan stopped at Local Final Reply while Infinity and voice were
  non-executable notes. They are now separately deployable phases with owners,
  ports, kill switches, tests, and acceptance gates.
- Meeting Lifecycle, Transcription, Intelligence, Publishing, Conversation, and
  Meeting Knowledge are feature ownership areas inside the existing Meeting Core
  bounded context today. The plan does not pretend they are already separately
  persisted bounded contexts.
- Existing actor-v2 work is a baseline, not completed trust proof. It lacks a
  durable producer capability/revision and an explicit sealed-roster proof.
- A non-reversible requester hash cannot support authorization after restart.
  The adapter therefore keeps a short-lived opaque authorization principal
  reference and a separate keyed dedupe subject.
- Under ADR-0034, Local Final Reply uses the same bounded, retrieval-first
  evidence path as historical and voice questions. The answer model never
  receives a complete transcript, growing prefix, generated summary, or other
  derived substitute.
- Discord delivery authorizes exactly one create attempt per answer effect. Once
  request bytes may have crossed the boundary, recovery reconciles and never
  performs another create.
- Citation membership is deterministic; semantic entailment is measured. Claims
  about absence, all items, global counts, or exhaustive lists abstain in V1
  unless a deterministic reducer exists for that claim class.
- Infinity is a derived candidate locator. The official TypeScript SDK is the
  only Infinity integration dependency; no custom HTTP client or Python sidecar
  is added.
- Source withdrawal drives durable retraction/deletion of derived Discord and
  Infinity data. Cleanup continues while serving is disabled.

### Rejected extremes

- **Rejected:** extracting every existing Meeting feature into a new service or
  repository before the first answer. It is a high-risk migration unrelated to
  the smallest useful behavior.
- **Rejected:** treating the current monolithic Meeting JSON snapshot as a
  timeless architecture. New durable QuestionJob, AnswerEffect, and Historical
  Sync records have explicit owners and migrations; any future transcript
  replacement capability gets its own authority ADR before activation.
- **Rejected:** a generic repository, unit of work, workflow engine, event bus,
  outbox, provider gateway, effect envelope, or `shared/common/utils` package.
- **Rejected:** a huge Cartesian crash × locale × quota × provider matrix. Tests
  cover every durable transition and security invariant, plus representative
  cross-products and property-based edge cases.

## Architecture and ownership

### Context map

| Owner | Authority | Collaboration for this delivery |
| --- | --- | --- |
| Craig Voice Gateway | Original recording, actor observations, provider capability | Publishes versioned lifecycle facts through its ACL |
| Meeting Lifecycle feature | Meeting/source identity and sealed actor roster | Supplies trusted evidence identity |
| Transcription feature | Accepted final transcript and its canonical turns | Supplies current immutable evidence; publishes purpose-specific accepted/withdrawn facts |
| Publishing feature | Current final projection and immutable answer effects | Sole Discord answer-delivery and retraction authority |
| Guild Configuration bounded context | Installed guild/channel mapping | Publishes the enabled scope; configured Q&A roles are deferred |
| Meeting Knowledge feature | Question admission, evidence eligibility, grounded claims/citations, historical sync intent | Publishes one provider-neutral grounded-answer use case |
| Conversation feature | Active spoken turn, cancellation, cue and playback policy | Consumes Meeting Knowledge through its own port |

The current implementation remains one Meeting Core bounded context with feature
modules and one process composition. Cross-feature application collaboration uses
curated primitive DTOs and narrow ports; it never imports another feature's
aggregate, repository, adapter, database row, or provider type. Craig and Guild
Configuration remain separate boundaries with anti-corruption adapters.

### Dependency direction

```text
meeting-knowledge domain
  <- meeting-knowledge application and consumer-owned ports
  <- Discord/PostgreSQL/Subscription Runtime/Infinity ACL adapters
  <- Meeting Platform composition

conversation application
  -> Conversation-owned GroundedKnowledgeAnswerPort
  -> ACL to Meeting Knowledge's published application use case
```

Infinity SDK, Discord SDK, PostgreSQL, Craig, Subscription Runtime, Pipecat, TTS,
environment, time, randomness, and timers never enter domain/application source.
Every new source file is fail-closed in the architecture dependency model.

### Capability-specific ports

Canonical Projection Reply uses only:

- `FinalReplyEvidencePort` - loads an exact current-final authoritative snapshot
  and later rehydrates historical candidate references.
- `QuestionAuthorizationPort` - produces fresh, bounded authorization
  observations from the opaque principal reference.
- `QuestionAdmissionCommitPort` - conditionally commits dedupe, rate reservation,
  immutable evidence binding, and job only if expected local authority is still
  current in one PostgreSQL transaction.
- `QuestionJobStore` - leases, attempts, terminal outcome, expiry, and scrub.
- `GroundedAnswerGenerator` - one strict provider-neutral grounded-answer call.
- `AnswerPublicationPort` - Publishing-owned immutable answer-effect command.

Historical memory adds two focused ports:

- `HistoricalMemoryPort` with `indexFinalMeeting`, `searchRoom`, and
  `deleteMeeting` capabilities implemented only by the Infinity SDK adapter.
- `HistoricalSyncStore` for local desired generation, mutation identity, retry,
  reconciliation, and deletion progress.

Conversation owns `GroundedKnowledgeAnswerPort`; it does not depend on the
generator, Infinity, Discord, or database ports.

## Phase 0 - Close the trusted evidence baseline

### Current baseline

ADR-0027, source/actor persistence, actor-kind conflict checks, architecture
classification, and the initial Meeting Knowledge identity module already exist.
They remain regression-gated and are not counted as a working Q&A feature.

### Required delta

Publish a backward-compatible lifecycle version newer than the existing
capability-less v2. It contains primitive, runtime-validated fields:

```text
producerCapabilityId
producerRevision
actorSemanticsVersion
rosterState: sealed
actors[]
source { scopeId, roomId }
```

Craig durably stores these fields with actor observations before Meeting creation
can complete. Recording ingress preserves them through restart and completion.
Lifecycle persists the exact capability and sealed roster. Existing v1,
unversioned, capability-less v2, unknown future capability, unsealed roster, and
conflicting observations remain valid for recording/summary but are ineligible
for knowledge and historical indexing.

Lifecycle is the sole canonicalizer of source and actor observations. Meeting
Knowledge validates the published sealed-roster contract/version and owns only
human-evidence eligibility; it does not duplicate normalization rules.

### Gate

- rolling upgrade/downgrade and old/new producer overlap;
- spool restart, duplicate/out-of-order ready, late actor, kind/capability
  conflict, exact sealed replay, and unknown future version;
- no regression in recording, transcript, summary, greeting, farewell, or
  publication;
- cross-repository contract fixtures and digests are generated from one canonical
  schema and consumed by both repositories.

## Phase 1 - Local Final Reply

### Product admission

The Discord input adapter handles only create events that are:

- in an allowlisted installed guild/results container;
- from a human, not Botik, another bot, webhook, DM, or empty message;
- an exact reply to Publishing's current canonical projection: the bot-owned
  live-transcript projection while the meeting is active, otherwise the current
  final summary/transcript projection after finalization.

Transport validation and self/bot/webhook filtering stay in the adapter. Product
currentness is resolved exactly once by Meeting Knowledge from persisted
projection ownership and persisted source identity, never message text, embeds,
captions, or nicknames. Arbitrary captions/drafts, replaced or deleted live
projections, non-bot targets, wrong guild/container/thread, recording links,
prior answers, stale finals, cross-scope requests, and unrelated messages are
ignored without a job. Ending a meeting revokes its live target immediately;
the accepted final canonical projection becomes eligible through the unchanged
final-reply path.

Question edit cancels and scrubs pre-send work; a new create event is required.
Question deletion cancels and scrubs pre-send work. Final-projection deletion or
withdrawal marks it unavailable and cancels pre-send work. Answer deletion never
causes automatic recreation.

### Authorization

V1 is participant-only: requester must be positively present as a human in the
sealed roster and currently able to view the results channel and history. A
configurable admin/Q&A role is a later Configuration vertical slice.

Ingress creates:

- a keyed non-reversible requester subject for dedupe/rate limiting; and
- a short-lived opaque `authorizationPrincipalRef` that the Discord adapter can
  resolve after restart. It is never logged and is scrubbed at terminal/expiry.

Fresh authorization is checked:

1. before the first transcript hydration;
2. before the provider call;
3. before answer-effect reservation; and
4. immediately before the send authorization CAS.

Each observation records policy version, source, observed/expiry time, and digest.
Expired, cache-only, partial, changing, or failed observations deny. The honest
guarantee is that a revocation positively observed before a checkpoint cancels
the operation; Discord permission changes cannot be made linearizable with the
network create.

### Atomic admission and immutable binding

The application first obtains a fresh authorization observation and authoritative
snapshot. `QuestionAdmissionCommitPort` then uses one local PostgreSQL transaction
to verify that the expected projection, meeting revision, transcript identity,
sealed roster, and policy are still current while inserting the immutable job and
rate reservation.

The binding contains only bounded primitives:

```text
questionId, questionHash, requesterSubject, authorizationPrincipalRef
policyVersion, authorizationDigest, expectedLocale
scopeId, roomId, meetingId, meetingRevision
transcriptId, transcriptVersion, canonicalEvidenceHash
finalProjectionReceipt, finalProjectionEpoch, botApplicationIdentity
```

A duplicate with identical fields returns the existing outcome. Any mismatch
fails closed and never rebinds. Legacy receipts/snapshots without the required
identity are readable but ineligible.

Current source does not support transcript replacement. V1 therefore binds the
existing final transcript ID/version, Meeting revision, canonical turn hash, and
current projection receipt. A future replacement/withdrawal command must first
add a source-owned transition ADR and versioned facts; it cannot silently mutate
these fields. During any future R1/F1 to R2/F2 transition, zero eligible current
projection is safer than a mixed binding.

### Adaptive bounded grounding

A long context window is capacity, not proof of recall. The application builds
one explicit, persisted `GroundingPlan` before provider work:

```text
focused_retrieval    # bounded current/same-room candidates, locally rehydrated
exhaustive_coverage  # every relevant block visited before synthesis
```

`focused_retrieval` serves every ordinary current, voice, and historical
question. It selects a bounded set of current and same-room candidate locators,
locally rehydrates and reauthorizes them, and fuses source-qualified ranks. SDK
text and metadata, oversized whole transcripts, transcript prefixes, live
interim speech, and summaries never reach the answer model. Low-recall or
unsupported questions abstain instead of expanding the prompt implicitly.
The focused contract never carries a complete current reference set, so request
size is independent of transcript length.

Before every provider call, the production adapter computes exact request bytes
and model-token usage against the pinned runtime/model capability, leaving
explicit room for instructions, the question, reasoning, structured output,
and model-limit drift. Oversized bounded requests return localized
`unsupported_size`; they are never silently truncated.

`exhaustive_coverage` is selected for counts, absence/universal claims,
exhaustive lists, broad summaries, or questions requiring comparison across
many meetings. It deterministically partitions the authorized source set into
turn-aligned evidence blocks, visits every block through a bounded structured
extract/reduce pass, persists a coverage bitmap and attempt budget, locally
rehydrates the selected turns, and only then performs final synthesis. No final
answer is allowed when a block is missing, stale, unauthorized, or unprocessed.
This is the only path that needs multi-stage checkpoints; it is not a generic
workflow framework.

The provider returns an exact runtime-validated shape:

```text
status: answered | insufficient_evidence | not_a_question
locale: ru | en | mixed
claims: [{ text, evidenceIds[] }]
```

Composition adds dedicated Subscription Runtime purposes rather than reusing the
summary or low-latency conversation profiles:

```text
discord_meeting.knowledge.answer.v1
discord_meeting.knowledge.coverage_extract.v1
```

The initial answer candidate is `gpt-5.6-sol` with medium reasoning, disabled
tools, stateless execution, and the strict claim schema above. Coverage extraction
has its own exact evidence-only schema and cannot emit answer prose. Exact model,
reasoning, input headroom, output budget, runtime package, launcher digest, and
policy versions are pinned in composition and the retained evidence manifest.
Changing any of them requires replaying the semantic and two-hour qualification;
the model's advertised context size alone never authorizes rollout.

Rules:

- 1-12 bounded claims for `answered`; other statuses contain no claims;
- every claim cites only admitted human evidence IDs;
- canonical turns are reloaded before render and the full binding is compared;
- Discord mentions, links, markdown deception, bidi/control characters, unknown
  keys, duplicate IDs, invalid encoding, trailing data, or oversize output reject
  the complete result;
- the rendered one-message payload is all-or-nothing and never truncated;
- exact quotes additionally require canonical span/hash validation;
- corrections/conflicts include the correction and material conflicting turns;
- universal, absence, count, broad-summary, and exhaustive-list questions
  abstain until `exhaustive_coverage` is qualified; afterward they must use that
  mode and may never silently fall back to focused retrieval.

Citations render stable speaker/time/turn references. Membership, identity,
scope, and source immutability are deterministic checks. Semantic support and
abstention are measured quality gates, never presented as domain certainty.

Locale is deterministically `ru`, `en`, or `mixed` from the question, with an
explicit supported language request taking precedence. Fixed responses use the
same persisted locale policy without an LLM.

### Durable processing

Workers poll and lease the purpose-specific QuestionJob table directly; no queue
outbox is necessary. Minimal states:

```text
queued -> running -> ready -> terminal(outcome)
```

Leases and retries use database time, generation fencing, bounded provider
deadline, and durable attempt identity. Maximum usage is reserved before the
call; a lost outcome is conservatively charged. A stale generation cannot store
an answer or restore scrubbed content.

Safety limits are versioned composition policy backed by a limits ledger with
benchmark/model/tokenizer/pricing source, owner, rationale, and review date. The
initial slice keeps question/prompt/output byte limits, requester/guild rate
limits, global worker concurrency, provider call/time/token cap, and expiry. It
does not add a generic quota framework, USD accounting ledger, notice workflow,
or every possible scope cross-product.

For each `GroundingPlan`, the ledger separately pins direct-input tokens,
evidence-block size/count, retrieval top-k, neighbor expansion, exhaustive
extract/reduce calls, total tokens, deadline, and cost. These values are derived
from retained benchmarks on the exact production model rather than copied from
the model's maximum context window.

### Publishing-owned one-attempt effect

Publishing owns an immutable effect separate from summary publication:

```text
reserved -> claimed -> request_started
reserved | claimed -> cancelled | rejected_before_request
request_started -> delivered | outcome_unknown
outcome_unknown -> delivered | absent_unconfirmed
```

The effect stores deterministic identity, exact target/reply, inert mentions,
payload bytes/hash, hidden marker, binding/authorization versions, claim
generation, request-start time, and nullable receipt.

Rules:

1. Reservation repeats only when every immutable byte and field matches.
2. A reclaimed pre-request worker must win the current generation before
   `request_started`; stale generations cannot begin HTTP.
3. `request_started` authorizes exactly one bounded Discord create attempt with
   automatic client retries disabled.
4. After request bytes may have crossed the boundary, no worker is ever allowed
   to create again. Recovery only looks for the exact author/application,
   container, reply target, marker, and payload hash.
5. Missing/incomplete/forbidden history or a deleted message never proves that
   Discord did not create it. The outcome remains fail-closed and never retries.

A paused sender that resumes after reconciliation can still complete its one
authorized request, but no second sender can create. Qualification uses an
independent official test bot to prove an observed remote count of zero or one;
database rows alone are not delivery evidence.

### Retention and source withdrawal

Raw question, principal reference, evidence text, model output, and payload are
scrubbed after terminal settlement or bounded expiry. Logs/traces/metrics never
contain raw text, Discord IDs, meeting IDs, tokens, or provider payloads.

An authorized source withdrawal creates purpose-specific, non-content retraction
intents. Pre-send work cancels; delivered answer messages are deleted or replaced
with approved non-sensitive text; Infinity objects are deleted. Minimal identity
and remote receipts remain until absence/retraction is confirmed. Retraction,
Infinity deletion, and local cleanup continue when admission, generation, search,
or new sends are disabled.

## Phase 2 - Infinity Context shadow synchronization

### SDK gate

Use the official `@infinity-context/sdk` TypeScript package from the Infinity
Context repository. As of the inspected upstream revision `897efd21`, the SDK
exists but is not published to npm. Before production dependency activation:

- package it from an exact reviewed commit with tarball/lockfile integrity and
  provenance, or publish that exact package through the approved registry;
- prove Node 24 ESM/CJS/type consumer import;
- qualify its actual ingest/process/search/delete, pagination, idempotency or
  mutation lookup, abort/deadline, and error behavior against a disposable
  Infinity endpoint;
- fail startup if the required capability/version attestation is absent.

No custom HTTP adapter is a fallback. If deterministic mutation reconciliation or
verified deletion cannot be implemented through the official SDK, shadow
activation stays blocked and Local Final Reply remains fully operational.

### Derived data topology

Index only accepted final turns whose actors are human in the sealed trusted
roster. Never index summaries, live partials, Botik/automation turns, questions,
answers, suggestions, or facts inferred by a model.

Use deterministic opaque topology:

```text
space  = keyed guild identity
scope  = keyed room identity
thread = meeting identity
document/mutation = transcript version + evidence block identity + policy version
```

Infinity content may contain the canonical human turn text needed for retrieval;
identities exposed to the service are opaque. Local state remains authority.
Meeting Knowledge creates deterministic, turn-aligned `EvidenceBlock` values
within a versioned model-token range. A block never changes speaker, timestamp,
or turn identity, and its local mapping retains exact ordered turn IDs and
content hashes. The Infinity adapter maps each block to the SDK's qualified
document/chunk surface; SDK-native chunk text or metadata is never trusted as a
local citation.

The existing transcript-accept transaction writes one purpose-specific
`FinalTranscriptAccepted` sync intent. `HistoricalSyncStore` keeps desired
generation and a small mutation state:

```text
pending -> in_flight -> applied
pending | in_flight -> retry_wait -> in_flight
any nonterminal -> deleting -> deleted
```

Mutation IDs are deterministic. Lost responses reconcile by the SDK's qualified
lookup/read behavior; they never retry with a new identity. If the SDK cannot
prove absence, the record remains unresolved rather than claiming deletion.
Backlog and attempts are bounded, but authorized deletion never becomes an
abandoned terminal dead letter.

Replacement, when a real source-owned replacement use case exists, advances the
local desired generation, indexes the new release, and schedules the old release
for deletion. Both may temporarily exist remotely, but local current-version
validation makes the old one unusable immediately.

Shadow mode has no read traffic. Its gate proves replay, restart, lost response,
out-of-order generations, partial processing, prolonged outage, deletion while
serving flags are off, and verified remote absence where the SDK supports it.

## Phase 3 - Same-room historical retrieval

`searchRoom` sends only the authorized keyed room scope and a bounded query. The
adapter returns opaque candidate references, not trusted snippets or evidence.
Before candidate text reaches the generator, Meeting Knowledge:

1. reauthorizes the requester;
2. rehydrates every candidate from local authoritative state;
3. verifies guild/room, meeting, transcript/version, human actor, retention, and
   current desired generation;
4. rejects stale, deleted, duplicate, missing, cross-room, automation, or unknown
   candidates;
5. deterministically fuses source-qualified current and historical ranks within
   the provider budget, reserving current live-final evidence.

The same grounded-answer contract and validator serve Local Final Reply and
historical memory. Focused retrieval uses hybrid lexical/vector candidates,
bounded query decomposition, deterministic dedupe/neighbor expansion, and a
reranking policy qualified on the frozen corpus. Infinity outage, partial
backlog, or an unqualified response may use a bounded authoritative local
focused scan or abstain; it never sends the complete transcript or uses a
partial/stale remote cache as authority. Historical-only questions honestly
abstain when retrieval is not safe or available. Exhaustive questions route to
`exhaustive_coverage`, never to top-k.

Two-hour admission is initially disabled independently from shorter questions.
It is enabled only for a pinned profile that passes focused positional recall,
low-recall abstention, and exhaustive hierarchical-reduction gates without a
whole-transcript prompt.

## Phase 4 - Grounded voice reuse and voice E2E

Conversation owns a small `GroundedKnowledgeAnswerPort`. Its adapter calls the
published Meeting Knowledge answer use case with the active participant, room,
question, and cancellation signal. Retrieval and generation run inside the
existing active-turn executor. Barge-in, supersession, disconnect, meeting end,
or authorization loss aborts every downstream operation.

V1 buffers and validates the complete grounded answer before TTS. No factual PCM
is sent before citation/authorization validation. The final plain text goes
through the existing `literalSpeech` path; Pipecat, Craig playback, queues, cue
timing, four-second guard, recording-after-send, and self-audio exclusion remain
unchanged. Claim-by-claim attested streaming is deferred.

Retained evidence includes playback provenance (`prepared_asset`, `literal_tts`,
or `model_tts`), asset hash or model/deployment attestation, knowledge/evidence
epoch, and cancellation reason.

### Greeting and farewell regression contract

- First admitted participant join per meeting triggers promptly; reconnect does
  not repeat it.
- Known profile: speak the configured real name and preferred locale. If a
  per-name prepared asset is absent, bounded literal TTS is allowed. If TTS is
  unavailable, immediately fall back to a prepared anonymous greeting.
- Unknown profile: greet without a name using deterministic meeting/default
  locale; never speak a Discord nickname as a real name.
- Farewell uses finalized current and recent turns to classify true meeting-end
  intent versus quote, question, negation, conditional speech, or farewell to one
  person. It fires once per meeting without waiting for a long silence and uses a
  prepared RU/EN cue selected by the detected intent locale.
- Greeting, farewell, acknowledgement, and answer each have explicit priority,
  interruption, reconnect, and meeting-end policy.

Voice qualification includes providerless real gRPC/Pipecat/WebSocket/PCM paths,
barge-in during retrieval/generation/TTS/playback, no late factual PCM, processing
to-ready recording-link behavior, release-pinned trust evidence, and a compressed
deterministic two-hour durability run. Live latency/semantics use separate official
test bots, a private test guild, synthetic audio, and repeated cold/warm evidence.

## Rollout and operations

Separate centrally versioned rollout epochs control:

- local admission;
- model processing;
- Discord new sends;
- Infinity indexing;
- Infinity search;
- grounded voice.

Every worker checks the current epoch at its corresponding durable transition.
A security/quality rollback cancels pre-send effects rather than draining answers.
Reconciliation, retraction, Infinity deletion, and cleanup continue under all
serving kill switches.

Observability is privacy-safe and low-cardinality: state/reason, age, retry,
locale, request bytes/tokens, authorization drift, delivery unknown, deletion
backlog, SDK capability drift, and cleanup lag. Correlation values are opaque and
TTL-bound. Every alert has an owner, threshold, response deadline, and tested
runbook.

## Test and evidence strategy

### Deterministic proof

- domain/application/contract tests for every state transition and invariant;
- disposable PostgreSQL with separate processes/connections for admission,
  lease/reclaim, one provider call, answer reservation/request start,
  reconciliation, scrub, sync mutation, supersession, and deletion fault cuts;
- duplicate Discord events, concurrent workers, restart, stale generation, lost
  provider outcome, and committed-create/lost-response through a controlled
  transport proxy;
- exact-limit/one-over prompt, response, Discord payload, concurrency, and
  backlog tests; adversarial Unicode and malformed response guards;
- realistic bounded two-hour transcripts through production composition with
  restart at every durable boundary. The corpus places answer evidence at the
  start, 10%, 25%, middle, 75%, 90%, and end; adds near-duplicate distractors,
  distant corrections, contradictions, silence/noise artifacts, overlaps,
  RU/EN/mixed speech, and multi-hop questions spanning distant sections;
- comparative two-hour runs for current-only focused retrieval, cross-source
  focused retrieval, and exhaustive coverage. Retain measured token count,
  latency, cost, peak memory, retrieval recall, citation validity, entailment,
  supported-answer recall, and abstention rather than merely proving that the
  request fit the model context;
- Infinity SDK disposable-endpoint E2E:
  index -> restart/replay -> search -> local rehydrate -> supersede -> delete ->
  verified absence, including cross-room and serving-disabled deletion;
- voice providerless E2E with greeting, farewell, question, grounded answer,
  barge-in, reconnect, meeting end, recording link processing/ready, and no late
  audio.

### Semantic proof

Use one frozen human-labelled holdout with answerable and unsupported RU/EN
questions, mixed language, negation, correction, quotation, uncertainty,
contradiction, distant evidence, exhaustive questions, and transcript prompt
injection. Citation identity/eligibility is zero-tolerance deterministic.
Pre-register claim precision, question recall, abstention recall, partial-answer
treatment, zero denominators, sampling configuration, and confidence method.

The holdout includes a fully synthetic two-hour meeting family whose gold
evidence position is stratified across the complete timeline. Retrieval is gated
separately from generation: `recall@k` measures whether every gold evidence block
survived search and local rehydration, while claim precision and answer recall
measure the generator. A green final-answer score cannot hide a retrieval miss,
and a green retrieval score cannot hide unsupported prose.

Start with roughly 100 answerable and 100 unsupported questions balanced across
RU/EN with adversarial examples embedded, then derive the final sample size from
the approved error budget and measured variance. Report per-locale results; do
not claim statistically powered per-category guarantees without enough samples.
An LLM judge may assist but never replaces frozen human labels and adjudication.

### Live evidence

Live qualification is opt-in and separate from deterministic proof. It uses only
official test bots, a private test guild/channel, test identities, synthetic
text/audio, isolated disposable storage, and an independent observer. The
manifest binds exact source revision, image digest, configuration/rollout epochs,
bot applications, fixtures, timestamps, provider attestations, and remote
receipts. No user account, self-bot, public guild, production channel, real user
project, or production transcript is a qualification target.

## Acceptance gates by slice

### Trusted baseline

- capability/seal provenance survives restart and rolling deployment;
- capability-less/legacy/unknown producers remain knowledge-ineligible;
- canonical contract fixtures agree across Craig and Meeting Platform.

### Local Final Reply

- only exact current-final replies are admitted;
- unauthorized or stale work reveals no transcript content;
- bounded focused current evidence reaches one generator call with measured safe
  token headroom independent of transcript length;
- invalid/unsupported claims abstain; global/exhaustive claims abstain until the
  exhaustive path is qualified; every published claim has valid locally
  rehydrated citations;
- restart and concurrency converge; after `request_started` no second create is
  authorized; independent observer sees zero or one matching answer;
- terminal/expired jobs scrub sensitive content; rollback stops new work.

### Infinity memory

- official SDK provenance/capabilities pass;
- deterministic replay has no duplicate derived object;
- no cross-room, stale, deleted, unknown, or automation candidate reaches the
  generator;
- focused retrieval meets its pre-registered gold-evidence recall gate on
  ordinary and two-hour RU/EN/mixed meetings; exhaustive questions never use
  top-k as proof of completeness;
- outage falls back locally; deletion drains with serving disabled;
- local source remains authoritative at every boundary.

### Grounded voice and existing voice behavior

- no factual speech begins before complete answer validation;
- barge-in/disconnect/end prevents late PCM;
- greetings use configured real names or anonymous fallback promptly and once;
- farewells are prompt, localized, once-only, and reject quote/question/negation/
  person-specific negatives;
- deterministic two-hour and private-guild live manifests bind the same release.

### Two-hour answer quality

- every admitted two-hour request fits the measured safe-input budget or routes
  to a qualified retrieval/coverage mode; otherwise it returns an honest bounded
  abstention;
- facts placed in every timeline stratum, distant corrections, contradictions,
  and multi-hop evidence pass the pre-registered retrieval and semantic gates;
- production activation records the exact model/profile/tokenizer, limits,
  corpus revision, repeated-run distribution, and drift threshold. A single
  successful example or context-window size is not acceptance evidence.

Every slice runs `pnpm run check:changed` during work, `pnpm run check:fast`
before handoff, and full `pnpm run check` before PR. Production remains NO-GO for
that slice until its deterministic and required live evidence is retained.

## Implementation order, estimates, and decisions

| Slice | Approximate changed lines | Risk |
| --- | ---: | --- |
| 0. Trusted evidence completion | 350-600 across two repositories | Medium |
| 1. Local Final Reply | 1,350-1,900 | Medium-high |
| 2. Infinity SDK qualification + shadow sync | 550-850 | Medium-high |
| 3. Same-room retrieval + exhaustive coverage | 500-850 | High |
| 4. Grounded voice + remaining voice E2E gaps | 400-700 | Medium-high |

Expected total is approximately 3,150-5,100 changed lines including tests,
migrations, composition, and evidence tooling. The range is deliberately wider
than the previous false-precision estimate because SDK reconciliation and current
Publishing persistence must be proven in code.

Top implementation strategies considered:

1. **Phased modular-monolith vertical slices - selected**

   🎯 9/10  🛡️ 9/10  🧠 7/10

   Approximately 3,150-5,100 lines. Preserves present ownership, adds only real
   capability ports, and allows independent rollback.

2. **Local Reply first, defer Infinity and voice to unrelated plans**

   🎯 7/10  🛡️ 8/10  🧠 4/10

   Approximately 1,550-2,300 lines now. Simpler, but fails the agreed end state
   and invites incompatible retrieval/voice contracts later.

3. **Extract services/aggregates and build a generic memory workflow platform**

   🎯 4/10  🛡️ 6/10  🧠 10/10

   6,000+ lines. It broadens migrations and operational failure modes before a
   single user question is answered.

## Non-goals

- no arbitrary-message Q&A, DMs, `/ask`, multi-message answer, attachment, or
  previous-answer memory in this delivery;
- no cross-room, guild-wide, personal, Suggestions, or Facts search;
- no configured Q&A roles until a Configuration-owned admin slice exists;
- no model-generated evidence, summary-as-authority, or live partial as final
  evidence;
- no generic workflow/outbox/repository/effect abstraction;
- no production rollout or real-user data used as test evidence.
