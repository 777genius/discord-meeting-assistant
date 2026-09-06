# OSS Discord STT native evidence collection

Owner: `apps/discord-e2e-actors` qualification, Voicetext adapter native session
capture, and Meeting Platform composition/post-call taps. Hosted V10 is unchanged.
This is private, unreviewed integration. No live collection, provider/Discord call,
service change, secret access, queue replay or campaign PASS was performed here.
Root must integrate and obtain a separate physically read-only review before use.

## Supported sources and remaining external source

The opt-in native journal captures every attempted live session before connecting,
including failures; parsed ready/ack/partial/final/finalize_complete/error/close;
actual packet SHA-256, TOC, sequence, identity and source time; accepted send
ordering; sent finalize count; and actual emitted transcript/source timestamps.
The native post-call journal captures starts and successful/failed returns from
transcription, summary and publication ports. Neither journal receives transport
configuration, secrets, URLs or audio bytes. Errors retain occurrence, not bodies.
The live journal is bounded to 256 MiB and the stage journal to 1 MiB. Both are
exclusive-create, append-only and fsynced per row. Incomplete/truncated capture
cannot qualify. Graceful shutdown seals after successful ingress/live/post-call
drains; a crash, timeout or active session leaves no qualifying complete capture.
Default behavior is unchanged when capture is disabled.

Read-only commands collect exact image/source identities, public TLS CA and
configuration digests, initial/final whole-project inventory, native schema-6
completion, accepted database transcript, finalized live ledger, immutable object
versions/bytes and independent Discord publication observations. SQL executes in
read-only transactions with statement timeouts. Object GET reuses the existing
version/metadata/size/checksum implementation. Discord collection reuses the
existing projection reader, checks exact-one final marker/message/official author,
and downloads both full attachments. Only raw attachment digests and complete
visible text with URLs removed are retained: playback capabilities and signed CDN
URLs never enter the evidence. Two observations establish stability, not replay
idempotency. **Never run `collect:e2e`: it invokes BullMQ replay.**

The pinned Craig aggregate original-source checksum algorithm is absent from this
checkout. `originals` implements the documented authoritative manifest contract
and recomputes each retained original's SHA-256/size, but marks the manifest's
aggregate checksum **declared**, never recomputed. The exact read-only source root
needed is:

`/mnt/volume_ams3_1784742570542/vtoss-astra-y-20260905/readonly/craig-37b86a958b567cb7fcff75946e94fe5e7ee38f42`

It must contain the producer source at `37b86a958b567cb7fcff75946e94fe5e7ee38f42`,
including the original-source checksum implementation used by
`recording.authoritative_ready`. No producer changes, new hash format, signature,
or operator PASS assertion is requested. Until this source is supplied and the
aggregate calculation is connected, native archives remain `sources-unverified`
and `qualify` exits nonzero without a receipt. All other native source checks run;
per-file checksums never substitute for the missing aggregate computation.

## Exact target and configuration

Use the existing isolated project `vtoss-test-oss-8f49a06-r1`; no public guild,
user account, self-bot, real-user project or non-test data. Platform's
`e2e.test-only=true` label admits the deployment; other source containers must
belong to the exact same project/service and be healthy. Discovery requires
exactly one `meeting-platform`, `craig-bot`, `voicetext-gateway` and `postgres`.
All image source labels must match the exact plan revisions. Keep the ten-service
isolation, existing TLS/CA mounts and readiness marker. The plan must name the
reviewed Platform integration revision, not the previous baseline.

| Identity | Exact value |
| --- | --- |
| Guild | `1533228590643155034` |
| Voice channel | `1533228823045214398` |
| Results channel | `1533228891827736657` |
| Recorder | `1533877611258708230` |
| Publication application | `1533224474609057793` |
| Actor A / B applications | `1533227577286852649` / `1533228054724346087` |
| Craig revision | `37b86a958b567cb7fcff75946e94fe5e7ee38f42` |
| OSS gateway revision | `c5eb287cc3ea567d67a2a9e6260ed8cf86841a7d` |
| Fixture manifest SHA-256 | `6ecf3ae9570937da48465bab1d87563c47c0e1b3c1ef46191c0143c3fad3ff79` |

Create an external `oss-discord-stt-plan-v1` JSON conforming to
`src/oss-campaign-profile.ts`: `campaignId`, exact `collectorRevision`, `target`
with the identities above, project/testOnly/service names, exact
`platformRevision`, Craig/gateway revisions, actual OSS TLS `gatewayEndpoint`,
public `operatorCaSha256`, `summaryProvider:"transcript-outline"`,
`conversationEnabled:false`, `liveEnabled:true`; and these ordered `runs`:

