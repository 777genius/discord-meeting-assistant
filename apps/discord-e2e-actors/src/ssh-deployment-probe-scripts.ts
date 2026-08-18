export const containerProvenanceFormat = `{"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}},"containerId":{{json .Id}},"containerStartedAt":{{json .State.StartedAt}},"imageId":{{json .Image}}}`;

export const imageProvenanceFormat = `{"imageId":{{json .Id}},"repositoryDigests":{{json .RepoDigests}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}`;

export const replayTargetContainerFormat = `{"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}},"testOnly":{{json (index .Config.Labels "e2e.test-only")}}}`;

export const completionReceiptsScript = String.raw`
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(process.env.RECORDING_SPOOL_ROOT, "completed-v1");
const rootStats = await lstat(root);
if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
  throw new Error("recording completion receipt root is unsafe");
}
const receipts = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!/^[a-f\d]{64}\.json$/u.test(entry.name)) continue;
  const path = join(root, entry.name);
  const stats = await lstat(path);
  if (!entry.isFile() || !stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("recording completion receipt path is unsafe");
  }
  receipts.push(JSON.parse(await readFile(path, "utf8")));
}
console.log(JSON.stringify(receipts));
`;

export const postgresEvidenceQuery = `
WITH target AS (
  SELECT snapshot
  FROM meeting_core.meetings
  WHERE snapshot -> 'recording' ->> 'recordingId' = '__RECORDING_ID__'
  ORDER BY updated_at DESC
  LIMIT 1
)
SELECT jsonb_build_object(
  'snapshot', (SELECT snapshot FROM target),
  'matchingMeetingCount', (
    SELECT count(*) FROM meeting_core.meetings
    WHERE meeting_id = (SELECT snapshot ->> 'meetingId' FROM target)
  ),
  'matchingRecordingCount', (
    SELECT count(*) FROM meeting_core.meetings
    WHERE snapshot -> 'recording' ->> 'recordingId' = '__RECORDING_ID__'
  ),
  'matchingTranscriptCount', (
    SELECT count(*) FROM meeting_core.meetings
    WHERE snapshot -> 'transcript' ->> 'transcriptId' =
      (SELECT snapshot -> 'transcript' ->> 'transcriptId' FROM target)
  ),
  'matchingSummaryCount', (
    SELECT count(*) FROM meeting_core.meetings
    WHERE snapshot -> 'summary' ->> 'summaryId' =
      (SELECT snapshot -> 'summary' ->> 'summaryId' FROM target)
  )
)::text;
`;

