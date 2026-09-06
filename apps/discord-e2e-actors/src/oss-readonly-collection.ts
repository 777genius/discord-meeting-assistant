import { execFile } from "node:child_process";
import { z } from "zod";
import { normalizeDatabase, assertExactDatabaseCounts } from "./e2e-retained-evidence-snapshot.js";
import { completionReceiptsScript, postgresEvidenceQuery, replayTargetContainerFormat,
  imageProvenanceFormat, s3EvidenceScript } from "./ssh-deployment-probe-scripts.js";
import { requireEvidence as check, sha256 } from "./oss-campaign-artifacts.js";
import { planSchema, turnSchema, type OssPlan } from "./oss-campaign-profile.js";

export type OssReadCommand = (args: readonly string[]) => Promise<string>;
/** No shell supplied by the caller, no queue imports, no replay. Errors deliberately
 * omit child stderr because Docker/provider diagnostics may include credentials. */
export const runOssReadCommand: OssReadCommand = (args) => new Promise((resolve, reject) => {
  execFile("docker", [...args], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
    (error, stdout) => error ? reject(new Error("OSS read-only source command failed")) : resolve(stdout));
});
const opaque = /^[A-Za-z0-9_-]{1,128}$/u;
const container = z.string().regex(/^[a-f0-9]{12,64}$/u);
const databaseEnvelope = z.object({ snapshot: z.unknown(), matchingMeetingCount: z.literal(1),
  matchingRecordingCount: z.literal(1), matchingTranscriptCount: z.literal(1), matchingSummaryCount: z.literal(1) }).strict();
export const inventoryQuery = `SELECT COALESCE(jsonb_agg(snapshot->'recording'->>'recordingId' ORDER BY meeting_id)
 FILTER (WHERE snapshot->'recording'->>'recordingId' IS NOT NULL),'[]'::jsonb)::text FROM meeting_core.meetings;`;
const liveQuery = (meetingId: string) => `SELECT COALESCE(jsonb_agg(jsonb_build_object(
 'turnId',turn_id,'speakerId',speaker_id,'startMs',start_ms,'endMs',end_ms,'text',turn->>'text')
 ORDER BY start_ms,end_ms,speaker_id,turn_id),'[]'::jsonb)::text
 FROM meeting_core.live_meeting_turns WHERE meeting_id='${meetingId}';`;
// Reuse the established immutable GET implementation, including metadata, version,
// byte length and checksum validation. Never execute its replay-related siblings.
const immutableGetScript = s3EvidenceScript.slice(0, s3EvidenceScript.indexOf("const durationMs =")) + String.raw`
const expected = [{ locator: identity.manifestLocator, revision: identity.manifestRevision,
 sizeBytes: identity.manifestSizeBytes, checksumSha256: identity.manifestChecksumSha256 },
 ...identity.speakerAudio.map(track => ({ locator: track.audioLocator, revision: track.artifactRevision,
 sizeBytes: track.sizeBytes, checksumSha256: track.checksumSha256 }))];
if (expected.length !== 3 || expected.some(item => !Number.isSafeInteger(item.sizeBytes) ||
 item.sizeBytes <= 0 || item.sizeBytes > 16 * 1024 * 1024)) throw new Error("OSS object collection bound");
const artifacts = [];
for (const item of expected) artifacts.push({ ...item, base64: (await get(item)).toString("base64") });
console.log(JSON.stringify(artifacts));
client.destroy();
`;

/** A finite native read, run by root only after review in the admitted TEST project.
 * Retains raw database and completion JSON, full live ledger and immutable bytes.
 * Two calls provide independently timed observations; neither triggers processing.
 */
