# Architecture overview

## Product shape

The product starts as a modular monolith with separate worker processes where
post-call workloads require isolation. It follows Clean Architecture, Hexagonal
Architecture, SOLID, and strategic and tactical DDD only where real business
invariants justify it.

Craig remains a separate Voice Gateway behind an anti-corruption boundary. The
gateway owns Discord voice transport and the authoritative multitrack recording.
Meeting Core owns business state and post-call processing.

```text
Craig Voice Gateway
  -> best-effort live packet tee (derived, never final evidence)
  -> authenticated conversation playback (derived, cancellable)
  -> Botik playback packets appended to an authoritative track only after send
  -> checksummed speaker artifacts cooked from the authoritative original
  -> versioned lifecycle and authoritative-ready evidence
  -> Meeting Core
       -> Transcription
       -> Meeting Intelligence
       -> Discord Publishing
```

The server also consumes Craig's best-effort Opus packet tee for a derived live
projection. The browser is not part of this path: audio, Voicetext credentials,
and subscription-runtime authentication remain server-side. Discord receives
only rendered summary and caption embeds.

Craig is the first recording-source adapter, not application vocabulary. The
application identifies a source by opaque scope and room IDs and accepts a
canonical mono Opus 48 kHz live stream. A future Zoom or Google Meet adapter
normalizes its identity and audio at the same boundary; it does not add provider
branches to Meeting Core or the live runtime.

## Meeting Platform process boundaries

Meeting Platform is assembled only in `composition`. Its application boundary
owns provider-neutral recording commands and use-case ports. The concrete Craig
ACL validates wire DTOs and maps them at `adapters/inbound/craig`; Fastify is an
outer `http` adapter behind the small `PlatformHttpHost` lifecycle contract.
Operations and Discord installation routes have separate source boundaries, and
the derived `live-runtime` imports only Meeting Core and consumer-owned ports.

The stateful recording/live process is intentionally singleton. Stateless HTTP
surfaces may be deployed separately, but the live owner cannot gain replicas
until record-ID routing, durable leases with fencing, distributed projection
locks, and takeover tests exist.

## Initial semantic ownership

The first slice recognizes four focused ownership areas without requiring four
deployments:

- Meeting Lifecycle owns meeting identity, participants, recording association,
  processing stage, and transition invariants.
- Transcription owns final transcript versions, speaker-attributed turns, timing,
  overlap preservation, and provider-independent transcription jobs.
- Meeting Intelligence owns evidence-backed summary, decisions, action items,
  open questions, and generation versioning.
- Publishing owns idempotent projection of an accepted summary into a Discord
  container. New meetings use direct results-channel messages; thread mode is
  explicit opt-in. The live draft and authoritative final summary have distinct
  stable identities by default, while replacing the live draft remains an
  explicit compatibility mode. Publishing stores honest versioned references.
- Recording Playback owns possession-based access to the authoritative private
  speaker tracks. Its public page presents one synchronized player, while
  byte-range delivery and access tokens remain outside Meeting Core.
- Guild Installation & Configuration owns the administrator-approved mapping
  from one Discord guild and voice channel to its results channel. Discord
  commands and PostgreSQL remain adapters around this context.

These names guide the first model. A separate workspace package is created only
when a real slice and ownership boundary exist. Deployment separation is not a
DDD requirement.

## Meeting Core feature modules

Meeting Core is one bounded-context package with eight enforced feature
modules:

```text
packages/meeting-core/src/features/
  recording/
  transcription/
  meeting-intelligence/
  publishing/
  meeting-lifecycle/
  post-call-workflow/
  live-meeting/
  conversation/
```

Each module exposes one curated entrypoint and creates only the domain,
application, and port directories it actually needs. External consumers use an
explicit package subpath. Foundation denies undeclared feature dependencies and
cross-feature deep imports, so the physical layout and executable dependency
model describe the same architecture.

## Live conversation vertical slice

The executable live slice includes derived live STT, addressed conversation,
incremental summary, and one mutable Discord projection, followed by
an authoritative post-call summary in a separate idempotent projection by
default. Conversation remains stateless and excludes memory, RAG, and tools.

Live conversation connects through narrow ports owned by Meeting Core:

- `ConversationRuntime` for conversational execution;
- `VoicePlaybackPort` for cancellable provider-neutral PCM playback.

Text generation is a separate consumer-owned Pipecat port implemented by the
Subscription Runtime adapter. Production uses a purpose-scoped warm
`gpt-5.6-luna` app-server worker with stateless clean threads. Multilingual TTS
is selected in Pipecat composition and can be replaced without changing Meeting
Core.

The conversation path streams validated answer deltas into complete speech
phrases. One meeting-scoped Pipecat pipeline and ElevenLabs WebSocket stay warm
across sequential turns; interruption resets only the active TTS context.
Terminal structured-output attestation still validates the provisional stream,
and summary generation remains on its unary runtime contract.

After 1.3 seconds of model latency, Meeting Core may play one pre-generated
neutral acknowledgement. A deterministic prompt policy may schedule a later
locale-aware deliberation cue for a complex request; simple requests never use
deliberation phrases. Cue playback is immediately interruptible and does not
start the four-second answer guard. Craig records cue and answer frames only
after their direct Discord send succeeds; self audio never enters live STT.

Pipecat and provider factories remain behind the runtime port. Craig remains the
only owner of the Discord voice connection. The deterministic E2E profile
replaces only external LLM/TTS calls; it still exercises Pipecat, gRPC, WebSocket,
PCM-to-Opus playback, cancellation, and bounded queues.

## Reliability invariants

- Original recording success is independent from every AI path.
- Final transcription starts only from artifacts derived from Craig's original
  recording; packet-tee gaps cannot be accepted as complete evidence.
- Meeting persistence and post-call scheduling share one PostgreSQL transaction;
  a durable outbox reconciles crashes before BullMQ acknowledgement.
- Async work uses bounded admission and stable idempotency identities.
- Finalized live turns, summary coverage, usage, and telemetry are append-only
  ledgers; the compact live-meeting row retains only CAS lifecycle/projection
  state and never grows by rewriting full history arrays.
- Unknown external outcomes are reconciled rather than retried with a new ID.
- A later stage never destroys an earlier authoritative artifact.
- Final transcript replaces live evidence only through explicit versioning and
  becomes the timeline retained beside the final Discord summary.
- Published summaries contain no decision or action item without valid evidence
  turn references.
