import { z } from "zod";

const safeHost = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u);
const safeProject = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u);
const safeService = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u);
const absolutePath = z.string().startsWith("/").refine((value) => !value.includes("\0"));
export const correlationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
export const recordingStartedAtSchema = z.iso.datetime();
const dockerContainerId = z.string().regex(/^[a-f\d]{64}$/u);
const dockerImageId = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigest = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevision = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);

export const containerProvenanceOutputSchema = z.object({
  composeConfigHash: sha256,
  composeProject: safeProject,
  composeService: safeService,
  containerId: dockerContainerId,
  containerStartedAt: z.iso.datetime(),
  imageId: dockerImageId,
});

export const imageProvenanceOutputSchema = z.object({
  imageId: dockerImageId,
  repositoryDigests: z.array(repositoryDigest).nullable(),
  sourceRevision,
});

export const databaseOutputSchema = z.object({
  matchingMeetingCount: z.number().int().nonnegative(),
  matchingRecordingCount: z.number().int().nonnegative(),
  matchingSummaryCount: z.number().int().nonnegative(),
  matchingTranscriptCount: z.number().int().nonnegative(),
  snapshot: z.unknown(),
});

export const s3OutputSchema = z.object({
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

export const replayOutputSchema = z.object({
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

export type SshDeploymentProbeSettings = Required<SshDeploymentProbeOptions>;

export function parseSshDeploymentProbeOptions(
  options: SshDeploymentProbeOptions,
): SshDeploymentProbeSettings {
  return {
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

export function parseDockerContainerId(value: unknown): string {
  return dockerContainerId.parse(value);
}
