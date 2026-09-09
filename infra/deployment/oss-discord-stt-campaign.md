# OSS Discord STT native evidence collection

Owner: `apps/discord-e2e-actors` qualification (including `oss-database.ts` and
`oss-trusted-collection.ts`, classified by the existing `e2e.discord-actors`
source root in `architecture/foundation/source-dependencies.yaml`), Voicetext adapter native session
capture, and Meeting Platform composition/post-call taps. Hosted V10 is unchanged.
Historically, root verified independent B0/H0 review and full gates/CI PASS for Discord
`d934481304ea8791462f59261db11827dfc9eb20` and gateway
`550ec217b3b549d7719aaa4a412d9ecbaf0a2f4b` (Discord PR #63, gateway PR #1;
Canary PR #19). The [native provider-fixture qualification](voicetext-gateway.md#implemented-profile-mapping-and-qualification-status)
is separate from trusted Discord campaign acceptance.
Native WER/CER thresholds remain 0.35/0.25; this Discord campaign requires
0.35/0.20. Never relax the Discord thresholds to promote native results.

## Supported sources

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

The original aggregate algorithm was traced in the historical root-verified Craig producer
`37b86a958b567cb7fcff75946e94fe5e7ee38f42`,
`apps/bot/src/modules/recorder/meetingIntegration.ts`, source SHA-256
`a62f880010cc14a76972309ba61b710eec96d49cb46f7cd8064bba029e989f2a`.
Source context (`.craig-context`) is read-only and must never be staged.
That historical source-proof location is not a runtime producer pin. Original
collection and sealed manifest/completion provenance require exactly
`7776b698f6bec26eff52cd383f4e5a7f3f429f42`, matching the current Craig pin in
`source-pins.json`; old or arbitrary producer revisions remain rejected.
Preparation and outbox parsing require exactly `data,header1,header2,users,info,log`;
none is optional (the tolerant info clientId reader does not change preparation).
Present zero-byte sidecars are retained and hashed; empty does not mean missing.
Names are exactly `recordingId.ogg.kind`. Every byte checksum and size is recomputed,
then SHA-256 covers UTF-8 `JSON.stringify` of that ordered array, with object insertion
keys `kind,relativePath,checksumSha256,sizeBytes`. Sorted-key JSON is incorrect.
The result must equal the independently fetched immutable manifest's
`source.checksumSha256`. New collection emits `oss-native-craig-originals-v2`,
without a prepared-job path or bytes. Craig deletes that job immediately after
acknowledged delivery; collection never polls, reconstructs or retains it.
Manifest locator, immutable version, byte size and hash must match native completion
and the authoritative database. V3 consistent sealed actor provenance and the pinned
producer capability/revision are mandatory. Completion event digests establish
consistency only; they are not full event payload evidence.
Missing, duplicate or aliased originals and changed bytes fail closed. The opened
runtime source inode must be regular, singly linked, bounded and contained before
copying. Final verification rehashes all six archive files independently. Legacy
v1 decoding still requires its original job proof; missing-job v1 collections remain
`sources-unverified` and are never silently upgraded.

## Locate and interpret a trusted receipt

Use the final task run report retained in the main goal plan and linked from the
PR description to locate the exact campaign ID, plan, fixture manifest, archive,
original trusted collector output and create-only PASS receipt. These are retained
operator artifacts, not files generated by this quickstart. If that report has no
trusted receipt for the intended campaign, qualification is not established;
successful live sessions, transcripts or native checks alone cannot supply it.

Require receipt kind `oss-discord-stt-trusted-pass-v1`, status `passed` and origin
`root-runtime-collection`, together with the original collector's trusted custody.
Cross-check its evidence and inventory against the campaign plan and retained
archive using the [verification procedure](#assembly-and-verification). Check the
campaign/run IDs, fixture digest, sequential/overlap/reconnect coverage, actual
batch/live provider and model identities, quality thresholds and original recording
inventory. Claim only the profile pairs, fixture/language scope and scenarios
supported by those bytes; historical native results do not qualify Discord.

Read `collectorRevision` as the original collector implementation and
`target.platformRevision` as the separately observed Platform source revision.
Compare the retained before/after deployment observations, immutable image IDs or
digests and source labels for Platform, Craig and gateway with the intended
deployment. A matching tag, later documentation commit or matching subset of
compiled files does not establish whole-image equality or extend qualification.
Retain the exact verifier checkout revision with each verification result in the
run report. Replay with the original reviewed verifier for reproducibility; any
later verifier or schema compatibility assessment must identify its own revision
and scope without rewriting the original receipt or collector identity. Offline
replay returns `sources-unverified` even when consistency is complete: it checks
bytes, not original custody, and cannot promote a failed collection to PASS.

## Exact target and configuration

Before actors join, verify the actual Platform active room route includes the admitted
guild, voice channel and results channel. Craig's static environment allowlist is
overridden by authoritative empty Platform configuration; static values alone do
not admit a room. Run external qualification only with separate authorization.

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
| Collector revision (`collectorRevision`) | Exact reviewed collector checkout used for this campaign |
| Platform revision (`target.platformRevision`) | Independently observed source revision of the campaign Platform image |
| Craig revision | `7776b698f6bec26eff52cd383f4e5a7f3f429f42` |
| OSS gateway revision | `3e0ede3ec9086a45bc026f43191a998f2682fd6e` |
| Fixture manifest SHA-256 | `53e57343c1c3245a60cfde4df6b688ac997fd91133e6d3691ba056932c87362a` |

Keep collector and deployed Platform revisions separate in the plan. Resolve
Craig and gateway pins from [source-pins.json](source-pins.json) and the reviewed
Compose configuration, then independently observe running source labels and
immutable image identities before execution. The table is configuration guidance,
not deployment attestation. Keep the historical canary pin unchanged.

Create an external `oss-discord-stt-plan-v1` JSON conforming to
`src/oss-campaign-profile.ts`: `campaignId`, exact `collectorRevision`, `target`
with the identities above, project/testOnly/service names, exact
`platformRevision`, Craig/gateway revisions, actual OSS TLS `gatewayEndpoint`,
public `operatorCaSha256`, `summaryProvider:"transcript-outline"`,
`conversationEnabled:false`, `liveEnabled:true`; and these ordered `runs`:

Each strict plan run contains only `runId` and `scenario`. Actor application IDs
and Speaker B delay belong to root orchestration, not the plan's run or target
objects. The delay column below is orchestration configuration only.

| runId | scenario | Speaker B delay (orchestration only) |
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

The pinned Craig deployment renderer defaults to lifecycle v1. Its old real
manifest `schemaVersion: 1` and completion `lifecycleSchemaVersion: 1` correctly
fail the sealed-v3 collector. The pinned Craig revision already supports this
node-config override; root must include it in the isolated TEST-only Compose
overlay for a fresh campaign after source approval:

```yaml
services:
  craig-bot:
    environment:
      NODE_CONFIG: >-
        {"dexare":{"craig":{"meetingIntegration":{"lifecycleProducer":{
          "schemaVersion":3,
          "actorSemanticsVersion":1,
          "producerCapabilityId":"meeting.lifecycle.sealed-actor-roster.v1",
          "producerRevision":"7776b698f6bec26eff52cd383f4e5a7f3f429f42",
          "e2eTestOnly":true,
          "e2eSyntheticHumanActorIds":["1533227577286852649","1533228054724346087"]
        }}}}}
```

These IDs remain official synthetic bot identities. This explicit E2E policy
exercises human classification only in the private test guild; never use it for
customer data, real user accounts, or self-bots. Before actors join, verify the
effective nonsecret `dexare.craig.meetingIntegration.lifecycleProducer` config
matches every value above through the actual config loader and pinned lifecycle
parser. Retain only that nonsecret subtree, never the full generated config.
After each fresh recording, require manifest `schemaVersion: 3`, completion
`lifecycleSchemaVersion: 3`, and a sealed, consistent actor roster with the pinned
producer provenance. Never relabel or fabricate an upgrade of old v1 receipts.
Discord acceptance requires the complete trusted receipt for that campaign.

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

For campaign PASS, the trusted root orchestrator must start one collector process
before any actor runs. Keep it alive through all three scenarios and journal sealing.
The collector independently reads Docker identities/configuration, empty initial
whole-project database inventory, and the initial capture headers. It discovers
journal and original directories from the exact running containers' bind mounts:
`/evidence/oss-stt` on Platform and `/app/rec` on Craig. Arbitrary copied archives,
sidecar declarations, caller flags and injected runtime adapters cannot admit PASS.

```sh
OSS_STT_PUBLICATION_SECRET_DIRECTORY="$PUBLICATION_SECRETS" \
  pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-collect-main.ts trusted-collect \
  "$PLAN" "$FIXTURES/manifest.v1.json" "$NEW_SOURCES" "$NEW_ARCHIVE" "$PASS_RECEIPT"
```

Run this command with a private root-owned stdin pipe (or interactively). Wait for
its `armed` JSON event before starting the first actor. Root controls the official
actor processes separately using the commands below; the collector performs no
actor, provider, replay, shutdown or container mutation. Each stdin line is only
a request to independently read current sources, never a source attestation.
The finite control sequence has three JSON lines and a final `sealed` line, with
a one-hour deadline. EOF, failed reads, wrong identities or incomplete evidence
leave no PASS and retain diagnostics/source files.

Zero initial recordings are mandatory. Start the existing official `observe:live`
observer before each actor, with `DISCORD_E2E_LIVE_DURATION_MS=600000`, poll interval
2000, the exact results/publication IDs, corresponding run ID, and fresh output.
The observer has no `armed` event or readiness receipt; do not wait for or invent
one. The collector's `armed` event remains mandatory before the first actor.
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

Wait for native completion and successful post-call settlement, then send one
JSON line to the running collector's stdin, using that scenario's exact `runId`:

```json
{"runId":"oss-r1-sequential","recordingId":"ACTUAL_RECORDING_ID","actorPath":"/absolute/root-owned/actor-output.json"}
```

`actorPath` is supplemental fixture/timing evidence from root's official actor
orchestrator. The collector reads all six `${recordingId}.ogg.kind` files from the
independently discovered Craig recordings bind mount and applies the pinned checksum
algorithm against the durable manifest commitment.
It performs two independent DB/object/Discord observations itself. Wait for its
`settled` event before starting the next scenario, and repeat for overlap and
reconnect. No retry under the same run identity; preserve failed captures and
originals. `PUBLICATION_SECRETS/sut` stays private and outside the archive.

After the third `settled` event, wait for `awaiting-seal`. At this point the
collector has independently checked the final three-recording inventory and
unchanged healthy container/image/configuration/mount identities. Root can now
perform the separately reviewed graceful Platform stop to seal the journals.
Send the literal line `sealed` only when shutdown/drain finishes. The collector
reads the sealed journals from the previously discovered runtime mount and
checks that their initial bytes are unchanged. Full native parsing verifies the
seal and entire capture, not the root's control word.

Assembly consumes collector-owned retained bytes in memory. Admission loads and
checks the resulting complete archive inventory against the inventory derived
from those bytes, runs all native/quality/original checks, then writes exactly one
create-only `oss-discord-stt-trusted-pass-v1` receipt. There is no exported claim
minting function, signing key, self-signing file or resume-from-archive admission.
Failed/interrupted collection requires a fresh isolated campaign, not receipt
promotion. Root and its orchestrator/Docker authority are trusted; this boundary
does not claim to protect against malicious root controlling containers or code.

The individual `deployment`, `snapshot`, `publication`, `originals` and `assemble`
commands remain useful for retained diagnostic/replay collections. Their outputs
alone never authorize the trusted receipt.

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

Offline `check` always returns `status:"sources-unverified"`. Its independent
`consistency:"complete"` field means all retained source-capability checks passed;
it is not evidence of origin. Offline `qualify` always refuses to write PASS,
including for fabricated archives with valid schemas and recomputed hashes.
Only the complete `trusted-collect` invocation above creates a trusted PASS.

A retained trusted receipt can be replay-checked with:

```sh
pnpm --filter @discord-meeting/meeting-platform exec tsx \
  ../discord-e2e-actors/src/oss-campaign-main.ts verify \
  "$PLAN" "$NEW_ARCHIVE" "$FIXTURES/manifest.v1.json" "$PASS_RECEIPT"
```

Replay rechecks all bytes and the complete receipt inventory, while still returning
`sources-unverified`: it cannot reauthenticate the receipt's original custody from
files alone. Keep the original trusted process output/receipt under root custody.
Offline fixtures never emit the same PASS receipt as trusted collection. The
reviewed integration does not substitute for a trusted real campaign receipt.

The OSS-specific database parser preserves numeric `snapshot.transcript.version`
and `snapshot.transcript.recordingId`; the latter must match the recording. The
meeting's numeric CAS `snapshot.revision` remains separate. Archive runs encode
the actual transcript version as a string for compatibility with the existing run
schema. Missing or mismatched authoritative transcript fields fail closed.

## Focused offline validation

For changes to native collection, these focused offline checks cover the capture
and parser boundary; they do not establish external qualification:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors typecheck
pnpm --filter @discord-meeting/voicetext-adapter typecheck
pnpm --filter @discord-meeting/discord-e2e-actors exec vitest run test/oss-*.test.ts --maxWorkers=2 --no-file-parallelism --no-cache
pnpm --filter @discord-meeting/voicetext-adapter exec vitest run test/oss-native-evidence.test.ts test/voicetext-live-finalize-protocol.test.ts test/voicetext-live-transcription-adapter.test.ts --maxWorkers=2 --no-file-parallelism --no-cache
pnpm --filter @discord-meeting/meeting-platform exec vitest run test/oss-native-live-collection.test.ts test/oss-native-post-call-collection.test.ts --maxWorkers=2 --no-file-parallelism --no-cache
```

Capture-to-parser integration tests live in the Platform test root so the actor
package's build root remains unchanged. Test failures, truncation, duplicate or
omitted sessions/stages, metadata changes and missing versioned original-source proof
remain disqualifying.
