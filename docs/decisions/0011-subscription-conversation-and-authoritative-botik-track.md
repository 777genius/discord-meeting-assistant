---
id: ADR-0011
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0011: Subscription conversation and authoritative Botik playback

Status: Accepted

Date: 2026-08-04

## Context

Live conversation needs a fast subscription-backed text model, multilingual
speech, honest cancellation, and final evidence of what Discord participants
actually heard. Reusing the incremental-summary purpose would mix two policies
and schemas. Starting a fresh Codex CLI for every utterance would also add
avoidable process and authentication latency.

Thinking acknowledgements improve perceived latency, but they must not receive
the four-second interruption protection intended for a real answer. Recording
Pipecat PCM or a queued player buffer would be incorrect because cancellation
can discard audio that never reached Discord.

## Decision

Subscription Runtime admits a third exact profile:

- purpose `discord_meeting.conversation.answer`;
- policy `meeting-conversation.subscription-runtime.v1`;
- model `gpt-5.6-luna`, low reasoning, and a 512-token post-execution budget;
- structured schema `discord_meeting_conversation_answer_v1` containing one
  non-empty answer of at most 2,000 characters;
- one stateless turn, disabled tools, read-only sandbox, and no memory.

The sidecar keeps one purpose-scoped `FileBackendCodexWorker` alive. It uses the
runtime's app-server pool and clean-thread prewarm, prepares the conversation
worker before accepting traffic, and relies on the runtime's packaged-exec
fallback. A clean thread is consumed by only one request; provider process and
auth state are warm, but conversational history is never reused. Health and
result attestations identify the selected app-server engine; the packaged CLI
runner has a distinct engine identity.

Pipecat consumes this capability through its own text-generation port and a
gRPC anti-corruption adapter. TTS remains profile-selected. The ElevenLabs
profile uses the configured voice with an exact model allowlist:
`eleven_flash_v2_5` is the low-latency default and `eleven_multilingual_v2` is
the quality-first alternative. Explicit locales map through Pipecat's language
registry, while `auto` leaves language detection to the selected multilingual
model. Cue locale is resolved separately from answer locale, so a Russian
request for an English answer can use a natural Russian thinking cue without
forcing Russian pronunciation on the generated answer.

Meeting Core can schedule a neutral pre-generated acknowledgement after 1.3
seconds. A second cue is eligible after 3.2 seconds only when a deterministic
prompt policy classifies the request as requiring deliberation. Small talk and
simple factual questions therefore never receive phrases such as `дай подумать`
or `interesting question`. RU and EN phrases come from a validated PCM registry
recorded with the selected female voice; the manifest must match both runtime
profile ID and exact provider voice ID. Other locales use a neutral non-verbal
fallback for the first stage and omit the language-specific second stage.
Selection is derived from stable meeting, turn, stage, and language-group
identity, so replay chooses the same cue and playback attempt after a process
restart without persisted mutable state. Every cue is a separate playback
attempt, can be interrupted immediately, and never starts the answer guard.
Real answer playback cancels all pending/current cues and starts the four-second
guard only after Craig confirms its first actual Discord send.

Address recognition uses a bounded explicit alias allowlist rather than fuzzy
matching. Canonical RU/EN names and qualified STT spellings map to one canonical
identity. An alias-only finalized segment arms a four-second, speaker-scoped
wake latch on transcript time; the following segment is accepted only when that
same speaker started it inside the latch. Ordinary unpunctuated mentions in the
middle of a sentence do not activate conversation. The latch preserves a
stateless model turn: it joins STT segmentation, not conversational history.

Craig sends conversation Opus through an owned 20 ms sender. Only a frame
accepted by the Discord voice connection is appended to Botik's authoritative
track. Queued or cancelled frames are never recorded. The track uses Craig's
real bot snowflake and is excluded from recovered human `participantIds`, but
is retained in the authoritative recording and final transcription. Final
capacity is eleven tracks: ten human speakers plus Botik. The final summary can
therefore use Botik's transcribed speech; the best-effort live packet tee still
excludes outbound bot audio to prevent self-transcription loops.

## Consequences

- Conversation requests cannot drift into summary policy or inherit summary
  history.
- Warm app-server slots remove repeated CLI startup, while model and TTS latency
  remain measurable and are not hidden by the cue.
- Provider replacement stays in composition; Meeting Core imports no Pipecat,
  Subscription Runtime, ElevenLabs, or Discord types.
- The authoritative transcript reflects audio actually sent to Discord,
  including answers and cues, without treating Botik as a human participant.
- Interim live summaries may omit Botik speech; authoritative post-call
  transcription and summary replace that derived projection.
