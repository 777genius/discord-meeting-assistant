# OSS Discord STT campaign (retained-evidence profile v1)

Owner: the development-only `apps/discord-e2e-actors` qualification boundary.
This is the development-only retained-evidence path for sequential, overlap and
reconnect with `transcript-outline`. The hosted V10 contract remains unchanged.
The executable reads local files only. It performs consistency checks and writes
a create-only **`sources-unverified` evidence report**, never an E2E PASS.
No live run or provider/Discord call was performed by this worker.

## Current capability and required source gaps

The exact Platform source `8f49a06128307bfcd13d8cb7a95e00daa528f2ea` has official
OggOpus actors, native schema-6 completion receipts, immutable batch artifacts,
accepted database transcripts, finalized live-turn rows, and Discord observation.
`loadArchive()` consumes independently retained copies of these sources through
one finite index; it does not invoke the effectful hosted collector or replay.
There is no complete OSS remote collector in this checkout. In particular:

- `packages/voicetext-adapter/src/voicetext-live-session.ts` processes actual
  acknowledgements, segments and finalize completion but does not persist a
  complete session wire/packet archive. The existing Discord observer polls
  captions; it cannot prove packet delivery or every provider-session terminal.
- `packages/recording-ingress-adapter/src/recording-ingress-authoritative-finalization.ts`
  copies the external Craig producer's `sourceFilesChecksumSha256` into its
  manifest. It does not recompute that checksum from original files. The external
  pinned Craig checksum implementation is not present in this checkout.
- `post-call-evidence-readiness.ts` observes successful stage settlement but does
  not retain all stage start timestamps. The normalized run's stage times,
  whole-project inventory and two settled observations require independent
  collection; entering them in JSON is not production evidence.

The verifier cross-checks retained content and identities, but a coherent forged
archive can satisfy those checks. Its synthetic tests deliberately demonstrate
this limitation and must never be called E2E. The previous signature requirement
has been removed: neither a new signing key nor a caller assertion closes these
source gaps. `qualify` fails closed even for a consistent archive and writes no
pass receipt. `check` and `verify` explicitly return `sources-unverified`.

Before live campaign launch, the Craig/gateway/runtime owners must provide a
separately reviewed collection path for complete correlated raw packet/session
records, the pinned original checksum calculation, and native stage/settlement
observations. Connect those actual sources to this boundary and test tampering,
omission and identity mismatch before enabling a campaign-pass branch. This is
a missing implementation, not an operator approval or key-signing ceremony.
Keep retained copies read-only and keep the originals on Craig. Checksums prove
local integrity relative to the index, not remote retention or authenticity.

## Test target and plan

Use one fresh isolated project `vtoss-test-oss-8f49a06-r1`, `meeting-platform` and
`craig-bot`, and the operatorCA OSS gateway endpoint. Every ID below is explicit;
non-test projects and mismatched IDs fail closed. The existing fixture manifest
is pinned by SHA-256 `6ecf3ae9570937da48465bab1d87563c47c0e1b3c1ef46191c0143c3fad3ff79`.
A/B application IDs are `1533227577286852649` / `1533228054724346087`.
Use an absolute external plan path, with this JSON shape. Replace placeholders
with exact revisions, the actual public CA digest, endpoint;
placeholders are intentionally invalid and cannot qualify:

```json
{
  "kind": "oss-discord-stt-plan-v1",
  "campaignId": "oss-8f49a06-r1",
  "collectorRevision": "EXACT_40_HEX_COLLECTOR_REVISION",
  "target": {
    "project": "vtoss-test-oss-8f49a06-r1",
    "testOnly": true,
    "guildId": "1533228590643155034",
    "voiceChannelId": "1533228823045214398",
    "resultsChannelId": "1533228891827736657",
    "recorderId": "1533877611258708230",
    "publicationApplicationId": "1533224474609057793",
    "platformService": "meeting-platform",
    "craigService": "craig-bot",
    "platformRevision": "8f49a06128307bfcd13d8cb7a95e00daa528f2ea",
    "craigRevision": "EXACT_40_HEX_CRAIG_REVISION",
    "gatewayRevision": "EXACT_40_HEX_OSS_GATEWAY_REVISION",
    "gatewayEndpoint": "wss://OPERATOR_OSS_ENDPOINT/ACTUAL_PATH",
    "operatorCaSha256": "SHA256_OF_RETAINED_PUBLIC_CA_BYTES",
    "summaryProvider": "transcript-outline",
    "conversationEnabled": false,
    "liveEnabled": true
  },
  "runs": [
    {"runId": "oss-r1-sequential", "scenario": "sequential"},
    {"runId": "oss-r1-overlap", "scenario": "overlap"},
    {"runId": "oss-r1-reconnect", "scenario": "reconnect"}
  ]
}
```

