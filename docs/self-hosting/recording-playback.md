# Recording playback links

[Self-hosting](README.md)

This scenario adds HTTPS links to a synchronized player over original speaker
tracks. It does not require AI generation. Original audio remains private;
access is granted by possession of the generated link. Treat those links as
private and share them only with intended listeners.

## 1. Configure the signing key and public origin

Generate an independent secret with at least 32 random bytes. Store it as
`secrets/platform/recording-playback-signing-secret`, owner `10001:10001`, mode
`0400`. In `/secure/botik.env`:

```dotenv
RECORDING_PLAYBACK_PUBLIC_BASE_URL=https://recordings.example.com
RECORDING_PLAYBACK_SIGNING_SECRET_FILE=/run/secrets/recording-playback-signing-secret
```

The public value is an HTTPS origin, without a path. Set both values together.
The private S3 bucket does not become public. Rotating this signing key revokes
existing links; back it up with deployment credentials.

## 2. Route HTTPS to the player

For the base deployment, reuse its existing Caddy edge. Point
`recordings.example.com` at the same server as your speech hostname, then copy
the source configuration outside Git:

```sh
sudo install -m 0444 infra/deployment/voicetext-gateway.Caddyfile /secure/botik-public.Caddyfile
```

As the deployment operator, edit that external file with elevated privileges.
Keep its existing global block and VoiceText site unchanged and **append**:

```caddyfile
recordings.example.com {
    handle /recordings/* {
        reverse_proxy meeting-platform:4310
    }
    handle {
        respond 404
    }
}
```

Save this external override as `/secure/botik-recordings.yaml`:

```yaml
services:
  voicetext-edge:
    volumes:
      - /secure/botik-public.Caddyfile:/etc/caddy/Caddyfile:ro
```

Compose replaces the original mount at that container target. This edge is
already on Platform's private network and owns ports 80/443. It retains speech
routing and certificate storage and obtains a certificate for the additional
recording hostname. Caddy forwards Range and cookie headers without stripping
the recording path. Keep `/v1/`, `/metrics`, `/readyz` and Craig ingress private;
do not publish Platform port 4310 or the private S3 endpoint.

After source upgrades, compare the copied Caddy configuration with the new
repository version and carry forward any speech-route changes. Do not silently
retain obsolete gateway routes. The custom recording site does not enable
access logging; avoid logging recording credentials or private URLs in any
additional proxy layer.

If your HTTPS proxy belongs to another Compose project, the repository includes
[a narrow recording edge](../../infra/deployment/compose.recording-edge.yaml).
It requires `PUBLIC_EDGE_NETWORK` and the exact existing
`MEETING_INTERNAL_NETWORK`, and forwards only recording routes. That overlay
marks the internal network external: do not blindly append it to the base
project because that changes network ownership. A separate edge deployment and
its verified build context need deliberate integration; the repository does not
provide a complete standalone edge launcher. Use the direct same-network proxy
route above unless you have supplied that integration.

## 3. Redeploy and verify

For the base stack plus player, run:

```sh
node infra/deployment/run-verified-compose.mjs --env-file /secure/botik.env -- \
  -f infra/deployment/compose.yaml \
  -f infra/deployment/compose.craig.yaml \
  -f infra/deployment/compose.voicetext-gateway.yaml \
  -f /secure/botik-recordings.yaml \
  up --build --detach --wait
```

If summaries or voice are already enabled, retain their overlays/profiles too
and append this recording override. Finish a new synthetic meeting. Check the final Discord result for a
recording link, open it in a browser and verify:

- it reaches HTTPS with a valid certificate;
- the player reports readiness and plays the expected speaker tracks;
- seeking works, including a later point in the fixture;
- unrelated internal routes remain unavailable through the public proxy.

A recording can be `processing`, `ready` or `unavailable`; unavailable playback
must not erase the transcript or original. Do not infer ready audio from a
published link alone. The fragment secret is exchanged for a scoped HttpOnly
cookie; preserve the original complete link rather than copying only its path.

## Disable links

Clear both playback environment values and redeploy. Disabling publication of
new links is not a substitute for revoking old access: rotate the signing secret
or remove public routing when revocation is intended. Never delete original
recordings just to disable the player.
