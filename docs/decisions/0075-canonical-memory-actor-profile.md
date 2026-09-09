---
id: ADR-0075
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0075: Bind canonical memory execution to the signed actor profile

Accepted on 2026-09-08. Owner: Meeting Knowledge; the Infinity Context adapter
owns canonical executor composition. This extends ADR-0073 without changing its
accepted bytes or the authoritative recording, transcript, or meeting evidence.

## Decision

Require an explicit `actorKeyProfileId` in installed canonical executor settings
and in the signed `meeting_knowledge.quality_scope_topology.v2` payload. Validate
both identifiers and exact equality before constructing database or provider
ports. Version 1, missing profile, invalid profile, and invalid signatures fail
closed. A settings change alone cannot authorize another actor profile.

Construct the concrete production `HmacHistoricalOpaqueIds` adapter with the
verified profile and topology key. Retain the constructor identity guard and
production HMAC byte semantics. The selected profile participates in historical
index generation, so execution must match the profile used to index the corpus.

## Compatibility and rollout

Operators must issue a fresh signed version 2 topology containing the actual
production indexing profile. Existing version 1 signatures are not upgraded or
reused. A legitimately signed but different profile cannot reuse an old plan or
its indexed generation. Preserve failed and unknown attempts; do not retry a
provider effect blindly. Model defaults and qualification thresholds are unchanged.
No package or production source boundary is added.

## Validation

HTTP-port tests cover settings and signed-payload validation. Installed-package
tests cover trusted production adapter construction and rejection when a changed
profile is paired with an old plan. The shared installed fixture is test-only.
Repository gates and independent review remain required; these tests do not
measure real memory quality or establish a qualified release.
