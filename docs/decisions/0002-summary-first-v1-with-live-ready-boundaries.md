---
id: ADR-0002
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0002: Summary-first V1 with live-ready boundaries

Status: Accepted

Partially superseded by ADR-0007 for derived live transcription, summary, and
captions. The exclusion of conversational Pipecat/TTS remains in force.

Date: 2026-08-02

## Context

The product eventually needs live questions and spoken answers, but reliable
post-call evidence is the first user value and the foundation for future context.
Implementing realtime STT, Pipecat, TTS, and interruptions now would expand the
failure surface before transcript and summary correctness are proven.

## Decision

V1 implements recording ingestion, final post-call transcription, structured
evidence-backed summary, and idempotent Discord publication end to end.

Design domain and application code around consumer-owned ports so a future
Conversation Runtime, Answer Generator, knowledge sources, and playback adapters
can be added without changing core invariants. Do not materialize those adapters
or empty packages until their first use case.

## Consequences

- E2E effort concentrates on the highest-value and most recoverable workflow.
- Final transcript remains authoritative over any later live transcript.
- Live conversation can be added through adapters without making Pipecat a source
  of meeting truth.
- Some future contracts remain intentionally undecided until executable spikes.