The target also needs official test-only bot credentials, private guild/channel
membership, distinct publication/recorder applications, verified test labels,
exact image/source identities, healthy Platform/Craig and healthy live/batch OSS
profiles. This CLI does not grant external-run authorization. Retain public
configuration and sanitized deployment identity, never tokens or environment dumps.
The operatorCA certificate is public; its private key must never enter evidence.

For a fresh database the scoped environment route is sufficient:
`DISCORD_LEGACY_GUILD_ID`, `DISCORD_LEGACY_VOICE_CHANNEL_ID`, and
`DISCORD_RESULTS_CHANNEL_ID` must all be set to the plan IDs, together with
`E2E_TEST_ONLY_LABEL=true`. This does not register a durable routing row.
Craig's compose overlay maps `CRAIG_AUTO_RECORD_CHANNEL_IDS` to
`MEETING_AUTO_RECORD_CHANNEL_IDS` and `CRAIG_SYNTHETIC_BOT_IDS` to
`MEETING_AUTO_RECORD_SYNTHETIC_BOT_IDS`; configure the voice channel and A/B.
Enable live only after separate operator admission. Keep conversation disabled
and `SUMMARY_PROVIDER=transcript-outline`.

## Operator execution, after source support and exact-revision review

The ten-service stack is already healthy. Do not restart or recreate it for this
path. Preserve the existing TEST Compose isolation, TLS and CA mounts, require
the Platform readiness marker, and use bounded Craig voice-member observation.
These are future operator instructions after the source gaps above are closed.
Before each actor run, arm the independent wire collector and the existing
`observe:live` observer (`DISCORD_E2E_LIVE_DURATION_MS=600000`, poll interval 2000,
plan results/publication IDs, corresponding run ID and fresh output). Preserve
its V2 mutation trace as supplementary retained evidence. It is not a substitute
for the gateway archive or finalized live ledger.

The existing observer command is below. Run it in a separate bounded terminal
before playback and wait for its finite process to finish before collecting its
output. `PUBLICATION_SECRETS/sut` is the operator-owned official publication bot
credential file; it is never part of the archive. This observer starts no wire
collector and cannot close the missing live archive requirement.

```sh
DISCORD_E2E_LIVE_DURATION_MS=600000 \
DISCORD_E2E_LIVE_POLL_INTERVAL_MS=2000 \
DISCORD_E2E_LIVE_RESULT_CHANNEL_ID=1533228891827736657 \
DISCORD_E2E_LIVE_SUT_APPLICATION_ID=1533224474609057793 \
DISCORD_E2E_LIVE_SUT_ACCOUNT=sut \
DISCORD_E2E_LIVE_SECRET_DIRECTORY="$PUBLICATION_SECRETS" \
DISCORD_E2E_LIVE_RUN_ID="$RUN_ID" \
DISCORD_E2E_LIVE_OUTPUT="$OUT/$RUN_ID.live.json" \
timeout --signal=TERM --kill-after=10s 630s \
  pnpm --filter @discord-meeting/meeting-platform exec \
  tsx ../discord-e2e-actors/src/observe-live-discord.ts
```

Run this command exactly once per row, changing `SCENARIO`, `DELAY_MS`, `RUN_ID`.
`FIXTURES` is the absolute committed `apps/discord-e2e-actors/test/fixtures`
directory; `ACTOR_SECRETS` is the private operator-owned test-token directory;
`OUT` is a fresh external artifact directory. Do not repeat a failed run under
the same campaign identity: retain failure evidence and use a new admitted plan.

```sh
DISCORD_E2E_GUILD_ID=1533228590643155034 \
DISCORD_E2E_VOICE_CHANNEL_ID=1533228823045214398 \
DISCORD_E2E_RECORDER_BOT_ID=1533877611258708230 \
DISCORD_E2E_SECRET_DIRECTORY="$ACTOR_SECRETS" \
DISCORD_E2E_FIXTURE_MANIFEST="$FIXTURES/manifest.v1.json" \
DISCORD_E2E_SPEAKER_A_FIXTURE="$FIXTURES/speaker-a.ru-en.ogg" \
DISCORD_E2E_SPEAKER_B_FIXTURE="$FIXTURES/speaker-b.ru-en.ogg" \
DISCORD_E2E_SCENARIO="$SCENARIO" \
DISCORD_E2E_SPEAKER_B_DELAY_MS="$DELAY_MS" \
DISCORD_E2E_RUN_ID="$RUN_ID" \
DISCORD_E2E_ACTOR_RUN_OUTPUT="$OUT/$RUN_ID.actor.json" \
timeout --signal=TERM --kill-after=10s 300s \
  pnpm --filter @discord-meeting/meeting-platform exec \
  tsx ../discord-e2e-actors/src/main.ts
```

