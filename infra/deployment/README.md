# Isolated host deployment

This Compose project is isolated under one explicit `DEPLOY_ROOT`, uses unique
networks and service names, publishes no host ports, and never mounts another
project's mutable runtime directory. Craig joins `discord-meeting-internal` and
posts authenticated ingress traffic to `http://meeting-platform:4310`.

All files below `${DEPLOY_ROOT}/secrets` and the copied subscription auth slot
must be regular, non-symlink files with mode `0400`, owned by the UID that reads
them. Platform and subscription-runtime files and their mounted directories use
UID `10001`; `redis.conf` uses UID `999`; `s3-config.json` uses UID `1000`.
Root-owned bootstrap files are limited to services whose entrypoints read them
before dropping privileges. Persistent service data stays on the large host
volume rather than the root filesystem.
