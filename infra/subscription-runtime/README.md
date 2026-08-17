# Subscription runtime sidecar

This deployment boundary supplies meeting-summary generation through a private
pool of Codex subscription accounts. It does not use an OpenAI SDK, API key, or
separate API billing account.

## Ownership boundary

The Meeting Platform application talks to the sidecar only through an
authenticated, non-published internal transport implementing
`SubscriptionRuntimeTransportPort`. The sidecar owns provider composition,
session materialization, refresh, encrypted state, leases, capacity signals,
and account recovery. Application and domain code never read credentials or
runtime volumes.

The host allocator must reserve a dedicated subset from the existing host
account inventory, exclude those accounts from other project candidates, and
atomically materialize only opaque slots at:

```text
${SUBSCRIPTION_RUNTIME_PRIVATE_ROOT}/
  auth-pool/pool.json
  auth-pool/generations/<opaque-generation>/slot-1/auth.json
  auth-pool/generations/<opaque-generation>/slot-2/auth.json
  secrets/local-encryption-key
  secrets/service-token
  state/
```

Credential values, account names, and source inventory paths do not belong in
Compose, repository files, logs, task requests, health responses, or
attestations. Directly mounting `social-monitor/auth-current`, its runtime state,
or any other mutable project directory is forbidden.

Keep the host-only reservation manifest outside the repository:

```json
{
  "schemaVersion": 1,
  "owner": "discord-meeting-assistant",
  "accounts": ["<reserved-host-account>", "<reserved-host-account>"]
}
```

After the common host allocator has excluded those accounts from Social
Monitor, materialize an immutable sidecar generation with:

```text
node infra/subscription-runtime/materialize-account-pool.mjs \
  --auth-root <host-account-inventory> \
  --reservation-manifest <host-only-reservation.json> \
  --target-root ${SUBSCRIPTION_RUNTIME_PRIVATE_ROOT}/auth-pool \
  --target-uid 10001 \
  --target-gid 10001
```

The command never prints account names. It publishes `pool.json` only after all
private auth copies are complete; older generations remain valid for a running
sidecar and can be pruned during a later stopped maintenance window.
Keep existing reservation entries in stable order so an opaque slot never
changes identity while its provider state exists. Append-only pool expansion is
safe. Reordering, removing, or replacing an entry requires stopped maintenance
and removal of that slot's provider state before the sidecar restarts.

`local-encryption-key` is a standard or URL-safe base64 encoding of exactly 32
random bytes (for example, `openssl rand -base64 32`), not hexadecimal text.
The launcher must be executable by UID `10001`, while auth and secret files stay
regular, non-symlink files with mode `0400`.

## Required sidecar behavior

The immutable sidecar image must:

1. pin `@vioxen/subscription-runtime` to `0.1.0-main.27` and verify both the
   package version and the complete admitted audited-launcher bundle SHA-256 before
   every execution;
2. admit `discord_meeting.summary.generate` only with
   `gpt-5.6-sol`/`medium`, an 8192-token post-execution output budget, and policy version
   `meeting-summary.subscription-runtime.v16`; admit
   `discord_meeting.summary.incremental` only with `gpt-5.6-luna`/`low`, a
   2048-token post-execution output budget, and policy version
   `meeting-summary.incremental.subscription-runtime.v7`; admit
   `discord_meeting.conversation.answer` only with `gpt-5.6-luna`/`low`, a
   512-token budget, policy `meeting-conversation.subscription-runtime.v1`,
   and schema `discord_meeting_conversation_answer_v1`. All profiles use stateless
   completion, disabled tools, read-only permission, no interactive input, the
   isolated tmpfs working directory, and their exact purpose-bound structured
   schema. Final summaries use `discord_meeting_summary_v4`: title up to 96
   characters, overview up to 320, up to four topics with at most two points,
   up to five decisions/actions/questions, up to four evidence turns per item,
   and 160-character prose (96 for deadlines). Incremental live
   snapshots use `discord_meeting_incremental_summary_v1`, which permits one
   short overview, at most three topics with one or two points, at most three
   decisions/actions/questions each, and one to three evidence turns per item.
   The live schema is deliberately selective and must not claim completeness;
   the three schemas and names are not interchangeable;
