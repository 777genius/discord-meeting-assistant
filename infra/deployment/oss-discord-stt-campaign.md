# OSS Discord STT campaign (retained-evidence profile v1)

Owner: the development-only `apps/discord-e2e-actors` qualification boundary.
This profile qualifies sequential, overlap and reconnect recording/STT with
`transcript-outline`, without conversation, Pipecat or semantic LLM output.
The hosted V10 contract and commands are unchanged. This is an offline
verification CLI, **not live admission or a collector**. It never starts services,
reads credentials, contacts Discord/providers, or queues replay. No live run was
performed when implementing it.

## Required independent collection before a real pass

Exact Platform `8f49a06128307bfcd13d8cb7a95e00daa528f2ea` has the official
OggOpus actor path and authoritative batch pipeline. It does not retain the
complete per-session packet/wire archive this profile requires. A Discord
caption poll or batch success cannot fill that gap. The operator must supply
independently collected evidence from an audited, exact-revision collector that
observes the actual test deployment. If that capability is absent, stop before
actors. Request a separately reviewed collection/instrumentation change from the
Craig/gateway/runtime owner; do not invent events or sign handwritten reports.

The collector's Ed25519 **public** key and source revision belong in the reviewed
plan before collection. Keep the private signing key outside this checkout and
outside the verifier's custody. The reviewer must independently approve this
key and the collector implementation; taking a key from an untrusted archive
would make a signature meaningless. There is deliberately no signing command,
permissive `passed` field, or operator override. Signatures authenticate the
collection boundary; they cannot establish the honesty of a malicious collector
or prove continuing retention on a remote host after collection. Freeze the
external artifact directory read-only before verification and retain the
originals on Craig as well as the checked copies.

## Test target and plan

Use one fresh isolated project `vtoss-test-oss-8f49a06-r1`, `meeting-platform` and
`craig-bot`, and the operatorCA OSS gateway endpoint. Every ID below is explicit;
non-test projects and mismatched IDs fail closed. The existing fixture manifest
is pinned by SHA-256 `6ecf3ae9570937da48465bab1d87563c47c0e1b3c1ef46191c0143c3fad3ff79`.
A/B application IDs are `1533227577286852649` / `1533228054724346087`.
Use an absolute external plan path, with this JSON shape. Replace placeholders
with exact revisions, the actual public CA digest, endpoint and public key;
placeholders are intentionally invalid and cannot qualify:

```json
{
  "kind": "oss-discord-stt-plan-v1",
  "campaignId": "oss-8f49a06-r1",
  "collectorPublicKeyPem": "REVIEWED_ED25519_PUBLIC_KEY_PEM",
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

## Operator execution, after external admission and observer readiness

Use the existing verified TEST environment/Compose isolation, TLS and CA mounts:

```sh
docker compose -p vtoss-test-oss-8f49a06-r1 \
  --env-file "$TEST_ENV" -f "$TEST_COMPOSE" \
  up --no-build --pull never --no-deps --detach \
  --wait --wait-timeout 180 meeting-platform craig-bot
