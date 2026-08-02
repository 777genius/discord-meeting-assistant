# Subscription runtime gRPC sidecar

This package is the internal server counterpart of
`SubscriptionRuntimeTransportPort`. It admits exactly
`discord_meeting.summary.generate` and `discord_meeting.summary.incremental`,
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
SUBSCRIPTION_RUNTIME_EXPECTED_LAUNCHER_SHA256=<lowercase sha256>
```

The package manifest must be exactly `@vioxen/subscription-runtime` version
`0.1.0-main.2`. The launcher is inspected by realpath and SHA-256 before and
after every task. It must call that version's
`subscription-runtime-run-agent-task` JSON bridge while constructing the Codex
worker with the exact selected profile: `gpt-5.6-sol`/`xhigh` for final summary
or `gpt-5.6-luna`/`low` for incremental summary, disabled tools, no interactive
flow, and stateless-completion semantics. A generic launcher that does not
enforce both exact profiles is not an admitted production installation.

The sidecar invokes the audited bridge with `--provider codex`, `--input`,
`--format result-json`, `--timeout-ms`, `--state-root`, `--codex-auth-json`,
`--provider-instance discord-meeting-summary-v3`, and the selected profile's
exact `--model`. The child reasoning environment must match that same request
profile. The auth JSON and state root must belong only to this sidecar. Never
mount another project's mutable runtime state.

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