| Order | SCENARIO | DELAY_MS | RUN_ID |
| --- | --- | ---: | --- |
| 1 | sequential | 3500 | oss-r1-sequential |
| 2 | overlap | 750 | oss-r1-overlap |
| 3 | reconnect | 750 | oss-r1-reconnect |

Require actor completion, the recording's native completion receipt, all live
sessions closed after successful finalize, and two stable terminal observations
before the next row. Actor completion alone is insufficient. Each next recording
must start after the previous second settled observation. Inventory the entire
fresh project: zero initial recordings, exactly the three final recordings.
Stop observers finitely and retain failures; do not reset or delete recordings.

## Exact retained-source mapping and archive contract

The executable schemas are `src/oss-campaign-profile.ts` and
`src/oss-recording-evidence.ts` under the actor app. All new boundary objects are
closed schemas. Native database snapshots use the existing `normalizeDatabase`
parser, then field-by-field identity/content/immutable-artifact checks.

| Archive field | Required production source and mapping |
| --- | --- |
| `deploymentPath` | Sanitized before/after Docker container and image inspection, Compose project/services and image revision labels; the exact deployment/source mapping and TLS endpoint/CA bytes verified by the independent collector. Record image digests, whole-project recording inventories, capture bracket and both target observations. Use `containerProvenanceFormat` / `imageProvenanceFormat` from `ssh-deployment-probe-scripts.ts` as read-only mapping references; do not use its fixed hosted composition. |
| `actorPath` | Exact create-only JSON emitted by `src/main.ts`; leave `recordingId:null`. The verifier correlates its epoch timestamps to the native recording and verifies A/B fixture digests, ready/disconnect/playback counts and intervals. |
| `databasePath` | Read-only `postgresEvidenceQuery` shape in `ssh-deployment-probe-scripts.ts`: `meeting_core.meetings.snapshot` and four exact-one counts for the recording. Retain the original returned JSON, including publication/stages/transcript/summary and immutable track revisions. |
| `completionPath` | Exact native `RECORDING_SPOOL_ROOT/completed-v1/<token>.json`, read-only after terminal completion. At this exact source `persistCompleted()` writes **schema 6**, not the older hosted recording-ready schema 4. Verify native final event ID/digest, recording/track identities and times. |
| `manifestPath`, `tracks[].path` | Read immutable object-store versions named by the database snapshot, using `manifestRevision` / `artifactRevision`; retain complete bytes. The native manifest comes from `recording-ingress-authoritative-finalization.ts`. All versions, locators, sizes and checksums must agree across DB, completion and manifest. Ogg page/granule inspection reuses `inspectOggOpus`. |
| `originals`, `originalInventoryPath` | Read complete retained files from Craig's recording mount for this recording, including every original source file used by cooking. The audited collector must run the **pinned Craig revision's original-source checksum algorithm** over those actual files, record the per-file SHA-256/size inventory and source checksum, and compare with the authoritative-ready event. This repository does not define that external producer algorithm; copying the event digest into an invented inventory is not collection. The verifier checks inventory bytes against retained originals and the manifest's producer checksum. |
| `lifecycle`, `startedAtMs`, `endedAtMs` | Native completed spool event records and authoritative manifest; exactly one start/end/authoritative-ready effect. Preserve raw producer lifecycle evidence as additional retained artifacts for audit. No aborted recording qualifies. |
| `transcript`, `liveTurns` | Accepted DB transcript with immutable collection version (`snapshot.revision` as text), plus actual `meeting_core.live_meeting_turns` rows mapped to `turnId/speakerId/startMs/endMs/text`. No live draft may replace the accepted transcript. Partial turns belong only in the wire archive. |
| `sessions[].wirePath` | Independently captured actual session at Platform's live-session transport and OSS gateway, with recording/meeting/speaker/session correlation. Map `ready`, sent audio sequence, every `ack`, partial/final segments, finalize request, `finalize_complete(status=flushed,saw_result=true)`, and normal close. Source-relative live times must include session/track offset. Reject capture gaps, errors, timeouts, omitted sessions and late frames. Native provider `saw_result` maps to `sawResult`; `parseServerMessage()` normalizes `partial.is_segment_final=true` to `segment_final`; both `final` and `segment_final` map to `final` here. Credentials/config secrets must be excluded by the audited collector. |
| `audio` wire events | Two retained binary concatenations per session: Craig's actual 20ms mono Opus packet payloads and corresponding gateway-received Opus payloads. Each event gives `seq`, `offset`, `size`, `craigPacketPath`, `gatewayPacketPath`, epoch `atMs`. Offsets must exhaust both files; packet bytes/TOC/duration must match without decode/re-encode. This is the actual source tee, not replay of fixture audio. |
| `stages` | Correlated post-call execution observations: transcription/summary/publication start and successful completion times. `post-call-evidence-readiness.ts` provides bounded stage readiness; it does not itself retain all start timestamps. Instrumented timing collection is required if unavailable. |
| `summary`, `publication` | Accepted DB outline, actual final Discord message ID/channel/author/creation timestamp, downloaded full transcript and outline attachments. Arrays for decisions/actions/topics/questions must be empty; no semantic LLM expectations. Attachments must contain the complete ordered authoritative text and actual outline. |
| `settled[0..1]` | Two independent post-terminal DB/Discord reads, with stable terminal time and exact-one identity arrays. `transcriptSha256` hashes UTF-8 canonical JSON of the `transcript` object (recursively sorted object keys, preserved array order). These reads prove stable observed effects, **not replay idempotency**. No replay is requested or claimed. |

