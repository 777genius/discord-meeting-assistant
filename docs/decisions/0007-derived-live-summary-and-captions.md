# ADR-0007: Derived live summary and captions

## Status

Accepted on 2026-08-02.

## Context

Users need visible progress during a call without weakening Craig's original
recording or the final evidence-backed summary. Raw Discord Opus, Voicetext
authentication, and subscription authentication must remain server-side.

## Decision

- Tee each durably journaled Craig Opus packet into a bounded per-speaker
  Voicetext Deepgram session. Live failure never fails recording ingress.
- Admit only finalized live transcript turns into Meeting Core. Mutable partials
  are rendered as captions and never become summary evidence.
- Publish one Discord thread/message on the first non-empty caption. Evaluate
  updates every five seconds, but edit only when captions or summary state
  changed. The message contains a preliminary summary and a separate bounded
  `Сейчас говорят` embed with speaker mentions and timings.
- Generate the first summary at five minutes. Later generations have a 90-second
  minimum interval, run after roughly 300 new scheduling tokens, or are forced
  after three minutes of new finalized speech.
- Send the previous structured summary, only new finalized turns, and up to
  three minutes of recent finalized context to the incremental generator. The
  provider returns a complete next snapshot rather than an ambiguous patch.
- Admit exactly `gpt-5.6-luna` with medium reasoning for the incremental purpose.
  Keep the final `gpt-5.6-sol` xhigh profile unchanged and independently
  attested.
- Persist real provider token telemetry when available. API-equivalent cost is
  derived from a versioned price card and is never represented as an actual
  subscription invoice.
- Use one canonical Discord projection identity based only on meeting and target
  channel. Operation idempotency remains separate. Craig acknowledgement never
  waits for live LLM or Discord work; instead, the authoritative publication is
  fenced immediately before its final Discord edit until live finalization has
  drained, so the authoritative projection always wins.

## Consequences

- A live outage can cause gaps or a placeholder, but cannot corrupt the
  authoritative Craig artifacts. The final pipeline repairs the visible result.
- One hour of audio no longer waits for an hour-scale transcription pass before
  showing useful text; STT work runs alongside the call.
- Per-speaker provider sessions consume bounded concurrency. Over-capacity live
  packets are dropped with telemetry while authoritative recording continues.
- The frontend code from VoicetextAI is not imported into V1 because Discord is
  the presentation surface. Provider-agnostic backend protocol behavior is
  reused through the existing Voicetext service boundary.
