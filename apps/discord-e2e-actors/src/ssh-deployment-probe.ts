import { spawn } from "node:child_process";

import { z } from "zod";

import type {
  DatabaseObservation,
  DeploymentEvidenceProbe,
  ReplayJobEvidence,
  S3RecordingEvidence,
} from "./e2e-collector.js";
import type {
  DeployedServiceProvenance,
  DeploymentProvenance,
} from "./e2e-evidence.js";

const safeHost = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u);
const safeProject = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u);
const safeService = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u);
const absolutePath = z.string().startsWith("/").refine((value) => !value.includes("\0"));
const correlationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const dockerContainerId = z.string().regex(/^[a-f\d]{64}$/u);
const dockerImageId = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigest = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevision = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);

const containerProvenanceOutputSchema = z.object({
  composeConfigHash: sha256,
  composeProject: safeProject,
  composeService: safeService,
  containerId: dockerContainerId,
  containerStartedAt: z.iso.datetime(),
  imageId: dockerImageId,
});

const imageProvenanceOutputSchema = z.object({
  imageId: dockerImageId,
  repositoryDigests: z.array(repositoryDigest).nullable(),
  sourceRevision,
});

const databaseOutputSchema = z.object({
  matchingMeetingCount: z.number().int().nonnegative(),
  matchingRecordingCount: z.number().int().nonnegative(),
  matchingSummaryCount: z.number().int().nonnegative(),
  matchingTranscriptCount: z.number().int().nonnegative(),
  snapshot: z.unknown(),
});

const s3OutputSchema = z.object({
  endedAt: z.iso.datetime(),
  manifestChecksumSha256: z.string(),
  manifestLocator: z.string(),
  recordingId: z.string(),
  sourceChecksumSha256: z.string(),
  startedAt: z.iso.datetime(),
  tracks: z.array(z.object({
    checksumSha256: z.string(),
    durationMs: z.number().int().positive(),
    locator: z.string(),
    sizeBytes: z.number().int().positive(),
    speakerId: z.string(),
    timelineOffsetMs: z.number().int().nonnegative(),
  })),
});

const replayOutputSchema = z.object({
  afterProcessedOn: z.number().int().positive(),
  beforeProcessedOn: z.number().int().positive(),
  jobId: z.string().min(1),
  state: z.literal("completed"),
});

export interface SshDeploymentProbeOptions {
  readonly composeFile: string;
  readonly craigProjectName: string;
  readonly craigServiceName: string;
  readonly envFile: string;
  readonly host: string;
  readonly projectName: string;
  readonly sourceRoot: string;
  readonly timeoutMs?: number;
}

export class SshDeploymentEvidenceProbe implements DeploymentEvidenceProbe {
  readonly #options: Required<SshDeploymentProbeOptions>;

  public constructor(options: SshDeploymentProbeOptions) {
    this.#options = {
      composeFile: absolutePath.parse(options.composeFile),
      craigProjectName: safeProject.parse(options.craigProjectName),
      craigServiceName: safeService.parse(options.craigServiceName),
      envFile: absolutePath.parse(options.envFile),
      host: safeHost.parse(options.host),
      projectName: safeProject.parse(options.projectName),
      sourceRoot: absolutePath.parse(options.sourceRoot),
      timeoutMs: options.timeoutMs ?? 300_000,
    };
  }

  public async collectDatabase(recordingId: string): Promise<DatabaseObservation> {
    const validatedId = correlationId.parse(recordingId);
    const output = await this.#dockerExec("postgres", [
      "psql",
      "--no-psqlrc",
      "-U",
      "meeting",
      "-d",
      "meeting",
      "-At",
      "-c",
      postgresEvidenceQuery.replaceAll("__RECORDING_ID__", validatedId),
    ]);
    return databaseOutputSchema.parse(parseLastJsonLine(output));
  }

  public async collectProvenance(): Promise<DeploymentProvenance> {
    const [craig, meetingPlatform] = await Promise.all([
      this.#collectServiceProvenance(
        this.#options.craigProjectName,
        this.#options.craigServiceName,
      ),
      this.#collectServiceProvenance(this.#options.projectName, "meeting-platform"),
    ]);
    return { craig, meetingPlatform };
  }

  public async collectS3(
    manifestLocator: string,
    recordingId: string,
  ): Promise<S3RecordingEvidence> {
    const output = await this.#dockerExec("meeting-platform", [
      "node",
      "--input-type=module",
      "-e",
      s3EvidenceScript,
      manifestLocator,
      correlationId.parse(recordingId),
    ]);
    return s3OutputSchema.parse(parseLastJsonLine(output));
  }

  public async replayPostCall(meetingId: string): Promise<ReplayJobEvidence> {
    const output = await this.#dockerExec("meeting-platform", [
      "node",
      "--input-type=module",
      "-e",
      replayJobScript,
      correlationId.parse(meetingId),
    ]);
    return replayOutputSchema.parse(parseLastJsonLine(output));
  }

  async #collectServiceProvenance(
    projectName: string,
    serviceName: string,
  ): Promise<DeployedServiceProvenance> {
    const containerIds = (await this.#runRemote([
      "docker",
      "ps",
      "--no-trunc",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--filter",
      `label=com.docker.compose.service=${serviceName}`,
    ])).trim().split("\n").filter((value) => value.length > 0);
    if (containerIds.length !== 1) {
      throw new Error(
        `expected one running ${projectName}/${serviceName} container, found ${containerIds.length}`,
      );
    }
    const containerId = dockerContainerId.parse(containerIds[0]);
    const container = containerProvenanceOutputSchema.parse(parseLastJsonLine(
      await this.#runRemote([
        "docker",
        "inspect",
        "--format",
        containerProvenanceFormat,
        containerId,
      ]),
    ));
    if (container.composeProject !== projectName || container.composeService !== serviceName) {
      throw new Error("Docker container provenance does not match the requested Compose service");
    }
    const image = imageProvenanceOutputSchema.parse(parseLastJsonLine(
      await this.#runRemote([
        "docker",
        "image",
        "inspect",
        "--format",
        imageProvenanceFormat,
        container.imageId,
      ]),
    ));
    if (image.imageId !== container.imageId) {
      throw new Error("Running container image differs from inspected immutable image ID");
    }
    return {
      ...container,
      repositoryDigest: (image.repositoryDigests ?? []).toSorted()[0] ?? null,
      sourceRevision: image.sourceRevision,
    };
  }

  async #dockerExec(service: "meeting-platform" | "postgres", args: readonly string[]): Promise<string> {
    const compose = [
      "docker",
      "compose",
      "--env-file",
      this.#options.envFile,
      "-f",
      this.#options.composeFile,
      "-p",
      this.#options.projectName,
      "exec",
      "-T",
      ...(service === "meeting-platform" ? ["-w", "/app/apps/meeting-platform"] : []),
      service,
      ...args,
    ];
    const command = `cd ${shellQuote(this.#options.sourceRoot)} && ${compose.map(shellQuote).join(" ")}`;
    return runProcess(
      "ssh",
      ["-o", "BatchMode=yes", "--", this.#options.host, command],
      this.#options.timeoutMs,
    );
  }

  async #runRemote(args: readonly string[]): Promise<string> {
    return runProcess(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "--",
        this.#options.host,
        args.map(shellQuote).join(" "),
      ],
      this.#options.timeoutMs,
    );
  }
}

