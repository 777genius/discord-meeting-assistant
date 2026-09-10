# Storage and secrets

[Self-hosting](README.md) · [Installation](installation.md)

This page provisions a **new** base deployment. Examples use
`/srv/discord-meeting-assistant`. Substitute your own absolute `DEPLOY_ROOT`
consistently. Do not regenerate existing credentials during an upgrade.

## Directory ownership

Create directories before Docker starts. All paths below are relative to
`DEPLOY_ROOT`. Container owners are numeric Linux UID:GID values.

| Directory | Owner | Mode | Purpose |
| --- | --- | --- | --- |
| `data/postgres`, `data/craig/postgres`, `data/voicetext/postgres` | `70:70` | `0700` | PostgreSQL data |
| `data/redis`, `data/craig/redis` | `999:999` | `0700` | Durable queues/runtime state |
| `data/object-storage` | `1000:1000` | `0700` | Private derived artifacts |
| `data/spool`, `data/craig/recordings`, `data/voicetext/spool` | `10001:10001` | `0700` | Platform spool, original recordings, speech spool |
| `data/voicetext/caddy-config`, `data/voicetext/caddy-data` | `10001:10001` | `0700` | Caddy configuration and TLS state |
| `secrets/platform`, `secrets/voicetext/providers` | `10001:10001` | `0700` | Application credentials |
| `secrets`, `secrets/craig`, `secrets/voicetext` | `root:root` | `0711` | Parent paths containing files read by different service owners |
| `config` | deployment operator | `0700` | Non-secret gateway environment file |

Create parent directories with traversal permission, then apply the leaf owners.
For example:

```sh
sudo install -d -m 0755 /srv/discord-meeting-assistant/data
sudo install -d -m 0755 /srv/discord-meeting-assistant/data/craig
sudo install -d -m 0755 /srv/discord-meeting-assistant/data/voicetext
sudo install -d -m 0700 -o 10001 -g 10001 /srv/discord-meeting-assistant/data/spool
```

Repeat `install -d` for every table entry with its stated mode and owner. This
sets permissions on that directory only; do not recursively change all service
data to a single owner. Ensure the deployment root itself is traversable.

## Required secret files

Every file is a regular non-symlink file, mode `0400`. Write only its value and
an optional trailing newline. Paths in this table are relative to `DEPLOY_ROOT`.

| File | Owner | Content |
| --- | --- | --- |
| `secrets/postgres-password` | `70:70` | Platform database password |
| `secrets/platform/postgres-url` | `10001:10001` | `postgresql://meeting:PASSWORD@postgres:5432/meeting` |
| `secrets/craig/postgres-password` | `70:70` | Separate Craig database password |
| `secrets/craig/database-url` | `10001:10001` | `postgresql://craig_meeting:PASSWORD@craig-postgres:5432/craig_meeting` |
| `secrets/voicetext/postgres-password` | `70:70` | Separate VoiceText database password |
| `secrets/voicetext/postgres-url` | `10001:10001` | `postgresql://voicetext:PASSWORD@voicetext-postgres:5432/voicetext` |
| `secrets/redis.conf` | `999:999` | Copy of the repository Redis template with a generated password |
| `secrets/platform/redis-url` | `10001:10001` | `redis://:PASSWORD@redis:6379` with the same Redis password |
| `secrets/s3-config.json` | `1000:1000` | S3 identity JSON shown below |
| `secrets/platform/s3-access-key-id` | `10001:10001` | Access key matching the S3 JSON |
| `secrets/platform/s3-secret-access-key` | `10001:10001` | Secret key matching the S3 JSON |
| `secrets/platform/discord-sut-token` | `10001:10001` | Publication application's Discord bot token |
| `secrets/craig/discord-bot-token` | `10001:10001` | Craig application's different Discord bot token |
| `secrets/platform/craig-bearer-token` | `10001:10001` | Random internal Platform/Craig bearer |
| `secrets/platform/voicetext-service-token` | `10001:10001` | Random internal Platform/VoiceText bearer |
| `secrets/voicetext/providers/deepgram-api-key` | `10001:10001` | Deepgram key, when selected |
| `secrets/voicetext/providers/elevenlabs-api-key` | `10001:10001` | ElevenLabs key, when selected |

Generate independent passwords and bearer tokens with at least 32 random bytes.
Hex encoding (`openssl rand -hex 32`) avoids URL escaping problems. If you use
other password characters, percent-encode the password in URLs. A database's
password file and its corresponding URL must contain the same underlying password.
Internal bearers have no `Bearer ` prefix. The overlays mount the same bearer
file into both ends of each connection; do not create independent tokens for them.

For a **new file**, this Bash pattern prompts without echo or shell-history
exposure. Change the destination and owner for each file. Do not use it to
rotate a running deployment's credentials.

```bash
secret_path=/srv/discord-meeting-assistant/secrets/platform/discord-sut-token
sudo test ! -e "$secret_path" || exit 1
read -r -s -p 'Secret value: ' botik_secret
printf '\n'
printf '%s\n' "$botik_secret" | sudo install -m 0400 -o 10001 -g 10001 /dev/stdin "$secret_path"
unset botik_secret
```

## Redis and private object storage

Copy [redis.conf.example](../../infra/deployment/redis.conf.example) and replace
`REPLACE_WITH_A_GENERATED_SECRET`. Preserve `appendonly yes`,
`appendfsync everysec` and `maxmemory-policy noeviction`. Queue health rejects
unsafe durability/eviction settings. Set owner `999:999`, mode `0400`.

Create `secrets/s3-config.json` using independent generated access and secret
keys. The two Platform S3 files must match these values:

```json
{
  "identities": [{
    "name": "meeting-platform",
    "credentials": [{"accessKey": "GENERATED_ACCESS_KEY", "secretKey": "GENERATED_SECRET_KEY"}],
    "actions": ["Admin", "Read", "Write", "List", "Tagging"]
  }]
}
```

The current Compose stack shares these credentials between bucket bootstrap and
Platform. `Admin` permits bootstrap to create the bucket; normal application
object access does not itself justify administrative access. This is a limitation
of the supplied deployment: a compromised Platform credential has broad access
to this dedicated storage service. Do not reuse it for another project or a
shared S3 service. Separating bootstrap and runtime identities requires separate
secret mounts/environment wiring in an operator overlay and is not achieved by
changing this JSON alone.

This identity belongs to the project's private object-storage service. Do not
publish the S3 port or make the bucket public. `object-storage-bootstrap` creates
`meeting-artifacts`; the application uses the `recordings/` prefix.

## Gateway key paths

Create `config/voicetext-gateway.env`, readable by the deployment operator,
mode `0600`. For Deepgram:

```dotenv
VOICETEXT_DEEPGRAM_API_KEY_FILE=/run/voicetext-provider-secrets/deepgram-api-key
```

For ElevenLabs, use the following line instead; include both lines only when
both providers are configured:

```dotenv
VOICETEXT_ELEVENLABS_API_KEY_FILE=/run/voicetext-provider-secrets/elevenlabs-api-key
```

These are container paths, not host paths. No actual key goes into this file.
Finish by verifying filenames, regular-file status, ownership and permissions
without printing contents. Missing file mounts commonly become directories if
startup is attempted too early.

Back up the secrets together with the databases and original recordings. See
[Operations](operations.md) for coordinated backups and credential changes.
