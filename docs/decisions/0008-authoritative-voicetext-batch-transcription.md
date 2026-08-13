---
id: ADR-0008
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0008: Authoritative Voicetext batch transcription

## Status

Accepted on 2026-08-02. This decision supersedes only the final-transcription
transport selected by ADR-0006. Its machine-identity, credential-custody,
provider-qualification, and evidence rules remain in force.

## Context

ADR-0006 sent complete Craig speaker tracks through a real-time-paced streaming
session. That preserved the provider contract, but made a one-hour recording take
about one hour to upload before final summary generation could begin. The derived
live path now already supplies captions and preliminary summaries during the call.
The authoritative post-call path therefore needs throughput and deterministic
recovery rather than streaming latency.

Voicetext already owns the Deepgram credential and the dedicated
`meeting-platform` machine identity. Meeting Platform must continue to receive
neither the raw provider key nor a provider-specific core contract.

## Decision

- Keep `FinalTranscriptionPort` as the Meeting Core boundary. Select the batch
  implementation only in Meeting Platform composition.
- Send each checksummed, complete Craig Ogg speaker artifact to Voicetext batch-v2
  over authenticated HTTPS. Do not decode, resample, or pace the final upload in
  real time.
- Use Deepgram Nova-3 multilingual recognition with the retained meeting
  vocabulary. Voicetext remains the only component that holds the Deepgram key.
- Derive one stable lowercase SHA-256 idempotency key per meeting recording and
  speaker. A retry either polls the existing job or re-submits the exact artifact
  with the same key; an identity conflict fails closed.
- Admit no more than ten speaker tracks for one final transcript. Validate the
  worst-case logical capacity before provider work as `track limit x
  per-track byte limit`; the production limit is `11 x 64 MiB = 704 MiB`:
  up to ten human speaker tracks plus one authoritative Botik playback track.
  This accepts ten one-hour tracks without pre-reading them all.
- Use a configuration-selected bounded read-and-provider worker pool per
  meeting. Production uses six workers: each reads an Ogg immediately before a
  submit, releases the bytes before polling, and re-reads only for an explicit
  provider re-submit after verifying the same SHA-256 body. The pipeline does
  not retain all ten artifacts.
- Use process-local FIFO admission around the Voicetext final-transcription
  port. The production 2 GiB container admits one meeting at a time. The
  configuration permits at most two only after separately sizing a larger host;
  summary generation and publication are not directly gated. A job waiting for
  admission still occupies one BullMQ worker slot; isolating that queue would
  require a separate stage-job design.
- Preserve each Craig speaker ID and timeline offset when provider utterances are
  mapped into authoritative transcript turns. A partial speaker result is never
  published as a complete final transcript.
- Keep derived live streaming independent. Live partials may update the mutable
  Discord projection, but only the successful batch transcript becomes final
  evidence.
- Voicetext owns machine authorization, quota admission and idempotent charging,
  upload admission, provider concurrency, fenced leases, bounded retries, and
  provider-status classification. Unknown outcomes are reconciled under the same
  job identity rather than retried as new paid calls.

## Consequences

- Final transcription is no longer coupled to call duration. The operational
  target for a normal one-hour meeting is a 30-90 second post-call transcript,
  followed by final LLM generation; real E2E measurements remain the release
  gate.
- Meeting Platform hard-limits a final meeting to ten 64 MiB tracks and validates
  704 MiB logical recording capacity. With six workers, no more than 384 MiB of
  complete Ogg caller buffers are live for one admitted meeting; the Fetch
  client can temporarily create up to another 384 MiB of Blob upload copies.
  The resulting 768 MiB is a payload budget, not a process-RSS guarantee:
  runtime, HTTP, and GC overhead still require headroom. The current 2 GiB
  deployment therefore keeps final-meeting admission at one. Oversized meetings
  fail explicitly without weakening the original recording.
- Admission is process-local. Adding Meeting Platform replicas or raising it to
  two requires explicit host-level capacity planning and a disposable canary;
  it does not create a distributed quota.
- A failed speaker cancels queued sibling work. Already accepted provider jobs
  remain recoverable by their stable idempotency keys.
- The browser and Voicetext frontend are not part of this path. Audio,
  credentials, and provider control remain server-side.
- Changing provider, model, authentication, evidence mapping, or the batch
  contract requires retained-audio qualification and an explicit ADR revision.
