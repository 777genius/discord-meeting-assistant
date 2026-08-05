---
id: ADR-0004
status: accepted
supersedes: []
superseded_by: []
---

# ADR-0004: Hosted subscription runtime without an OpenAI API key

Status: Accepted

Date: 2026-08-02

## Context

The hosting environment already operates a `subscription-runtime` for the
`social-monitor` project and owns the subscribed model accounts. The Meeting
Platform must reuse that established account mechanism rather than provision an
`OPENAI_API_KEY` or copy subscription credentials into this repository.

Final transcription and evidence-backed summary remain separate application
ports. A model subscription runtime is a text-generation provider, not the
source of meeting truth and not an audio storage boundary.

## Decision

The active V1 summary provider is a new
`SubscriptionRuntimeSummaryAdapter` implementing the Meeting Core
`SummaryGenerationPort` through the runtime's published protocol. The exact
protocol, lease semantics, and deployment endpoint are adopted only after a
read-only audit of the authorized `social-monitor` implementation.

The existing hosting runtime owns account credentials, cookies, leases,
rate-limit state, and account health. The Meeting Platform receives only the
minimum scoped runtime access required by that protocol. Credentials, account
identities, mutable account stores, and runtime volumes are never copied or
mounted into the Meeting Platform.

ADR-0005 refines custody after the host audit: a dedicated sidecar may receive
an atomically allocated private auth copy, but the Meeting Platform application
still never reads or mounts credentials and no mutable `social-monitor` state is
shared.

Final post-call transcription uses a self-hosted, replaceable STT adapter such
as Speaches/faster-whisper. The default deployment does not require or read
`OPENAI_API_KEY`. OpenAI-specific provider code is not part of the active V1
composition and may be removed when the subscription and self-hosted STT paths
fully cover their application ports.

All provider requests retain stable meeting/stage/version identities, bounded
concurrency, timeouts, retry classification, evidence validation, and a
deterministic fake for local tests.

## Consequences

- V1 has no OpenAI API-key or separate API-billing prerequisite.
- Subscription account lifecycle remains isolated behind the existing hosted
  runtime rather than leaking into Meeting Platform.
- Runtime unavailability can delay summary generation but cannot invalidate the
  recording or final transcript.
- Self-hosted STT capacity and Russian/English accuracy must be proven by the
  benchmark and real-call E2E gates.
- Provider replacement still requires no domain or application changes.
