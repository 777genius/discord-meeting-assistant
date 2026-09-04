---
id: ADR-0024
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0024: Possession-based recording playback

## Status

Accepted.

## Context

Discord summary publication must remain independent from audio delivery. The
authoritative recording is private multitrack evidence in object storage, while
people need one browser player with seeking and no Discord attachment limits.

## Decision

Meeting Platform owns a separate `recording-playback` feature outside Meeting
Core. Its application layer defines a recording catalog, audio reader ports and
the playback use case. Postgres, S3, HMAC and Fastify remain adapters.

Discord summaries contain a stable possession link. The unguessable signed
token is placed in the URL fragment, so browsers do not send it in the initial
request or reverse-proxy access logs. The page exchanges it for a scoped,
HttpOnly, SameSite cookie. Production playback requires HTTPS.

The browser exposes one control surface and synchronizes the authoritative
speaker tracks using their timeline offsets. Each private track supports single
HTTP byte ranges and seeking without buffering the complete meeting. The
object-storage bucket remains private.

Playback reports `processing`, `ready`, or `unavailable`. Publication never
waits for playback and never reads audio, so any playback failure leaves the
summary and original recording valid.

## Consequences

- No generated mixed artifact, temporary disk allocation or audio-size limit is
  introduced in V1.
- Browser synchronization is derived presentation, not new authoritative
  evidence.
- Anyone possessing the link can listen. Rotating the signing secret revokes
  all issued links.
- A future product site can replace the page while retaining the application
  ports, signed-link contract and Range endpoints.

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
