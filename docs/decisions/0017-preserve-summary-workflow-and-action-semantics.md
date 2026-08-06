---
id: ADR-0017
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0017: Preserve summary workflow and action semantics

## Status

Accepted on 2026-08-06.

## Context

Compact final summaries can accidentally merge distinct commitments that share
an owner and deadline. They can also reduce a named multi-step technical flow to
one stage, even when the omitted components materially explain the work.

## Decision

- Final summary policy v10 and incremental policy v5 write in the dominant
  transcript language unless an explicit override is supplied. English is
  selected from dominant Latin script. Russian and Ukrainian are distinguished
  by exclusive letters and bounded lexical markers; ambiguous Cyrillic or
  other-language transcripts use the transcript's dominant natural language.
- Final summary policy v10 merges only true semantic duplicates. A matching
  owner and deadline are not sufficient to merge actions.
- A merged action retains each distinct deliverable, result destination or
  reporting channel, acceptance condition, and exact technical term supported
  by its evidence.
- A topic covering a named multi-step technical workflow retains its material
  components and their relationship or order in the topic points.
- The summary v4 boundary schema and evidence requirements remain unchanged.

## Consequences

- Compact summaries preserve operational details without introducing a wider
  provider contract or a fixture-specific semantic validator.
- Policy v10 produces a new deterministic request identity, so previous v9
  results cannot be reused after the behavior change.
