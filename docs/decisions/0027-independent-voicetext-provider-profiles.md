---
id: ADR-0027
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0027: Independent VoiceText batch and live provider profiles

## Status

Accepted on 2026-08-17. This decision extends ADR-0006, ADR-0008, and
ADR-0023 without superseding their credential-custody, authoritative-evidence,
or backward-compatibility rules.

## Context

VoiceText can mediate both Deepgram and ElevenLabs speech recognition. Batch
and live recognition have different operational and evidence roles, so one
provider switch would couple an authoritative post-call migration to the
derived live projection. That would prevent independent qualification and make
rollback ambiguous.

The existing Deepgram batch contract, idempotency salt, and stored transcript
identities are already deployed. They must remain byte-for-byte compatible.
ElevenLabs batch responses use a new contract whose provider identity must be
authenticated by content, not inferred from the selected request.

## Decision

- Composition selects batch and live profiles independently. Batch permits
  `deepgram-nova-3` or `elevenlabs-scribe-v2`; live permits
  `deepgram-nova-3` or `elevenlabs-scribe-v2-realtime`. Both default to
  Deepgram and reject every other value during startup.
- The Deepgram batch profile retains contract v2, the exact multipart request,
  and the legacy `voicetext-batch-v2` idempotency salt and digest. The
  ElevenLabs batch profile uses contract v3 with provider `elevenlabs`, model
  `scribe_v2`, and language `multi`.
- Every v3 pending, failed, and completed response must repeat the exact
  contract version, provider, model, language, and job identity. A completed
  response must additionally bind `result_id` to that job and contain bounded
  millisecond duration and segments. Missing or mismatched identity fails
  closed; there is no provider fallback.
- Live configuration remains protocol v2 and sends Discord's raw mono 48 kHz
  Opus packets unchanged. Deepgram identifies as `deepgram` / `nova-3` and
  ElevenLabs as `elevenlabs` / `scribe_v2_realtime`. The exact provider and
  model are mandatory in `ready` before session activation or audio egress.
- Provider, model, upstream endpoints, probes, and credentials remain inside
  VoiceText adapters and composition. Discord, Meeting Core, summary, memory,
  and RAG boundaries receive none of them.
- Provider and model are fixed for each submitted job and opened live session.
  Existing bounded concurrency, backpressure, polling, and cancellation rules
  remain unchanged.
- Before a post-call item reaches Redis, Meeting Platform immutably pins its
  composition-owned batch execution binding in the PostgreSQL outbox. New work
  uses the currently selected batch profile. Recoverable rows that predate this
  ledger field are backfilled at startup to the frozen
  `voicetext-batch-v2:deepgram-nova-3` binding and never inherit a new
  environment selection.
- The one-time legacy backfill follows the already deployed top-level
  transcription backend: `speaches-v1` for a Speaches deployment and frozen
  Deepgram v2 for a VoiceText deployment. Operators must not combine that
  migration with a top-level backend change; ambiguous historical rows require
  explicit reconciliation instead of inference.
- Final transcription resolves the durable binding by meeting identity and
  routes through one shared in-process admission boundary to independently
  constructed Deepgram v2 and ElevenLabs v3 delegates. Missing or unknown
  bindings fail closed before provider access. Redis loss, restart recovery,
  and configuration rollback cannot change a meeting's selected delegate.
- If a rollback runtime reads a binding it does not support, it retains the
  durable outbox item before Redis enqueue. A newer binding is never rewritten,
  dead-lettered by an older binary, or silently sent to another provider.
- Craig's original Ogg multitrack recording and per-speaker identities remain
  authoritative. Only the successful final batch transcript feeds final
  summaries, memory, or RAG; live text remains a derived projection and cannot
  replace final evidence.

## Consequences

- Batch and live providers can be qualified, deployed, and rolled back
  independently, including mixed-provider deployments.
- Existing Deepgram jobs and retries retain their exact request fingerprint and
  idempotency identity.
- A deployment may select ElevenLabs for new meetings while recovered legacy
  meetings continue using their pinned Deepgram v2 execution contract.
- A malformed or cross-provider response stops that transcription path without
  deleting the recording or weakening authoritative final semantics.
- Discord continues to interact only with Meeting Platform and Craig; it never
  receives upstream provider material.
