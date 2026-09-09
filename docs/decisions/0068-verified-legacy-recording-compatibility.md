---
id: ADR-0068
status: accepted
supersedes: [ADR-0024]
superseded_by: []
---

# ADR-0068: Verified legacy recording compatibility

## Status

Accepted. Supersedes ADR-0024 while inheriting all of its controls.

## Context

The verified legacy recording compatibility decision was appended to the
immutable accepted ADR-0024. This decision retains that compatibility text
unchanged, restores ADR-0024's historical body, and changes no existing code
behavior.

## Decision

All decisions and consequences of
[ADR-0024](0024-possession-based-recording-playback.md) remain in force:

- Meeting Platform owns Recording Playback outside Meeting Core. The clean
  application boundary owns the catalog, audio reader ports and playback use
  case; Postgres, S3, HMAC and Fastify remain adapters selected by composition.
- Stable possession links use unguessable signed tokens in URL fragments,
  excluded from initial requests and reverse-proxy access logs, exchanged for
  scoped HttpOnly, SameSite cookies. Production playback requires HTTPS.
  Anyone possessing a link can listen; signing-secret rotation revokes all links.
- One browser control surface synchronizes authoritative speaker tracks with
  timeline offsets. Private tracks support single HTTP byte ranges and seeking
  without buffering the complete meeting; object storage remains private.
- Playback reports `processing`, `ready`, or `unavailable`. Publication never
  waits for playback or reads audio. Playback failure leaves both the summary
  and original recording valid.
- V1 introduces no generated mixed artifact, temporary disk allocation or
  audio-size limit. Browser synchronization remains derived presentation,
  never authoritative evidence. A future page may replace the current page
  while retaining application ports, signed-link contracts and Range endpoints.

The following compatibility decision is retained verbatim without weakening or
expanding its scope.

## Verified legacy recording compatibility

Recording Playback and Meeting Lifecycle own the compatibility adapter at
`apps/meeting-platform/src/adapters/recording-compatibility/verified-recording-repository.ts`.
Its sibling `verified-recording-identity.ts` verifies the retained evidence.
Composition selects it for the shared PostgreSQL meeting repository, so playback
and post-call processing use the same verified snapshot. Current snapshots bypass
compatibility. Legacy snapshots are enriched only from the ingress-owned durable
completion receipt, with an exact recording/manifest/speaker/locator/timeline
match and complete immutable track identities. Every selected version is read
and its entire body independently checked against the retained receipt hash and
size before returning metadata. There is no latest-object lookup or synthesized
version/checksum, and no use of the derived live packet journal. Missing receipts,
non-versioned historical objects and conflicting evidence fail closed.

This is read-time compatibility, not a database migration. It does not mutate
the original recording, stage status, meeting revision or transcript; normal
post-call CAS saves may subsequently retain the verified metadata. Playback-only
reads repeat verification. A sanitized verification event identifies the meeting
and recording for audit. Operators must retain the private completed ingress
spool alongside the database and immutable object versions. Rows whose historical
receipt has been lost require recovery of that authoritative evidence; merely
hashing a current object does not authenticate an old row. Previously terminal
post-call failures still require the existing explicit recovery workflow.
