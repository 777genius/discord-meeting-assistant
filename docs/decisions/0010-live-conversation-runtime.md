---
id: ADR-0010
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0010: Live conversation behind consumer-owned runtime ports

Status: Accepted

Date: 2026-08-04

## Context

The live meeting flow already receives Craig's best-effort speaker Opus packets
and stores finalized Voicetext turns. The first conversational slice must let
any participant address the bot, generate one stateless answer, and play it to
the whole Discord voice channel without coupling Meeting Core to Pipecat,
provider SDKs, or Discord voice internals.

Provider credentials are unavailable in deterministic environments. Waiting for
a cloud TTS key would leave queueing, interruption, streaming, and Discord
playback untested. A fake that bypasses Pipecat would provide equally weak
evidence.

## Decision

Meeting Core owns the live conversation capability and the consumer-owned
`ConversationRuntime` and `VoicePlaybackPort` interfaces. The first slice stays
inside the existing Meeting Core bounded context; it does not create a new
bounded context or durable conversational memory.

Pipecat runs in `apps/pipecat-runtime` as an infrastructure sidecar behind a
versioned bidirectional contract published by
`packages/conversation-runtime-contracts`. Provider-specific LLM and TTS
selection belongs to sidecar composition. Meeting Platform receives only
provider-neutral text, telemetry, and mono 48 kHz PCM events.

Craig remains the Discord Voice Gateway. The existing
`packages/craig-gateway-contracts` boundary publishes versioned playback
commands and acknowledgements. A recording-scoped authenticated channel carries
audio to the Craig process that owns the active Discord voice connection.

The executable behavior has these invariants:

- canonical address aliases are `Botic`, `Botik`, `Ботик`, and `Ботика`;
  a bounded case-insensitive whole-word allowlist maps qualified STT spellings
  to those names without generic fuzzy matching;
- an alias-only segment arms a four-second same-speaker wake latch on transcript
  time, while an ordinary unpunctuated mention does not activate conversation;
- one turn is active and at most one finalized addressed turn waits for up to
  15 seconds;
- the first finalized turn wins admission and a third concurrent turn is busy;
- interruption is protected for four seconds from Craig's first dispatched
  playback packet, not from LLM or TTS startup;
- a neutral pre-generated acknowledgement may start after 1.3 seconds, followed
  at 3.2 seconds by a deliberation phrase only for a deterministically classified
  complex prompt; both are immediately interruptible and never start the
  real-answer protection window;
- a short utterance fully contained by the protection window does not interrupt;
- cancellation stops both Pipecat generation and Craig playback, and stale
  attempt events are ignored;
- admission never waits for provider startup; pending runtime and playback opens
  are abortable, while concrete adapters release their local slot immediately
  on cancellation even if best-effort wire delivery is still pending;
- the system prompt and current addressed utterance are the complete model
  context; memory, RAG, tools, and transcript retrieval are excluded;
- conversation failure never rolls back a finalized transcript or invalidates
  the authoritative Craig recording.

Production conversation text uses the exact Subscription Runtime conversation
purpose on `gpt-5.6-luna` with low reasoning. A persistent app-server worker and
clean-thread prewarm reduce repeated startup while preserving stateless turns.
ElevenLabs multilingual TTS and provider alternatives remain selected only in
composition.

Deterministic CI uses a real Pipecat pipeline with streaming fake LLM and
fixture-backed speech providers. A separate local profile uses Ollama and Piper
HTTP without API keys. Cloud profiles, including ElevenLabs, implement the same
contract and fail closed when their selected secret is absent. Test providers
cannot be selected in production composition.

Foundation classifies every new TypeScript source boundary fail-closed. Because
Foundation 0.6.0 does not discover Python source, the Pipecat sidecar additionally
uses frozen Python dependencies, Ruff, Pyright, Pytest, import-boundary checks,
and a no-suppression policy.

## Consequences

- Meeting Core can add conversation policy without importing Pipecat, gRPC,
  Craig, Discord, or provider types.
- A TTS or LLM provider can be added by sidecar composition and qualification
  tests without changing queue or interruption behavior.
- Cross-process audio is bounded and more verbose than an in-process pipeline,
  but it preserves ownership and lets every hop be tested independently.
- The Craig fork receives a small playback adapter while its recording path
  remains authoritative and fault-isolated.
- Real provider quality still requires an opt-in private-guild canary, while all
  orchestration and playback behavior remains testable without a provider key.