`collection.json` is a finite index with kind
`oss-discord-stt-collection-v1`, exact plan **file-byte** SHA-256, collector
revision, capture time, ordered `{runId,evidencePath}` entries, deployment path,
and all artifact entries `{path,sha256,size,source:{system,locator,version}}`.
Each `evidencePath` is the strict OSS run object assembled from the retained
sources above. `collectorRevision` identifies the collection implementation for
review; it does not authenticate it. There is no signature file. Each source
identity/version and relative path must be unique; paths cannot escape or be
symlinks. The archive is bounded to 1 GiB, 10,000 artifacts and 512 MiB per
artifact. Retain raw collection inputs as additional indexed artifacts. The
report binds every indexed artifact, the exact plan bytes and the index bytes.

The existing-source consumer is deliberately thin: retain files and native JSON
without rewriting them, describe their immutable locators/versions in the index,
and refer to them from the run object. No command in this implementation obtains
missing wire data, reconstructs omitted sessions, calculates the external
original-source checksum, or authenticates hand-entered deployment/timing facts.
Do not fill missing source fields with fixture data to get a green report.

## Focused offline checks and report commands

Use the provided cached tools; do not modify dependency-cache symlinks:

```sh
export PATH="/mnt/volume_ams3_1784742570542/vtoss-astra-y-20260905/tool-cache/node-v24.18.0/bin:/mnt/volume_ams3_1784742570542/vtoss-astra-y-20260905/tool-cache/pnpm-11.18.0-standalone-r1/bin:$PATH"
export pnpm_config_verify_deps_before_run=false
pnpm --filter @discord-meeting/discord-e2e-actors typecheck
pnpm --filter @discord-meeting/discord-e2e-actors exec vitest run \
  test/oss-campaign.test.ts --maxWorkers=2 --no-file-parallelism
```

The pnpm setting disables its automatic pre-run dependency installation, which
would attempt to modify the shared cache. No full suite, build, or unbounded
worker pool is needed. The existing Platform
`tsx` executes the local OSS source directly (offline; no Platform process starts):

```sh
pnpm --filter @discord-meeting/meeting-platform exec \
  tsx ../discord-e2e-actors/src/oss-campaign-main.ts \
  check "$PLAN" "$ARCHIVE" "$FIXTURES/manifest.v1.json" "$REPORT"
pnpm --filter @discord-meeting/meeting-platform exec \
  tsx ../discord-e2e-actors/src/oss-campaign-main.ts \
  verify "$PLAN" "$ARCHIVE" "$FIXTURES/manifest.v1.json" "$REPORT"
```

After an existing build, `node "$E2E_DIST/oss-campaign-main.js"` accepts the same
arguments. The existing `verify:oss-campaign` package command builds first; avoid
that wrapper in this bounded worker. `check` writes an fsynced, atomically linked,
create-only report. Existing reports or interrupted `.pending` writers fail
closed. `verify` rechecks all files and recomputes the entire report; it rejects
changes including a forged `passed` status. Both return
`kind:"oss-discord-stt-verification",status:"sources-unverified"`, which is not
live qualification. `qualify` is reserved and exits nonzero without writing.

A real campaign-pass receipt remains unavailable until the separately owned
source collection gaps are implemented and connected. A physically read-only
review of the exact integrated revision must precede real use. Never invoke
`collect:e2e` for this path: it performs BullMQ queue replay. No replay is run or
claimed here; stable reads only prove observed identity stability. Missing live,
packet, finalize, original or quality evidence always fails consistency checks;
batch success cannot establish live success.
