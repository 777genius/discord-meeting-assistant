---
id: ADR-0065
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0065: Private quality budget-ledger lock adapter

## Status

Accepted on 2026-09-04. This decision clarifies
[ADR-0060](0060-authenticated-quality-campaign-runner-boundaries.md).

## Decision

The Infinity quality-campaign attempt-budget ledger adapter owns its persistent
lock inode and identity lifecycle. Its private
`adapters.infinity-quality-budget-lock` OS adapter owns only acquisition of that
already-open file lock through the fixed host `flock` executable. It is not a
public package or application boundary.

## Consequences

Ledger identity and lifecycle stay with the ledger adapter, while process and
file-lock mechanics remain isolated in the narrow private adapter.
