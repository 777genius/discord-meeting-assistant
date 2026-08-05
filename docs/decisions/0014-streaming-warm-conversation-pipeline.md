---
id: ADR-0014
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0014: Streaming warm conversation pipeline

Status: Accepted

Date: 2026-08-05

## Context

ADR-0011 keeps Subscription Runtime's conversation worker warm, but waiting for
the complete structured response before starting TTS still serializes model and
speech latency. Recreating Pipecat and the ElevenLabs WebSocket for every turn
adds avoidable setup. Any optimization must preserve stateless model turns,
terminal attestation, Meeting Core's queue and four-second answer guard, and
Craig's authoritative evidence of audio actually sent to Discord.

## Decision

Subscription Runtime exposes a separate authenticated server-streaming RPC for
`discord_meeting.conversation.answer`. The existing unary RPC remains the only
path for final and incremental summaries. The warm worker emits bounded,
redacted structured-output deltas through a provider-neutral callback. Pipecat
incrementally decodes only the exact `answer` JSON string and groups deltas into
complete speech phrases rather than forwarding token stutter. A provider-neutral
text-capture frame is inserted before TTS so services that consume `LLMTextFrame`
cannot remove public text events or output-token telemetry.

The final result and execution attestation remain authoritative. Invalid event
ordering, malformed provisional JSON, or disagreement between provisional text
and the terminal answer fails closed. Speech already sent to Discord before a
terminal mismatch remains part of Craig's authoritative recording; the failure
cannot rewrite that evidence.

Pipecat retains a bounded pipeline for each meeting, voice profile, and locale.
Sequential turns reuse both the PipelineWorker and ElevenLabs WebSocket. A
barge-in sends Pipecat interruption through only the active TTS context. Process
shutdown, bounded idle eviction, and fatal pipeline failure close the worker.
The runtime also rejects concurrent attempts for the same meeting even when
their locales differ, leaving Meeting Core's short queue as the overlap policy.
The gRPC adapter withholds a terminal cancellation event until the active
pipeline has released its meeting admission. Meeting Core therefore cannot
start the queued turn against a backend that still reports the meeting busy.

Instrumented turns publish exact additive durations for end-of-turn to wake
detection, wake to first LLM delta, first delta to first synthesized PCM, and
the total to first PCM. Telemetry cannot affect admission, playback,
transcription, or summary evidence.

## Consequences

- Model generation and TTS overlap after the first complete phrase.
- Normal turns and interruption avoid repeated provider connection setup.
- Provider deltas remain provisional and cannot bypass final attestation.
- Conversation history is still not reused; only process, auth, and provider
  connection state remain warm.
- Craig recording, final transcription, and final summary authority are
  unchanged.
