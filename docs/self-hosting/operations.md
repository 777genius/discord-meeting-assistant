# Operations, updates and backups

[Self-hosting](README.md) · [Troubleshooting](troubleshooting.md)

Keep a deployment record outside Git containing the source SHA, environment
file, active Compose overlays/profiles, proxy configuration, image identities
and backup locations. Use the same Compose project name and data root for all
commands on one deployment; use distinct names/roots for different deployments.

## Inspect and restart

Use the `botik_compose` helper from [Installation](installation.md#6-check-startup).
When using optional features, extend it with every active overlay/profile. The
examples below assume that helper describes your complete deployment:

```sh
botik_compose ps --all
botik_compose logs --tail 100 meeting-platform craig-bot voicetext-gateway
botik_compose restart meeting-platform
```

A restart reuses existing container configuration. To apply environment, secret
mount or Compose changes, redeploy using the verified `up --build --detach --wait`
command with the complete active file/profile list. Inspect individual restart
counts and storage pressure rather than repeatedly restarting a failing stack.

## Update source

1. Finish active meetings and allow pending work to settle. Schedule downtime;
   the live owner is a singleton.
2. Take a consistent backup as below. Record old source, image and schema state.
3. Stop the active stack with `botik_compose stop` from the old checkout.
4. In a clean deployment checkout, fetch the reviewed target revision and inspect
   its migration/compatibility notes. Do not blindly select a moving branch for
   an unattended production update.
5. Set `MEETING_PLATFORM_SOURCE_REVISION` to the new full HEAD in the external
   environment file. Update any release-bound runtime digest/package or provider
   qualification together with that revision.
6. Run the complete verified startup command. One-shot migrations must exit 0
   before Platform starts. Check all long-running service health.
7. Verify a private synthetic meeting and each enabled optional feature before
   relying on the updated deployment.

The wrapper's temporary context contains only committed files. Do not build
from a dirty working directory or reuse a stale generated source-tree value.
Inspection after an update must recalculate `MEETING_PLATFORM_SOURCE_TREE`.

## Consistent backup

Stop the complete active stack first. A filesystem copy of live PostgreSQL data
is not a consistent database backup. With services stopped, snapshot/copy all
`DEPLOY_ROOT/data` roots, external secrets/configuration and optional runtime state.
Preserve numeric owners, modes and directory structure. Encrypt backups containing
credentials or recordings and keep a copy outside the server's failure domain.

At minimum, preserve:

- `data/craig/recordings`: original multitrack audio;
- `data/craig/postgres` and `data/postgres`: recording/meeting metadata;
- remaining database, Redis, object-storage, spool and TLS directories for a
  consistent full deployment recovery;
- external environment, secrets, operator overlays, proxy configuration and
  optional runtime auth/state/package provenance;
- deployed source SHA, image revision labels and
  `.build/meeting-platform-build-provenance.json` from the matching build.

Restart using the unchanged verified command after the snapshot completes.
A backup is not proven until a restore is exercised.

## Restore

Use a new isolated destination and private test identities. Do not run restored
production tokens against the same guild while the original stack is active.
Restore data and credentials with the recorded numeric owners, use compatible
image/database versions and rebuild from the recorded source if needed. Keep
original source pins and migration checks; do not edit migration receipts.

Validate service health, database state and recording availability before any
Discord/provider activity. Use synthetic evidence and a private test guild for
an end-to-end restore check. Never point recovery tests at live customer data.

## Roll back

Prefer reverting an operator feature/profile setting on the current compatible
release. A code downgrade is safe only when the old binary supports the current
schema. The [deployment compatibility notes](../../infra/deployment/README.md)
include stop-only boundaries for migrations 0005, 0027 and 0032. Do not assume
`git checkout` reverses a database migration. For incompatible schema rollback,
restore a coordinated pre-upgrade backup into an isolated deployment and assess
any data created after that backup before replacing the active instance.

## Credential changes

Coordinate both consumers of each shared bearer: Platform/Craig,
Platform/VoiceText and Platform/runtime. Stop affected services, replace the
credential files with correct owners/modes, then redeploy both sides. Updating
only one side causes authentication failure. Changing a PostgreSQL bootstrap
password file does not change an initialized database role; rotate the role and
its URL through a coordinated database maintenance procedure. Do not regenerate
all secrets by rerunning first-install steps.

## Stop or remove containers

```sh
botik_compose stop
# To remove containers and networks while preserving bind-mounted data:
botik_compose down
```

Do not delete `DEPLOY_ROOT`. Container removal is not a retention policy and
must not remove original recordings. For optional-feature removal, explicitly
stop its old containers before dropping their profile from future commands.