const containerProvenanceFormat = `{"composeConfigHash":{{json (index .Config.Labels "com.docker.compose.config-hash")}},"composeProject":{{json (index .Config.Labels "com.docker.compose.project")}},"composeService":{{json (index .Config.Labels "com.docker.compose.service")}},"containerId":{{json .Id}},"containerStartedAt":{{json .State.StartedAt}},"imageId":{{json .Image}}}`;

const imageProvenanceFormat = `{"imageId":{{json .Id}},"repositoryDigests":{{json .RepoDigests}},"sourceRevision":{{json (index .Config.Labels "org.opencontainers.image.revision")}}}`;

const postgresEvidenceQuery = `
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

const s3EvidenceScript = String.raw`
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

const replayJobScript = String.raw`
import { Queue, QueueEvents } from "bullmq";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const meetingId = process.argv[1];
const redisUrl = (await readFile(process.env.REDIS_URL_FILE, "utf8")).trim();
const url = new URL(redisUrl);
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
  db: Number(url.pathname.slice(1) || 0),
};
const digest = createHash("sha256")
  .update("post-call-job-v1", "utf8")
  .update("\0", "utf8")
  .update(meetingId, "utf8")
  .digest("hex");
const jobId = "post-call-v1-" + digest;
const queue = new Queue("meeting-post-call-v1", { connection, prefix: "discord-meeting-v1" });
const events = new QueueEvents("meeting-post-call-v1", { connection, prefix: "discord-meeting-v1" });
await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
const job = await queue.getJob(jobId);
if (!job || await job.getState() !== "completed" || !job.processedOn) {
  throw new Error("completed post-call job is unavailable for replay");
}
const beforeProcessedOn = job.processedOn;
await job.retry("completed");
const deadline = Date.now() + 300000;
let fresh;
while (Date.now() < deadline) {
  fresh = await queue.getJob(jobId);
  if (fresh && await fresh.getState() === "completed" && (fresh.processedOn || 0) > beforeProcessedOn) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
if (!fresh || await fresh.getState() !== "completed" || (fresh.processedOn || 0) <= beforeProcessedOn) {
  throw new Error("real replay did not complete before deadline");
}
console.log(JSON.stringify({
  afterProcessedOn: fresh.processedOn,
  beforeProcessedOn,
  jobId,
  state: "completed",
}));
await Promise.all([events.close(), queue.close()]);
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function parseLastJsonLine(output: string): unknown {
  const line = output.trim().split("\n").at(-1);
  if (line === undefined || line.length === 0) {
    throw new Error("remote evidence probe returned no JSON");
  }
  return JSON.parse(line) as unknown;
}

function runProcess(executable: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`evidence probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16 * 1_024 * 1_024) {
        child.kill("SIGTERM");
        reject(new Error("evidence probe output exceeded 16 MiB"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`evidence probe failed (${String(code)}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