export async function collectOssReadonlySnapshot(input: {
  plan: OssPlan; recordingId: string; command?: OssReadCommand;
}) {
  const plan = planSchema.parse(input.plan);
  check(opaque.test(input.recordingId), "Invalid native recording identity");
  const run = input.command ?? runOssReadCommand;
  const find = (service: string) => findOssTestContainer(plan, run, service);
  const startedAtMs = Date.now();
  const platform = await find(plan.target.platformService);
  const postgres = await find("postgres");
  const imageId = (await run(["inspect", "--format", "{{.Image}}", platform])).trim();
  check(/^sha256:[a-f0-9]{64}$/u.test(imageId), "Invalid Platform image identity");
  const image = JSON.parse(await run(["image", "inspect", "--format", imageProvenanceFormat, imageId])) as Record<string, unknown>;
  check(image.sourceRevision === plan.target.platformRevision, "Read-only source revision mismatch");
  const query = async (sql: string) => JSON.parse(await run(["exec", postgres, "sh", "-c",
    'exec psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', "oss-readonly",
    `BEGIN READ ONLY; SET LOCAL statement_timeout='10000'; ${sql} COMMIT;`])) as unknown;
  const observedAtMs = z.number().int().nonnegative().parse(await query(
    "SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint;"));
  const database = databaseEnvelope.parse(await query(
    postgresEvidenceQuery.replaceAll("__RECORDING_ID__", input.recordingId)));
  const normalized = normalizeDatabase(database);
  assertExactDatabaseCounts(normalized, "OSS native readonly collection");
  const snapshot = normalized.snapshot;
  check(snapshot.recording.recordingId === input.recordingId && opaque.test(snapshot.meetingId) &&
    snapshot.publicationTargetId === plan.target.resultsChannelId, "Readonly database source identity mismatch");
  const liveTurns = z.array(turnSchema).max(1000).parse(await query(liveQuery(snapshot.meetingId)));
  const recordingIds = z.array(z.string().regex(opaque)).max(3).parse(await query(inventoryQuery));
  const receipts = z.array(z.record(z.string(), z.unknown())).max(3).parse(JSON.parse(await run([
    "exec", platform, "node", "--input-type=module", "-e", completionReceiptsScript,
  ])));
  const matches = receipts.filter((receipt) => receipt.recordingId === input.recordingId);
  check(matches.length === 1 && matches[0]!.schemaVersion === 6, "Native completion missing or ambiguous");
  const objects = z.array(z.object({ locator: z.string().min(1), revision: z.string().min(1),
    sizeBytes: z.number().int().positive().max(16 * 1024 * 1024),
    checksumSha256: z.string().regex(/^[a-f0-9]{64}$/u), base64: z.string().max(24 * 1024 * 1024),
  }).strict()).length(3).parse(JSON.parse(await run(["exec", "-w", "/app/apps/meeting-platform", platform,
    "node", "--input-type=module", "-e", immutableGetScript, JSON.stringify(snapshot.recording), input.recordingId])));
  const expectedObjects = [
    { locator: snapshot.recording.manifestLocator, revision: snapshot.recording.manifestRevision,
      checksum: snapshot.recording.manifestChecksumSha256, size: snapshot.recording.manifestSizeBytes },
    ...snapshot.recording.speakerAudio.map((track) => ({ locator: track.audioLocator, revision: track.artifactRevision,
      checksum: track.checksumSha256, size: track.sizeBytes })),
  ];
  check(expectedObjects.length === objects.length, "Readonly object cardinality mismatch");
  for (const [index, object] of objects.entries()) {
    const expected = expectedObjects[index]!;
    check(object.locator === expected.locator && object.revision === expected.revision &&
      object.checksumSha256 === expected.checksum && object.sizeBytes === expected.size,
      "Readonly object database identity mismatch");
    const bytes = Buffer.from(object.base64, "base64");
    check(bytes.toString("base64") === object.base64 && bytes.length === object.sizeBytes &&
      sha256(bytes) === object.checksumSha256, "Native immutable object bytes mismatch");
  }
  return { kind: "oss-native-readonly-snapshot-v1" as const, project: plan.target.project,
    platformRevision: plan.target.platformRevision, platformImageId: imageId, startedAtMs,
    completedAtMs: Date.now(), observedAtMs, recordingIds, database, liveTurns,
    completion: matches[0]!, objects };
}

export async function findOssTestContainer(plan: OssPlan, run: OssReadCommand, service: string) {
    const ids = (await run(["ps", "--filter", `label=com.docker.compose.project=${plan.target.project}`,
      "--filter", `label=com.docker.compose.service=${service}`, "--format", "{{.ID}}"])).trim().split(/\s+/u);
    check(ids.length === 1, "Exactly one healthy TEST source container required");
    const id = container.parse(ids[0]);
    const labels = JSON.parse(await run(["inspect", "--format", replayTargetContainerFormat, id])) as Record<string, unknown>;
    check(labels.composeProject === plan.target.project && labels.composeService === service &&
      (service !== plan.target.platformService || labels.testOnly === "true"), "Read-only source TEST admission mismatch");
    check((await run(["inspect", "--format", "{{.State.Health.Status}}", id])).trim() === "healthy",
      "Read-only source container is unhealthy");
    return id;
}
