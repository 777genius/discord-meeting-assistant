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
- Process at most two speaker tracks concurrently. Bound each artifact, the total
  in-flight artifact budget, provider response size, polling attempts, elapsed
  time, and transcript size.
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
- Meeting Platform temporarily holds only bounded complete Ogg artifacts. The
  default cap is 64 MiB per speaker, configurable up to the audited hard limit;
  oversized meetings fail explicitly without weakening the original recording.
- A failed speaker cancels queued sibling work. Already accepted provider jobs
  remain recoverable by their stable idempotency keys.
- The browser and Voicetext frontend are not part of this path. Audio,
  credentials, and provider control remain server-side.
- Changing provider, model, authentication, evidence mapping, or the batch
  contract requires retained-audio qualification and an explicit ADR revision.
