# Isolated host deployment

This Compose project is isolated under one explicit `DEPLOY_ROOT`, uses unique
networks and service names, publishes no host ports, and never mounts another
project's mutable runtime directory. Craig joins `discord-meeting-internal` and
posts authenticated ingress traffic to `http://meeting-platform:4310`.

All files below `${DEPLOY_ROOT}/secrets` and the copied subscription auth slot
must be regular, non-symlink files owned by container UID `10001` with mode
`0400`. Persistent service data stays on the large host volume rather than the
root filesystem.