export const s3EvidenceScript = String.raw`
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const [locator, expectedRecordingId] = process.argv.slice(1);
const secret = async (path) => (await readFile(path, "utf8")).trim();
const client = new S3Client({
  credentials: {
    accessKeyId: await secret(process.env.S3_ACCESS_KEY_ID_FILE),
    secretAccessKey: await secret(process.env.S3_SECRET_ACCESS_KEY_FILE),
  },
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: true,
  region: process.env.S3_REGION,
});
const parseLocator = (value) => {
  const match = /^s3:\/\/([^/]+)\/(.+)$/u.exec(value);
  if (!match || match[1] !== process.env.S3_BUCKET) throw new Error("locator outside configured bucket");
  return { Bucket: match[1], Key: match[2] };
};
const get = async (value) => {
  const response = await client.send(new GetObjectCommand(parseLocator(value)));
  if (!response.Body) throw new Error("S3 object has no body");
  return Buffer.from(await response.Body.transformToByteArray());
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const durationMs = (bytes) => {
  let offset = 0;
  let maximum = 0n;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || bytes.toString("ascii", offset, offset + 4) !== "OggS") {
      throw new Error("invalid Ogg page in S3 track");
    }
    const count = bytes[offset + 26];
    let body = 0;
    for (let index = 0; index < count; index += 1) body += bytes[offset + 27 + index];
    const end = offset + 27 + count + body;
    if (end > bytes.length) throw new Error("truncated Ogg track in S3");
    const granule = bytes.readBigUInt64LE(offset + 6);
    if (granule !== 0xffffffffffffffffn && granule > maximum) maximum = granule;
    offset = end;
  }
  if (maximum === 0n) throw new Error("S3 Ogg track has no duration");
  return Math.round(Number(maximum) / 48);
};
const manifestBytes = await get(locator);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.recordingId !== expectedRecordingId || manifest.source?.kind !== "craig-original-multitrack") {
  throw new Error("S3 manifest is not the requested authoritative Craig recording");
}
const tracks = [];
for (const declared of manifest.tracks) {
  const bytes = await get(declared.locator);
  const checksum = digest(bytes);
  if (checksum !== declared.checksumSha256 || bytes.length !== declared.sizeBytes) {
    throw new Error("S3 track bytes do not match authoritative manifest");
  }
  tracks.push({
    checksumSha256: checksum,
    durationMs: durationMs(bytes),
    locator: declared.locator,
    sizeBytes: bytes.length,
    speakerId: declared.speakerId,
    timelineOffsetMs: declared.timelineOffsetMs,
  });
}
console.log(JSON.stringify({
  endedAt: manifest.endedAt,
  manifestChecksumSha256: digest(manifestBytes),
  manifestLocator: locator,
  recordingId: manifest.recordingId,
  sourceChecksumSha256: manifest.source.checksumSha256,
  startedAt: manifest.startedAt,
  tracks,
}));
await client.destroy();
`;

const replayConnectionScript = String.raw`
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const redisUrl = (await readFile(process.env.REDIS_URL_FILE, "utf8")).trim();
const url = new URL(redisUrl);
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
  db: Number(url.pathname.slice(1) || 0),
};
const meetingId = process.argv[1];
const digest = createHash("sha256")
  .update("post-call-job-v2", "utf8")
  .update("\0", "utf8")
  .update(meetingId, "utf8")
  .digest("hex");
const jobId = "post-call-v2-" + digest;
`;

export const replayReadinessScript = String.raw`
import { Queue } from "bullmq";
${replayConnectionScript}
const queue = new Queue("meeting-post-call-v2", { connection, prefix: "discord-meeting-v1" });
try {
  await queue.waitUntilReady();
  const job = await queue.getJob(jobId);
  if (!job || await job.getState() !== "completed" || !job.processedOn) {
    throw new Error("completed post-call job is unavailable for replay");
  }
  console.log(JSON.stringify({ beforeProcessedOn: job.processedOn, jobId, state: "completed" }));
} finally {
  await queue.close();
}
`;

export const replayJobScript = String.raw`
import { Queue } from "bullmq";
${replayConnectionScript}
const expectedBeforeProcessedOn = Number(process.argv[2]);
const queue = new Queue("meeting-post-call-v2", { connection, prefix: "discord-meeting-v1" });
try {
  await queue.waitUntilReady();
  const job = await queue.getJob(jobId);
  if (
    !job ||
    await job.getState() !== "completed" ||
    job.processedOn !== expectedBeforeProcessedOn
  ) {
    throw new Error("post-call job changed after replay safety preflight");
  }
  await job.retry("completed");
  const deadline = Date.now() + 300000;
  let fresh;
  while (Date.now() < deadline) {
    fresh = await queue.getJob(jobId);
    if (fresh && await fresh.getState() === "completed" && (fresh.processedOn || 0) > expectedBeforeProcessedOn) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!fresh || await fresh.getState() !== "completed" || (fresh.processedOn || 0) <= expectedBeforeProcessedOn) {
    throw new Error("real replay did not complete before deadline");
  }
  console.log(JSON.stringify({
    afterProcessedOn: fresh.processedOn,
    beforeProcessedOn: expectedBeforeProcessedOn,
    jobId,
    state: "completed",
  }));
} finally {
  await queue.close();
}
`;
