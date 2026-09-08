---
id: ADR-0073
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0073: Bounded signed legacy historical admission

Meeting Knowledge owns a separate `signed_legacy_v1` historical admission.
This is the explicit legacy exception anticipated by ADR-0066; it does not
create lifecycle-v3 provenance, qualify a corpus, or enable serving.

## Ownership and dependencies

Within the existing Meeting Knowledge boundary, `domain/legacy-historical-admission.ts`
owns the closed payload, canonical bytes and deterministic human selection;
`application/ports/legacy-historical-admission.ts` owns verification and storage ports.
Within PostgreSQL, `postgres-legacy-historical-verifier.ts` implements Ed25519
verification against independently injected public trust;
`postgres-legacy-historical-admission.ts` persists immutable receipts and accepts
existing historical sync intent atomically; `postgres-accepted-historical-meeting.ts`
resolves both admission variants. Migration 0044 stores no transcript copy.
The existing Foundation roots classify all these paths fail-closed. Composition
selects trust in `apps/meeting-platform/src/composition/legacy-historical-admission.ts`,
historical memory, and the existing production canonical executor factory.
No new package, dependency, diagnostic authority, or execution engine is added.

## Signed evidence and lifetime

The closed v1 payload binds signer, policy, complete release, recording, accepted
revision, raw database snapshot, accepted transcript, saved source, evidenced actor
roster, scope/room, and authoritative duration. SHA-256 strings use lowercase hex.
Canonical JSON recursively sorts object keys by UTF-16 code units, preserves array
order, uses JSON string/number encoding and rejects non-JSON values. Snapshot and
transcript hashes cover canonical JSON of the raw stored values, before restore.
Saved-source SHA-256 covers the exact supplied UTF-8 JSON bytes; its parsed value
must equal the accepted transcript under canonical JSON. Evidence digests identify
operator-retained evidence; signature verification cannot establish its truth.
Signing bytes are UTF-8 `meeting-knowledge.signed-legacy.v1\n` followed by the
canonical payload. Signatures are canonical base64 Ed25519, with no embedded keys.
A trust entry pins policy ID, signer ID and public key outside the receipt.

Admission locks the knowledge source then the meeting, checks exact identity,
revision and hashes, and uses the existing acceptance transaction for withdrawal,
monotonic generations, supersession and replay. Receipt bytes are immutable.
Any changed full snapshot or revision fails closed. The same transcript release
cannot replace its receipt; fresh admission needs a new accepted transcript release.
Existing non-null source/roster/duration must agree; lifecycle-v3 or producer
provenance cannot be overridden. Unknown actors and uncovered speakers are denied.
Automation remains untouched in the original transcript and is excluded from evidence.

Rehydration verifies current trust and exact local binding again. Room enumeration
still begins only at current applied sync plans, joins the receipt within its
repeatable-read snapshot, and preserves bounds and candidate isolation. Missing
trust disables legacy resolution. Indexing uses the existing historical worker.
The final-reply publication/publisher authority remains lifecycle-only; later
serving integration must preserve those independent checks.

## Validation and operator obligations

Synthetic tests cover contract closure, signature/binding tamper, local resolution,
transaction rollback/replay/concurrency, withdrawal and the existing worker path.
No actual evidence or authorized signer is supplied by this change. Operators must
independently establish truthful identity, room/scope and duration, current source
and sync generation, authentic signatures and release-bound qualification.
The original recording, transcript and meeting remain authoritative and unchanged.


## Canonical executor actor profile

The installed canonical executor requires an explicit actorKeyProfileId matching
the signed meeting_knowledge.quality_scope_topology.v2 document. It constructs
the same trusted HMAC adapter as production, including the actor profile in the
historical index generation. Version 1 topology documents are rejected. Operators
must issue a new version 2 signature with the production indexing actor profile;
changing the connection setting alone cannot authorize a different profile.