| runId | scenario | Speaker B delay |
| --- | --- | ---: |
| oss-r1-sequential | sequential | 3500 ms |
| oss-r1-overlap | overlap | 750 ms |
| oss-r1-reconnect | reconnect | 750 ms |

Configure the reviewed Platform process explicitly, with a fresh writable evidence
mount containing neither journal filename:

```sh
OSS_STT_NATIVE_EVIDENCE_DIRECTORY=/evidence/oss-stt
OSS_STT_NATIVE_EVIDENCE_PROJECT=vtoss-test-oss-8f49a06-r1
OSS_STT_NATIVE_EVIDENCE_REVISION=EXACT_REVIEWED_PLATFORM_REVISION
E2E_TEST_ONLY_LABEL=true
CONVERSATION_ENABLED=false
SUMMARY_PROVIDER=transcript-outline
VOICETEXT_LIVE_ENABLED=true
```

The existing Compose file does not forward the new capture variables. Root must
add this TEST-only override to the reviewed deployment command (alongside all
existing isolation/TLS overlays); exporting variables alone is insufficient:

```yaml
services:
  meeting-platform:
    environment:
      E2E_TEST_ONLY_LABEL: "true"
      OSS_STT_NATIVE_EVIDENCE_DIRECTORY: /evidence/oss-stt
      OSS_STT_NATIVE_EVIDENCE_PROJECT: vtoss-test-oss-8f49a06-r1
      OSS_STT_NATIVE_EVIDENCE_REVISION: ${MEETING_PLATFORM_SOURCE_REVISION:?exact reviewed revision}
    volumes:
      - ${OSS_CAPTURE_HOST_DIRECTORY:?fresh capture directory}:/evidence/oss-stt
```

Set `VOICETEXT_WS_URL` to the plan endpoint and `NODE_EXTRA_CA_CERTS` to the mounted
public CA. Set `DISCORD_LEGACY_GUILD_ID`, `DISCORD_LEGACY_VOICE_CHANNEL_ID`,
`DISCORD_RESULTS_CHANNEL_ID`, `DISCORD_APPLICATION_ID` to the exact plan values.
Craig's overlay maps `CRAIG_AUTO_RECORD_CHANNEL_IDS` and
`CRAIG_SYNTHETIC_BOT_IDS` to its existing recording configuration: use the voice
channel and A/B IDs. Outline summaries intentionally have empty decisions/actions.
Do not enable conversation or repeat unrelated hosted business invariants.

## Root execution after review

Use the pinned tools and avoid installation through readonly dependency caches:

```sh
export PATH="/mnt/volume_ams3_1784742570542/vtoss-astra-y-20260905/tool-cache/node-v24.18.0/bin:/mnt/volume_ams3_1784742570542/vtoss-astra-y-20260905/tool-cache/pnpm-11.18.0-standalone-r1/bin:$PATH"
export pnpm_config_verify_deps_before_run=false
```

On the TEST Docker host, before the first actor starts, run:

```sh
pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-collect-main.ts deployment "$PLAN" before "$OUT/deployment-before.json"
```

Zero initial recordings are mandatory. Arm the existing official `observe:live`
observer before each actor, with `DISCORD_E2E_LIVE_DURATION_MS=600000`, poll interval
2000, the exact results/publication IDs, corresponding run ID, and fresh output.
Its V2 mutation trace is supplementary; the native journal proves packet/session
behavior. The observer starts no packet collector. Use its existing
`src/observe-live-discord.ts` command and official publication credential directory.
Run the official OggOpus actors once per table row, with fresh run/output identity:

```sh
DISCORD_E2E_GUILD_ID=1533228590643155034 \
DISCORD_E2E_VOICE_CHANNEL_ID=1533228823045214398 \
DISCORD_E2E_RECORDER_BOT_ID=1533877611258708230 \
DISCORD_E2E_SECRET_DIRECTORY="$ACTOR_SECRETS" \
DISCORD_E2E_FIXTURE_MANIFEST="$FIXTURES/manifest.v1.json" \
DISCORD_E2E_SPEAKER_A_FIXTURE="$FIXTURES/speaker-a.ru-en.ogg" \
DISCORD_E2E_SPEAKER_B_FIXTURE="$FIXTURES/speaker-b.ru-en.ogg" \
DISCORD_E2E_SCENARIO="$SCENARIO" DISCORD_E2E_SPEAKER_B_DELAY_MS="$DELAY_MS" \
DISCORD_E2E_RUN_ID="$RUN_ID" DISCORD_E2E_ACTOR_RUN_OUTPUT="$OUT/$RUN_ID.actor.json" \
timeout --signal=TERM --kill-after=10s 300s \
  pnpm --filter @discord-meeting/meeting-platform exec tsx ../discord-e2e-actors/src/main.ts
```

