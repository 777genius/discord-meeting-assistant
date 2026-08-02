# ADR 0006: Voicetext-authenticated Deepgram transcription

- Status: Accepted
- Date: 2026-08-02

## Context

The summary-first V1 needs faithful Russian transcription while preserving English
engineering terms. Retained Discord E2E audio exposed semantically dangerous errors
from the CPU Whisper deployment: a 2026 deadline became 2021 and `Redis queue`
became `Redis UI`. Medium, large-v3-turbo, and large-v3 did not provide one model
that passed the strict two-speaker fixture. Prompt-based rewriting also repeated the
prompt and dropped speech, so neither test weakening nor transcript correction is
acceptable.

Voicetext already owns provider credentials and exposes an authenticated protocol-v2
streaming boundary. Meeting Platform must not receive a raw Deepgram API key.

## Decision

Production final transcription uses a dedicated Voicetext machine identity through
the `FinalTranscriptionPort`. Each authoritative Craig Ogg speaker track is decoded
and resampled to mono 16 kHz signed PCM by a bounded adapter process, then streamed
to one protocol-v2 Deepgram session. Only immutable provider-final segments are
retained: `final` messages and protocol-v2 `partial` messages explicitly marked
`is_segment_final=true`; mutable partials never enter the domain transcript. The
adapter deduplicates finalized ranges, requires `ready` before audio, sends
`finalize`, requires `finalize_complete`, and adds the Craig speaker timeline offset
to provider timestamps.

The opaque Voicetext bearer is read from a regular root-managed secret file. It is
never accepted through an API-key environment variable, logged, persisted in the
database, or exposed to the Discord projection. Provider, decoder, protocol, byte,
track, timeout, and concurrency limits are explicit and fail closed.

Speaches remains an explicit local/development provider selected at composition
time. V1 does not silently fail over between providers because that would make the
same idempotency identity produce provider-dependent evidence.

## Consequences

- Deepgram credential rotation remains inside Voicetext; Meeting Platform rotates
  only its revocable machine bearer.
- Stored Ogg is decoded into bounded per-speaker PCM and is never persisted as a
  second artifact. V1 materializes one speaker's PCM in memory, processes speaker
  tracks sequentially, and releases each track before advancing.
- Long meetings remain bounded by explicit per-speaker and whole-job byte limits.
  Client pacing is real time. Voicetext acknowledgements prove ingress, not that
  Deepgram has finalized every late utterance; faster post-call upload can race
  provider finalization and silently truncate an otherwise successful result.
  Replacing the bounded whole-track decoder with a pipe is a later optimization,
  not a different domain contract.
- A live Pipecat assistant can later consume the same streaming provider boundary,
  while V1 continues to process finalized Craig recordings.
- Provider changes require retained real-audio qualification and a new ADR or
  explicit revision of this one; transcript text is never patched to satisfy E2E.
