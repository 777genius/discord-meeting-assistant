# OSS VoiceText meeting topology

This is the clean-checkout ownership contract for the self-hosted recording and
transcription path. Its core is Discord, a user-owned Craig voice gateway,
Meeting Platform, PostgreSQL, Redis, object storage, and the separately pinned
OSS VoiceText gateway. It has no private VoiceText SaaS, Infinity Context,
subscription-runtime, or Pipecat dependency.

## Version and identity prerequisites

Craig is an explicit versioned prerequisite because this repository does not
publish a Craig image. Build a user-owned Craig checkout at an immutable commit
and retain its source revision and image digest. It must implement lifecycle
contract `craig-lifecycle-v3` and reproduce the consumer-pinned bundle:

- checksum-manifest SHA-256
  `43b58c2661b22039fa432199227318b0d91fbbe1faa669bc0e62a68ddff8f940`;
- bundle-file SHA-256
  `9ecdba8ebe3dd7e5ca4d67be0d540a66d07c3a66e0536dcd9c929099249f72a9`;
- authoritative-track upload v1 and voice-packet batch v1 from
  `@discord-meeting/craig-gateway-contracts` in this checkout.

Do not substitute the public Craig bot or an unversioned image. Create two
official Discord applications in the Developer Portal: one user-owned Craig
voice bot and one Meeting Platform publication bot. Enable only the intents
their documented routes need, install them into a private guild owned by the
operator, and use test-only channels and synthetic identities for smoke/E2E.
Never use a user token, self-bot, public guild, or a real user project.

## Custody and network topology

PostgreSQL is authoritative for meeting state; SeaweedFS S3 stores derived
recording artifacts; Craig's original multitrack recording remains separately
authoritative. Redis is a durable work queue, not evidence. Persist all four
under one operator-owned `DEPLOY_ROOT`, back them up independently, and never
delete the Craig original after a transcription or publication failure.

Caddy owns public TLS for the OSS VoiceText origin. Only its exact health,
batch, and WebSocket paths route inward; all other paths return 404. Craig and
Meeting Platform communicate only on the internal network with their shared
Craig bearer. Discord bot tokens are separate files. The VoiceText machine
token is one shared file mounted read-only into Meeting Platform and the OSS
gateway. PostgreSQL URLs, S3 keys, Redis URL, Discord tokens, Craig bearer, and
provider API keys are regular non-symlink secret files, mode `0400`, held by the
UID that reads them. Provider keys mount only into the OSS gateway.

The VoiceText gateway source ref and exact 40/64-character commit are mandatory
BuildKit checksum inputs. DNS and ACME state belong to the operator. For an
offline source build, mirror the exact Git objects and retain the same ref and
commit check. See [voicetext-gateway.md](voicetext-gateway.md) for exact paths.

## Core and optional services

Core meeting evidence is Craig recording plus final VoiceText transcription.
The default `transcript-outline` summary reports only the authoritative turn
count and attaches the transcript; it infers no decisions, actions, or topics
and needs no generation provider. Discord live captions are derived and off by
default (`VOICETEXT_LIVE_ENABLED=false`). Infinity Context (historical memory),
subscription-runtime (hosted generation through
`compose.hosted-summary.yaml --profile hosted-summary`), Pipecat/TTS
(conversation), Speaches (alternate STT), and recording playback are non-core
profiles. Keep them off for this topology. Pipecat remains future-only here.

## One safe `up -> ready -> synthetic smoke` path

From a clean checkout, copy `.env.example` outside Git, fill immutable source
revisions and IDs, provision the files above, and pin the Craig and gateway
images. First render without starting containers:

```sh
docker compose --env-file /secure/oss-meeting.env \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml config
```

Bring up the operator-pinned Craig prerequisite and the rendered core stack,
then wait for both readiness endpoints:

```sh
docker compose --env-file /secure/oss-meeting.env \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml up -d
curl --fail --silent https://voice.example.com/health/ready
docker compose --env-file /secure/oss-meeting.env \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml \
  exec -T meeting-platform node -e \
  "fetch('http://127.0.0.1:4310/readyz').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
```

Do not join Discord for the smoke. Run the providerless, unauthenticated
cross-head fixture against the deployed origin; it checks health routing,
authentication rejection, and the closed 404 fallback without audio, provider,
Discord, or live side effects:

```sh
VOICETEXT_GATEWAY_BLACK_BOX_ORIGIN=https://voice.example.com \
VOICETEXT_CADDY_BIN=/usr/local/bin/caddy \
pnpm --filter @discord-meeting/voicetext-adapter run test:gateway-exact-head
```

Only after this smoke passes may an operator schedule the separate private-guild
qualification with official test bots, synthetic Ogg/Opus fixtures, test-only
provider keys, and retained exact image/source evidence. That campaign is not a
startup probe and is never part of the safe default workflow.
