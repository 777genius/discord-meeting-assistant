---
id: ADR-0022
status: superseded
supersedes: []
superseded_by: [ADR-0023]
---

# ADR-0022: Provider-neutral readable transcript segments

## Status

Accepted on 2026-08-07. This decision extends ADR-0008 without changing its
authoritative recording, raw-turn evidence, credential-custody, or failure rules.

## Context

Deepgram batch utterances are authoritative evidence, but their speech-boundary
shape can split one readable sentence into several short Discord timeline rows.
Increasing the global utterance timeout would also merge independent human
turns. Meeting Core must not learn Deepgram paragraphs, sentence JSON, or any
other provider response type merely to improve final display readability.

## Decision

- Introduce Voicetext batch contract v3 while retaining exact batch-v2 request
  and response behavior for rollback compatibility. Version 3 additionally asks
  the selected provider for sentence metadata.
- Voicetext normalizes usable sentence metadata into bounded
  `readable_segments` containing text, timing, and source utterance indices.
  Missing, malformed, incomplete, or inconsistent metadata produces an empty
  list and never invalidates otherwise valid raw utterances.
- The Voicetext adapter maps source utterance indices to stable raw turn IDs and
  emits the provider-neutral `TranscriptReadableSegmentSnapshot`. Contract-v3
  jobs and generated IDs use a v3 identity namespace; generated transcript
  snapshots use version 2.
- Meeting Core persists readable segments with the final transcript as derived
  structure. Every segment must reference existing unique raw turns from the
  same speaker and remain inside their time envelope. Legacy snapshots and
  providers without the capability normalize to an empty list.
- Raw transcript turns remain authoritative. Summary evidence and the complete
  transcript attachment always use raw turns. Only the compact final Discord
  timeline may prefer non-empty readable segments; otherwise it renders raw
  turns exactly as before. Live captions are unchanged.
- A future transcription provider may emit the same neutral contract or omit
  it. Provider identity, paragraphs, source utterance indices, and provider JSON
  cannot enter Meeting Core or Discord application contracts.

## Consequences

- Final Discord timelines become sentence-readable without weakening evidence
  traceability or changing live turn detection.
- Readability metadata is optional and atomically discardable, so provider drift
  cannot block final transcription, summary generation, or publication.
- Batch-v3 rollout requires coordinated Voicetext backend and Meeting Platform
  deployment. Immutable prior images retain the batch-v2 rollback path.
