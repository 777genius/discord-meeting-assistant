# Install the base stack

[Self-hosting](README.md) · Next: [Discord setup](discord.md)

This scenario installs recording, final transcription and Discord publication.
AI generation, voice answers, meeting memory and recording links stay disabled.
Commands below target a Linux server and are run from the repository root unless
stated otherwise. Use a dedicated checkout and data directory for this deployment.

## 1. Prepare the server

You need Git, Node.js `24.18.0` (the supported major is 24), Docker Engine with
Compose `2.24.4+`, and Buildx `0.28.0+`. The build uses pinned Git sources and
container digests from the repository. It needs outbound access to source and
package registries; running the bot needs access to Discord and your providers.
There is no published binary/container release assumed by this guide.
See the [measured fresh installation](verified-install.md) for one observed
build time, memory peak, recording size and speech-provider usage.

```sh
node --version
docker version
docker compose version
docker buildx version
```

Allocate persistent storage for recordings and databases. There is no measured
universal minimum server size: the Platform and speech gateway each default to
a 2 GiB memory limit, with databases, Redis, object storage and builds requiring
additional memory and disk. Do not treat a 2 GiB VM as sufficient for the stack.
Keep Platform at one replica; live ingress does not support horizontal scaling.

Point a DNS hostname, for example `voice.example.com`, at this server. The base
Caddy edge binds TCP 80/443 and UDP 443 and obtains TLS certificates. Those ports
must be available; an existing proxy already using them requires an explicitly
integrated proxy configuration, not starting a second listener on the same ports.
Do not publish PostgreSQL, Redis, S3 or Platform's internal port 4310.

## 2. Clone and pin your deployment

```sh
git clone https://github.com/777genius/discord-meeting-assistant.git
cd discord-meeting-assistant
git rev-parse HEAD
git status --porcelain
```

Record the full commit ID. `git status --porcelain` must be empty before a build.
Keep credentials, data, deployment overrides and your environment file outside
the checkout. Do not remove somebody else's changes to obtain a clean tree;
use a new deployment clone instead.

## 3. Create applications and credentials

Follow [Discord applications](discord.md#1-create-two-applications) to obtain two
distinct application IDs and bot tokens. Obtain a speech-provider key. Start with
Deepgram, or follow the [ElevenLabs scenario](transcription.md#elevenlabs-only).

Follow [Storage and secrets](storage-and-secrets.md) completely before startup.
That page lists every required directory, file, owner and credential relationship.
Do not let Docker silently create missing secret-file paths as directories.

## 4. Create the deployment environment

Create `/secure` if needed and copy the template as the deployment operator:

```sh
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" /secure
install -m 0600 infra/deployment/.env.example /secure/botik.env
```

Edit `/secure/botik.env`. Replace these entries, keeping each only once:

```dotenv
DEPLOY_ROOT=/srv/discord-meeting-assistant
MEETING_PLATFORM_SOURCE_REVISION=FULL_40_CHARACTER_COMMIT_FROM_GIT
DISCORD_PUBLICATION_APPLICATION_ID=YOUR_PUBLICATION_APPLICATION_ID
DISCORD_CRAIG_APPLICATION_ID=YOUR_CRAIG_APPLICATION_ID
DISCORD_RESULTS_CHANNEL_ID=YOUR_RESULTS_CHANNEL_ID
VOICETEXT_PUBLIC_HOST=voice.example.com
SUMMARY_PROVIDER=transcript-outline
VOICETEXT_BATCH_PROFILE=deepgram-nova-3
VOICETEXT_LIVE_PROFILE=deepgram-nova-3
VOICETEXT_LIVE_ENABLED=false
```

The revision and two application IDs must be unquoted literals, not shell
expressions such as `$(git rev-parse HEAD)`. The wrapper validates them directly.
Keep the other template defaults for the first run. Provider keys belong in
mounted files, not this environment file. The shell environment can override
many Compose values: use a clean operator shell without stale Botik variables.

## 5. Build and start

From the clean checkout, run:

```sh
node infra/deployment/run-verified-compose.mjs --env-file /secure/botik.env -- \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.craig.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml \
  up --build --detach --wait
```

The wrapper verifies the checkout, source revisions and bot identities, creates
an exact Git-based build context, then builds and starts Compose. Migrations and
bucket bootstrap run before Platform. It removes the temporary build context
on completion. Do not replace this with a direct `docker compose build`.

This starts services; it does not prove that provider billing, bot permissions
or actual transcription work. Complete the first-meeting check below.

## 6. Check startup

For inspection commands, supply the source-tree variable that the build wrapper
normally supplies internally. In the same shell, define this helper:

```sh
export MEETING_PLATFORM_SOURCE_TREE="$(git rev-parse 'HEAD^{tree}')"
botik_compose() {
  docker compose --env-file /secure/botik.env \
    -f infra/deployment/compose.yaml \
    -f infra/deployment/compose.craig.yaml \
    -f infra/deployment/compose.voicetext-gateway.yaml "$@"
}
botik_compose ps --all
botik_compose logs --tail 100 postgres-migrations craig-migrations object-storage-bootstrap
```

Long-running services should be healthy. Migrations and object bootstrap are
one-shot services: successful exit 0 is expected. Investigate nonzero exits and
restarts before proceeding. Logs can contain meeting data; inspect locally and
redact before sharing. Use [Troubleshooting](troubleshooting.md) for common causes.

Finally, [install both bots and verify a first meeting](discord.md).
