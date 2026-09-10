# AI summaries

[Self-hosting](README.md) · [Voice answers](voice-answers.md)

This scenario adds generated summaries, topics, decisions, actions and open
questions to the final transcript. The base turn-count outline is not AI
summarization. Live incremental generation additionally needs live transcription.

## Before you start

Complete the base installation and verify a transcript first. Generation uses
the private Subscription Runtime sidecar and operator-owned authorized Codex
subscription sessions. It does not accept an OpenAI API key as a substitute.

**External prerequisite:** the repository does not ship the private
`@vioxen/subscription-runtime@0.1.0-main.27` artifact or a public installation
workflow for obtaining it. You must already have authorized access to that exact
package, its complete Linux-compatible dependency tree and a supported host
account inventory. Without these, stop at the base transcription setup; this
optional scenario cannot currently be completed from the public repository alone.
The word `hosted-summary` names a Compose profile, not a hosted Botik service
provided to users.

## 1. Provision runtime storage

Under your `DEPLOY_ROOT`, prepare:

| Path | Content / access |
| --- | --- |
| `runtime/installation/node_modules` | Exact runtime package and complete dependencies; readable by UID 10001, mounted read-only |
| `runtime/auth-pool` | Immutable opaque account generation and `pool.json`; UID 10001, directory 0700, auth files 0400 |
| `runtime/state` | Writable runtime state; UID 10001, directory 0700 |
| `secrets/runtime/local-encryption-key` | Exactly 32 random bytes encoded as base64; UID 10001, mode 0400 |
| `secrets/runtime/service-token` | Random service bearer of at least 32 bytes; UID 10001, mode 0400 |
| `secrets/platform/runtime-service-token` | Same bearer value as the sidecar's service-token; UID 10001, mode 0400 |

Create the `runtime` parent first; the materializer requires an existing canonical
parent directory. Create `secrets/runtime` with owner `10001:10001` and mode `0700`.
Keep parent directories traversable by the service owner. The reservation manifest
must be a regular non-symlink private file (mode `0400`).

Use `openssl rand -base64 32` for the encryption key, not a hexadecimal string.
Keep private installation/auth directories outside other projects. The image
already ships the audited launcher; do not copy older launcher modules into the
persistent installation mount.

## 2. Materialize authorized accounts

Reserve the selected accounts in your supported host allocator before starting
this sidecar. The repository assumes this allocator/inventory already exists;
it does not create or log in subscription accounts for you.

Create a host-only reservation manifest outside the checkout:

```json
{"schemaVersion":1,"owner":"discord-meeting-assistant","accounts":["YOUR_RESERVED_HOST_ACCOUNT"]}
```

Run the existing materializer using your real inventory and manifest paths:

```sh
node infra/subscription-runtime/materialize-account-pool.mjs \
  --auth-root /secure/your-host-account-inventory \
  --reservation-manifest /secure/botik-runtime-reservation.json \
  --target-root /srv/discord-meeting-assistant/runtime/auth-pool \
  --target-uid 10001 --target-gid 10001
```

The inventory placeholder is not a directory created by this guide. Use the
supported inventory supplied by your runtime installation. Run with the file
permissions required to read that inventory and assign the target owners. Do
not print or manually paste account auth into the repository. Preserve slot
ordering across updates; do not replace an account behind an existing slot.
See [account custody](../../infra/subscription-runtime/README.md#ownership-boundary).

## 3. Compute the admitted launcher digest

The digest covers six files, including their logical filenames and lengths.
It is **not** `sha256sum` of the entrypoint. From the exact clean checkout, this
Node-only command reproduces the repository's bundle hash without launching the
runtime or reading account credentials:

```sh
node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const names = [
  'audited-codex-jsonl-capture.mjs',
  'audited-codex-jsonl-bridge-output.mjs',
  'audited-codex-jsonl-events.mjs',
  'audited-codex-jsonl-capture-store.mjs',
  'audited-xhigh-policy.mjs',
];
const files = await Promise.all([
  ['launcher.mjs', 'audited-xhigh-launcher.mjs'],
  ...names.map(name => [name, name]),
].map(async ([name, path]) => ({name, bytes: await readFile(`infra/subscription-runtime/${path}`)})));
const hash = createHash('sha256');
for (const {name, bytes} of files.sort((a, b) => a.name.localeCompare(b.name))) {
  hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
}
console.log(hash.digest('hex'));
JS
```

Set the resulting 64-character value as `SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256`
in `/secure/botik.env`. Recompute it when upgrading source. The
[installation inspector](../../apps/subscription-runtime-sidecar/src/installation-inspector.ts)
and [sidecar contract](../../apps/subscription-runtime-sidecar/README.md) are the
source of truth for package and policy compatibility.

## 4. Start the optional profile

Use the base three files, then the summary overlay, and activate its profile:

```sh
node infra/deployment/run-verified-compose.mjs --env-file /secure/botik.env -- \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.craig.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml \
  -f infra/deployment/compose.hosted-summary.yaml \
  --profile hosted-summary up --build --detach --wait
```

The overlay sets `SUMMARY_PROVIDER=subscription-runtime`, wires the internal
token/address and makes Platform wait for the sidecar. Setting only
`SUMMARY_PROVIDER` does not perform this setup. No sidecar host port is needed.
Extend your inspection helper with the same overlay and profile.

## 5. Verify behavior

Check sidecar health, then run a short synthetic private meeting containing an
explicit topic, decision and assigned action. Confirm the final Discord result
contains generated content grounded in the transcript. Empty decision/action
lists are valid when the conversation contains none. Verify the transcript is
still attached and originals survive a generation error.

For incremental summaries, enable `VOICETEXT_LIVE_ENABLED=true` and check a
sufficiently long test meeting. Live summaries are selective drafts, not the
complete authoritative result. Check provider/session availability and sanitized
sidecar errors if generation fails; do not bypass hash, schema or policy checks.

## Disable or roll back

Stop Platform and the sidecar before removing generation. Remove the summary
overlay/profile from the deployment command, restore
`SUMMARY_PROVIDER=transcript-outline`, and redeploy the base stack. Do not stop
the sidecar while voice answers or another enabled feature still depends on it.
Preserve originals, databases and runtime state. Roll back sidecar image, package
mount layout, policy and admitted digest together, using a schema-compatible release.
