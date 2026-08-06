---
id: ADR-0016
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0016: Separate final publication and evidence-oriented summaries

## Status

Accepted on 2026-08-06.

## Context

The mutable live projection is useful during a call, but replacing it makes the
authoritative result easy to miss. Compact summaries also need to retain material
acceptance details and enough quoted context without turning Discord into a full
transcript duplicate.

## Decision

- `DISCORD_FINAL_PUBLICATION_MODE=separate-message` is the default. The live draft
  and final summary use distinct stable projection identities, so retries reuse the
  same final message without editing or duplicating the live draft.
- `DISCORD_FINAL_PUBLICATION_MODE=replace-live` preserves the previous behavior.
  It is independent of `DISCORD_PUBLICATION_MODE=message|thread`, which continues
  to select the Discord container type.
- The live finalization fence remains mandatory before either final-publication
  behavior.
- Final summary policy v9 and incremental policy v5 write in the dominant
  transcript language unless an explicit override is supplied. Russian and
  English are selected deterministically for their dominant scripts; ambiguous
  or other-language transcripts instruct the model to infer their dominant
  natural language.
- The existing v4 summary schema remains stable. Material parameters,
  compatibility behavior, privacy constraints, identifiers, limits, and
  acceptance conditions are selected into compact topic points rather than a
  second overlapping list.
- A context-dependent reply should cite both its proposal/question and reply.
  Discord rendering provides a bounded fallback by displaying a nearby preceding
  turn when the provider cites only a short assent. Long evidence turns display a
  claim-relevant excerpt while the authoritative turn ID and full transcript stay
  unchanged.

## Consequences

- Users see a new final message by default and can still inspect the last live
  state. Existing deployments can opt into replacement without a data migration.
- Publication remains idempotent across retries and restarts because live and
  final projection identities are durable and separate from operation keys.
- Summary detail and evidence readability improve without widening the persisted
  summary contract or making provider availability depend on a brittle semantic
  validator.