```

This is an effectful operator command, not part of verification. Require the
Platform readiness marker and bounded Craig voice-member observation. Before
each actor run, arm the independent wire collector and the existing
`observe:live` observer (`DISCORD_E2E_LIVE_DURATION_MS=600000`, poll interval 2000,
plan results/publication IDs, corresponding run ID and fresh output). Preserve
its V2 mutation trace as supplementary signed evidence. It is not a substitute
for the gateway archive or finalized live ledger.

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
| `lifecycle`, `startedAtMs`, `endedAtMs` | Native completed spool event records and authoritative manifest; exactly one start/end/authoritative-ready effect. Preserve raw producer lifecycle evidence as additional signed artifacts for audit. No aborted recording qualifies. |
| `transcript`, `liveTurns` | Accepted DB transcript with immutable collection version (`snapshot.revision` as text), plus actual `meeting_core.live_meeting_turns` rows mapped to `turnId/speakerId/startMs/endMs/text`. No live draft may replace the accepted transcript. Partial turns belong only in the wire archive. |
| `sessions[].wirePath` | Independently captured actual session at Platform's live-session transport and OSS gateway, with recording/meeting/speaker/session correlation. Map `ready`, sent audio sequence, every `ack`, partial/final segments, finalize request, `finalize_complete(status=flushed,saw_result=true)`, and normal close. Source-relative live times must include session/track offset. Reject capture gaps, errors, timeouts, omitted sessions and late frames. Native provider `saw_result` maps to `sawResult`; `partial.is_segment_final=true` maps to `final`. Credentials/config secrets must be excluded by the audited collector. |
| `audio` wire events | Two retained binary concatenations per session: Craig's actual 20ms mono Opus packet payloads and corresponding gateway-received Opus payloads. Each event gives `seq`, `offset`, `size`, `craigPacketPath`, `gatewayPacketPath`, epoch `atMs`. Offsets must exhaust both files; packet bytes/TOC/duration must match without decode/re-encode. This is the actual source tee, not replay of fixture audio. |
| `stages` | Correlated post-call execution observations: transcription/summary/publication start and successful completion times. `post-call-evidence-readiness.ts` provides bounded stage readiness; it does not itself retain all start timestamps. Instrumented timing collection is required if unavailable. |
| `summary`, `publication` | Accepted DB outline, actual final Discord message ID/channel/author/creation timestamp, downloaded full transcript and outline attachments. Arrays for decisions/actions/topics/questions must be empty; no semantic LLM expectations. Attachments must contain the complete ordered authoritative text and actual outline. |
| `settled[0..1]` | Two independent post-terminal DB/Discord reads, with stable terminal time and exact-one identity arrays. `transcriptSha256` hashes UTF-8 canonical JSON of the `transcript` object (recursively sorted object keys, preserved array order). These reads prove stable observed effects, **not replay idempotency**. No replay is requested or claimed. |

`collection.json` is a finite index with kind
`oss-discord-stt-collection-v1`, exact plan **file-byte** SHA-256, collector
revision, capture time, ordered `{runId,evidencePath}` entries, deployment path,
and all artifact entries `{path,sha256,size,source:{system,locator,version}}`.
Each `evidencePath` is the strict OSS run object, assembled from the retained
sources above. `collection.sig` is the raw 64-byte Ed25519 signature over the
exact index bytes. Each source identity/version and relative path must be unique;
paths cannot escape or be symlinks. The archive is bounded to 1 GiB, 10,000
artifacts and 512 MiB per artifact. Retain raw collection inputs as additional
indexed artifacts; the pass receipt binds the complete signed inventory.

The source collector is a trust boundary, not an end-user report generator.
Wire normalization, source-checksum calculation, clock correlation, complete
session discovery and remote original-retention observation must be reviewed
against its pinned implementation before accepting its signing key. Unsigned
existing evidence cannot be upgraded into trustworthy collection merely by
adding signatures after the fact.

## Offline qualification and independent verification

With dependencies already installed and no provider/Discord access:

```sh
pnpm --filter @discord-meeting/discord-e2e-actors typecheck
pnpm --filter @discord-meeting/discord-e2e-actors exec vitest run test/oss-campaign.test.ts
pnpm --filter @discord-meeting/discord-e2e-actors run verify:oss-campaign \
  qualify "$PLAN" "$ARCHIVE" "$FIXTURES/manifest.v1.json" "$PASS_RECEIPT"
pnpm --filter @discord-meeting/discord-e2e-actors run verify:oss-campaign \
  verify "$PLAN" "$ARCHIVE" "$FIXTURES/manifest.v1.json" "$PASS_RECEIPT"
```

After an existing build, directly use `node "$E2E_DIST/oss-campaign-main.js"`
with the same arguments. Successful verification emits
`kind:"oss-discord-stt-verification",status:"verified"`. Qualification writes
one fsynced, atomically linked create-only receipt. A pre-existing receipt or
interrupted `.pending` writer fails closed; never overwrite a receipt to retry.
Verification rechecks the independent signature, every retained artifact and
all scenario/quality/terminal requirements, then recomputes the entire receipt.
Use a physically read-only review checkout of the exact integrated tree and an
independently supplied plan/key before real use.

Never invoke `collect:e2e` for this path: that existing command performs BullMQ
queue replay. Hosted pass verification, conversation capture and SaaS admission
are not prerequisites for this OSS profile, and this receipt does not claim
those qualifications. Missing live/packet/finalize/original evidence always
fails; batch success cannot turn it into a pass.
