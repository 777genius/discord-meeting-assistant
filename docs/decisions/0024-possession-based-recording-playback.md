---
id: ADR-0024
status: superseded
supersedes: []
superseded_by: [ADR-0068]
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