Wait for native completion and successful post-call settlement. Collect these two
commands twice with `N=1`, then `N=2`, using fresh outputs. The second publication
observation must finish before starting the next scenario. No retry under the same
run identity; preserve failed captures and originals.

```sh
pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-collect-main.ts snapshot "$PLAN" "$RECORDING_ID" "$OUT/$RUN_ID.snapshot-$N.json"
OSS_STT_PUBLICATION_SECRET_DIRECTORY="$PUBLICATION_SECRETS" \
  pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-collect-main.ts publication "$PLAN" "$OUT/$RUN_ID.snapshot-$N.json" "$OUT/$RUN_ID.publication-$N.json"
pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-collect-main.ts originals "$PLAN" "$MANIFEST" "$READONLY_ORIGINAL_DIRECTORY" "$OUT/$RUN_ID.originals.json"
```

`PUBLICATION_SECRETS/sut` remains private and outside the archive. `MANIFEST` is the
complete immutable manifest returned in the snapshot object collection, decoded
without rewriting JSON. `READONLY_ORIGINAL_DIRECTORY` is this recording's complete
retained Craig original set. Keep originals on Craig; preserve independent readonly
copies for assembly. Do not reconstruct original bytes from packet tees or fixtures.

After all three second observations, collect `deployment "$PLAN" after` to
`deployment-after.json` while the containers remain healthy. Require the same
container/image identities and exactly three project recordings. Then root may
complete the reviewed Platform's graceful shutdown to seal the native journals;
copy both journals read-only into the source archive. No worker performs this step.

## Assembly and verification

Create `oss-native-assembly-v1` JSON with `deploymentPaths` containing the before
and after JSON paths, `livePath`, `postCallPath`, and three ordered `runs`, each
with `runId`, `actorPath`, two `snapshots`, two `publications`, `originalsPath`, and
`originalDirectory`. Every path is relative to `SOURCE_ROOT`, without symlinks or
escapes. The output archive must be nonexistent and separate from the source root.

```sh
pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-collect-main.ts assemble "$PLAN" "$SOURCE_ROOT" "$ASSEMBLY" "$NEW_ARCHIVE"
pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-campaign-main.ts check "$PLAN" "$NEW_ARCHIVE" "$FIXTURES/manifest.v1.json" "$REPORT"
pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-campaign-main.ts verify "$PLAN" "$NEW_ARCHIVE" "$FIXTURES/manifest.v1.json" "$REPORT"
```

Assembly derives normalized runs from native source bytes, never caller-entered
success/timing/session lists. The finite index retains immutable identities and
hashes every artifact, bounded to 1 GiB/10,000 artifacts. `collection.json` is
published last. Verification binds the complete discovered sessions, emitted live
turn IDs, accepted database transcript, stages, recording lifecycle, original
inventory, object versions and both independent publication/database reads. All
three scenarios retain real Opus/current revision/finalize/time/quality checks;
batch success cannot stand in for live success. Legacy archives continue through
the original consistency profile and cannot claim native source coverage.

`check` and `verify` presently report the missing external Craig aggregate source.
`qualify` can write only when every required source capability is satisfied; this
checkout deliberately has no operator override. Synthetic consistency fixtures
are not captured E2E and are tested to remain unable to create a PASS receipt.

## Focused offline validation

Only focused tests/typechecks are required for this patch; no full gates or builds:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors typecheck
pnpm --filter @discord-meeting/voicetext-adapter typecheck
pnpm --filter @discord-meeting/discord-e2e-actors exec vitest run test/oss-*.test.ts --maxWorkers=2 --no-file-parallelism --no-cache
pnpm --filter @discord-meeting/voicetext-adapter exec vitest run test/oss-native-evidence.test.ts test/voicetext-live-finalize-protocol.test.ts test/voicetext-live-transcription-adapter.test.ts --maxWorkers=2 --no-file-parallelism --no-cache
pnpm --filter @discord-meeting/meeting-platform exec vitest run test/oss-native-live-collection.test.ts test/oss-native-post-call-collection.test.ts --maxWorkers=2 --no-file-parallelism --no-cache
```

Capture-to-parser integration tests live in the Platform test root so the actor
package's build root remains unchanged. Test failures, truncation, duplicate or
omitted sessions/stages, metadata changes and unavailable original-source proof
remain disqualifying. Keep dependency-cache symlinks out of the patch.
