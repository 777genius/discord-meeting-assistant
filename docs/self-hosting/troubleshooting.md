# Troubleshooting

[Self-hosting](README.md) · [Operations](operations.md)

Start with `botik_compose ps --all` and the relevant service's bounded logs. The
helper is in [Installation](installation.md#6-check-startup); extend its file
list and profiles when optional services are enabled. Inspect logs locally and
remove credentials, private transcript text and recording links before sharing.

| Symptom | Check | Next action |
| --- | --- | --- |
| Wrapper rejects dirty checkout | `git status --porcelain` | Put configuration outside Git; deploy from a clean clone instead of deleting work |
| Revision/application identity rejected | `MEETING_PLATFORM_SOURCE_REVISION`, `DISCORD_PUBLICATION_APPLICATION_ID`, `DISCORD_CRAIG_APPLICATION_ID` in `/secure/botik.env` | Set the checkout's full HEAD and two distinct numeric application IDs, once each and unquoted |
| Compose says source tree is missing during inspection | `MEETING_PLATFORM_SOURCE_TREE` in the inspection shell | Use the helper; builds must still go through the verified wrapper |
| Port 80/443 already allocated | Existing host proxy/listeners | Integrate the intended proxy; do not start competing edges |
| TLS/edge never healthy | Public DNS, port reachability, `voicetext-edge` logs | Correct DNS/routing and certificate access; do not disable TLS validation |
| Secret is a directory / permission denied | Host path type, numeric owner and parent traversal | Correct mounts using the storage table before restart; do not make secrets world-readable |
| Database authentication fails | Password file and corresponding URL | Make values agree; changing a bootstrap password file does not rotate an existing DB role |
| Redis not ready | Password agreement and runtime persistence settings | Preserve AOF and `noeviction`; investigate memory pressure instead of enabling eviction |
| Platform waits for migrations/bootstrap | One-shot exit status and logs | Repair the specific failure; do not start an old binary against an incompatible migrated schema |
| Bot online, setup command missing | Correct publication app, guild install and command scope | Recheck its generated install URL and administrator permissions |
| Craig does not record | Channel selection, channel overrides, both bots online | Re-run setup as Manage Server; bot-only fixtures require explicit test actor configuration |
| Provider returns unauthorized or quota errors | Selected profile's key file and provider account | Correct credentials/billing; no automatic provider fallback is promised |
| Final transcription works, captions absent | `VOICETEXT_LIVE_ENABLED`, live selector and credentials | Enable live explicitly and redeploy; batch and live settings are independent |
| Final output has only turn count | `SUMMARY_PROVIDER` and overlay/profile | Expected base output; follow the complete AI-summary setup |
| Summary runtime unhealthy | Package version, launcher digest, auth-pool readability, service token | Follow runtime prerequisites; do not disable attestation or expose the sidecar publicly |
| Voice answer text exists but no audio | Craig playback override, runtime token, ElevenLabs voice/cues | Follow the voice guide; base Craig playback is hardcoded off |
| Recording link missing or unavailable | Playback URL/key pair, track readiness and proxy routes | Follow the playback guide; retain originals while diagnosing |
| Memory returns no usable answer | Serving rollout, qualification, scope and provider capabilities | Check memory restrictions; an index count does not prove serving readiness |

## What to include in a bug report

Include the deployed Git SHA, image revision, scenario, provider profile (not
key), relevant service status, sanitized error and approximate time. Describe
expected and actual behavior. Use a synthetic reproducible example when possible.
Do not attach `.env`, secret files, auth pools, raw user recordings or full private
logs. The [acceptance record](../../infra/deployment/oss-acceptance.md) helps
separate qualified behavior from optional or unqualified configurations.
