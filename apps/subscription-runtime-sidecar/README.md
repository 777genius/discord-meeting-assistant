# Subscription runtime gRPC sidecar

This package is the internal server counterpart of
`SubscriptionRuntimeTransportPort`. It admits exactly
`discord_meeting.summary.generate`, `discord_meeting.summary.incremental`, and
`discord_meeting.conversation.answer`,
and returns no credential, provider payload, account identity, raw stdout, or
stderr.

## Runtime artifact boundary

The repository and base Dockerfile intentionally do not contain the private
`@vioxen/subscription-runtime` tarball, Codex auth, or a deployment launcher.
Deployment must extend the image or mount an audited, immutable installation and
set:

```text
SUBSCRIPTION_RUNTIME_LAUNCHER_PATH=/opt/subscription-runtime/launcher.mjs
SUBSCRIPTION_RUNTIME_PACKAGE_MANIFEST_PATH=/opt/subscription-runtime/package/package.json
SUBSCRIPTION_RUNTIME_EXPECTED_LAUNCHER_SHA256=<lowercase audited launcher bundle sha256>
```

The package manifest must be exactly `@vioxen/subscription-runtime` version
`0.1.0-main.27`. The launcher entrypoint and its five audited sibling modules are
inspected by realpath and one canonical bundle SHA-256 before and after every
task. Changing any executable part changes the admitted digest. The launcher
must call that version's
`subscription-runtime-run-agent-task` JSON bridge while constructing the Codex
worker with the exact selected profile: `gpt-5.6-sol`/`medium` for final
summaries with an admitted 8192-token post-execution output budget and policy
version `v15`, and `gpt-5.6-luna`/`low` for incremental summaries with an
admitted 2048-token post-execution output budget and policy version `v6`.
Conversation uses `gpt-5.6-luna`/`low`, a 512-token budget, policy
`meeting-conversation.subscription-runtime.v1`, and schema
`discord_meeting_conversation_answer_v1`. Every profile has disabled tools, no
interactive flow, and stateless-completion semantics. A generic launcher that
does not enforce all three
exact profiles is not an admitted production installation.

The final purpose admits only `discord_meeting_summary_v4`: title up to 96
characters, overview up to 320, at most four topics with one or two points, at
most five decisions/actions/questions, one to eight evidence turns per action,
one to four per other item, and 160-character prose (96 for deadlines). The live purpose
admits only `discord_meeting_incremental_summary_v1`: one short overview,
at most three topics with one or two points, at most three entries in each key
list, and one to three evidence turns per item. It is a selective snapshot, not
a claim of complete meeting history. The schema names and full JSON Schemas are
purpose-bound and fail closed if swapped. Conversation accepts exactly one
non-empty `answer` string of at most 2,000 characters.

The budget is checked against measured provider output after completion. It is
not a provider generation cap and does not guarantee latency; the compact final
and incremental schemas/prompts reduce response volume, while `low` reasoning
is used by both latency-sensitive Luna purposes.

The sidecar attempts to prewarm four conversation worker slots for every
admitted account before accepting traffic. Startup proceeds once at least one
account pool is healthy. An unhealthy account remains configured; selecting it
later creates and prewarms a fresh pool, so transient startup failure does not
remove it from later failover or recovery. The sidecar keeps healthy
purpose-and-account-scoped Subscription Runtime pools alive. The audited native
`BoundedSubscriptionWorkerPool` owns
worker lifecycle, bounded concurrency, queueing, cancellation, health, and
capacity inside each account. A thin sidecar admission pool shares four account
permits across all purposes, distributes requests round-robin, bounds the global
waiting queue to 256 requests, and fails over before any streamed text is
emitted. Every native slot owns a separate `FileBackendCodexWorker`; the runtime's
file-backed refresh lease and session-generation compare-and-swap protect their
shared account state. Final and incremental summaries use the audited
launcher bridge because the pinned app-server path does not guarantee measured
generation telemetry; summary generation remains fail-closed without it. The
audited launcher validates the same exact request profile and installation
identity.

Conversation additionally exposes an authenticated server-streaming RPC. It
forwards only bounded redacted text deltas and one terminal result from that
same warm worker. Summary and incremental-summary calls retain the unary RPC.
The client must validate ordering and the final execution attestation; streamed
text is provisional until that terminal result succeeds.

The fallback bridge uses `--provider codex`, `--input`,
`--format result-json`, `--timeout-ms`, `--state-root`, `--codex-auth-json`,
an opaque slot-specific `--provider-instance`, and the selected profile's exact
`--model`. The child reasoning environment must match that same request
profile. Every auth JSON and the state root must belong only to this sidecar. Never
mount another project's mutable runtime state.

The audited launcher observes the documented `codex exec --json` JSONL
`turn.completed` event through the worker's admitted `codexBinaryPath`; it does
not replace the private worker or its auth/tool policy. Codex reports measured
input, cached input, output, and reasoning-output tokens there, but does not
report cache-write input or total. The sidecar forwards those classes as
`telemetry`, marks cache-write input `unavailable`, and derives total only as
`input + output` with an explicit `derived` marker. It never creates a zero for
an absent token class. The legacy `usage` field remains present only when every
class was measured, for both completed and failed provider tasks.

The adapter can price partial Luna telemetry as a bounded estimate: the minimum
assumes no cache writes and the maximum assumes all non-cached input was a cache
write. An exact API-equivalent cost is emitted only when cache-write input is
measured, with the price-card ID and source retained alongside the estimate.

## Secrets and network

`SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE` and
`SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY_FILE` must be regular, private files.
The service token authenticates both gRPC methods. The child receives an explicit
environment allowlist; every `*_API_KEY` and `*_API_KEY_FILE` variable is
removed. The gRPC bind comes from `SUBSCRIPTION_RUNTIME_GRPC_BIND`; deployment
must expose it only on the internal network and must not publish a host port.

The existing `sidecar-policy.json` is required through
`SUBSCRIPTION_RUNTIME_PURPOSE_POLICY_FILE`. Startup fails when deployment paths,
transport, custody, or purpose controls conflict with executable policy.

Tests inject the installation, readiness, and process ports. They never start a
container, private runtime, Codex process, provider task, or real account.