3. start children from an explicit environment allowlist and remove every
   `*_API_KEY`, `*_API_KEY_FILE`, session-scoped Codex identifier, and unrelated
   application secret;
4. accept Agent Task protocol v1 structured prompts and JSON Schema, return only
   structured output for completed requests, and reject unknown purposes or
   conflicting controls before provider execution;
5. attach an execution attestation containing the canonical request hash,
   selected output hash, provider/model/profile, runtime package version, and
   audited launcher bundle digest;
6. expose `RunAgentTask` and `CheckHealth` only on the internal meeting network
   and authenticate both methods from the mounted service-token file;
7. keep safe error codes separate from provider stderr/stdout and never return
   auth data, raw provider payloads, account identities, or token-shaped text.

The output budget is checked against measured provider output after completion.
It is not a provider generation cap and does not guarantee latency; the compact
final and incremental schemas/prompts reduce response volume, while `low`
reasoning is used by both latency-sensitive Luna purposes.

The sidecar selects an opaque account round-robin per request and tries another
account for quota, reconnect, invalid-session, or backend failures. It applies
no task-count limit and keeps no waiting queue. Persistent conversation
execution retains one prewarmed `FileBackendCodexWorker` per account; overlapping
requests create additional native workers immediately and dispose them after
completion. Failed retained workers are disposed and prewarmed again on the
next request. Every turn stays stateless, and Subscription Runtime continues to
own app-server execution, session/cache safety, and packaged exec fallback. The audited launcher wraps
only the admitted `codexBinaryPath` on that fallback and observes
`codex exec --json` JSONL `turn.completed` events. It keeps the private runtime
worker responsible for auth custody and disabled-tool policy. Codex supplies
measured input, cached input, output, and reasoning-output tokens in that event;
it does not supply cache-write input or total. Those four classes are returned
as measured telemetry, cache-write input is explicitly `unavailable`, and total
is explicitly `derived` as input plus output. No absent class is replaced with
zero. Legacy complete usage remains available only when every class was measured.

API-equivalent Luna cost uses the immutable `openai-standard-2026-08-02` cards
sourced from the official pricing table and Luna model page: through 272,000
input tokens, $0.20/M input, $0.02/M cached input, $0.25/M cache writes, and
$1.20/M output. Above that threshold, documented full-request long-context
rates are $0.40/M input, $0.04/M cached input, $0.50/M cache writes, and
$1.80/M output. Reasoning is already included in output tokens. When cache-write
input is unavailable, callers receive a min/max range instead of an exact cost:
minimum assumes no cache writes and maximum assumes all non-cached input was a
cache write. The price-card ID and source travel with that estimate.

`sidecar-policy.json` is a declarative deployment contract. The sidecar must
fail closed if its executable policy differs from that file.

## Integration

The Meeting Platform composition layer provides a concrete gRPC transport for
`SubscriptionRuntimeTransportPort`. The adapter package remains independent of
gRPC and provider SDKs. This keeps transport replacement and the future
host-wide Subscription Runtime Gateway outside Meeting Intelligence.

The adapter checks `CheckHealth` identity before readiness and verifies every
completed result's attestation and output hash. Product retries use the returned
safe failure class and the existing stage idempotency key. Quota, reconnect,
invalid session, stale generation, backend unavailable, and timeout may be
retried with bounded exponential backoff and jitter; invalid schema, evidence,
attestation, permission, and interactive-input failures are terminal.

## Deployment gate

Before real Discord E2E, verify without printing secrets:

- `SUBSCRIPTION_RUNTIME_SOURCE_REVISION` is the exact 40-character deployed Git
  commit and matches the sidecar image revision label;
- the private root is outside every other project's directory;
- auth and secret files are regular, non-symlink files with least-privilege
  ownership and modes;
- every reserved pool account is excluded from all other project allocators;
- Compose publishes no host port and joins only `discord-meeting-internal`;
- health reports the exact package version and audited launcher bundle digest;
- a deterministic contract request passes before any real provider request;
- logs contain no API-key variables, auth JSON, provider payload, or account
  identity.
