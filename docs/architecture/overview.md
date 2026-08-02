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
  -> checksummed speaker artifacts cooked from the authoritative original
  -> versioned lifecycle and authoritative-ready evidence
  -> Meeting Core
       -> Transcription
       -> Meeting Intelligence
       -> Discord Publishing
```

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
  thread and stores the resulting external references.

These names guide the first model. A separate workspace package is created only
when a real slice and ownership boundary exist. Deployment separation is not a
DDD requirement.

## V1 and future live conversation

V1 ends after reliable Discord publication. It excludes live STT, Pipecat, TTS,
wake phrase detection, and RAG.

Future live conversation connects through narrow ports owned by Meeting Core:

- `ConversationRuntime` for conversational execution;
- `KnowledgeSource` for contextual retrieval;
- `AnswerGenerator` for product-controlled answer generation;
- playback and realtime transcript adapters at the Discord boundary.

The future ports do not authorize empty packages today. They will be introduced
with the first executable use case and deterministic fake.

## Reliability invariants

- Original recording success is independent from every AI path.
- Final transcription starts only from artifacts derived from Craig's original
  recording; packet-tee gaps cannot be accepted as complete evidence.
- Meeting persistence and post-call scheduling share one PostgreSQL transaction;
  a durable outbox reconciles crashes before BullMQ acknowledgement.
- Async work uses bounded admission and stable idempotency identities.
- Unknown external outcomes are reconciled rather than retried with a new ID.
- A later stage never destroys an earlier authoritative artifact.
- Final transcript replaces live evidence only through explicit versioning.
- Published summaries contain no decision or action item without valid evidence
  turn references.
