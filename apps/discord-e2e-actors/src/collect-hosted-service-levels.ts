import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

import {
  deriveHostedServiceLevels,
  hostedServiceLevelClockBindingRequest,
  HostedServiceLevelDerivationError,
  type HostedServiceLevelFailureCode,
  type HostedServiceLevelClockBindingRequest,
  type HostedServiceLevelSourceInput,
} from "./hosted-service-levels.js";

const absolutePath = z.string().refine(isAbsolute, "Expected an absolute path");
const privateInputPathsSchema = z.object({
  campaignProof: absolutePath,
  clockAttestations: absolutePath.optional(),
  database: absolutePath,
  fixtureManifest: absolutePath,
  meetingPlatformLogs: absolutePath,
  playbackLinkProof: absolutePath,
  readyReceipt: absolutePath,
  s3: absolutePath,
  supplementalPlayback: absolutePath,
  voice: z.array(absolutePath).length(6),
}).strict();

const collectHostedServiceLevelsConfigSchema = z.object({
  campaignId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  meetingId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  outputPath: absolutePath,
  recordingId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  reportPath: absolutePath,
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  sources: privateInputPathsSchema,
}).strict().refine(({ outputPath, reportPath }) => outputPath !== reportPath, {
  message: "Service-level output and report paths must differ",
});

export type CollectHostedServiceLevelsConfig = z.infer<
  typeof collectHostedServiceLevelsConfigSchema
>;

const environmentSchema = z.object({
  DISCORD_E2E_SLA_CAMPAIGN_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT: absolutePath,
  DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT: absolutePath.optional(),
  DISCORD_E2E_SLA_DATABASE_INPUT: absolutePath,
  DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT: absolutePath,
  DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT: absolutePath,
  DISCORD_E2E_SLA_MEETING_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  DISCORD_E2E_SLA_OUTPUT: absolutePath,
  DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT: absolutePath,
  DISCORD_E2E_SLA_READY_RECEIPT_INPUT: absolutePath,
  DISCORD_E2E_SLA_RECORDING_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  DISCORD_E2E_SLA_REPORT_OUTPUT: absolutePath,
  DISCORD_E2E_SLA_RUN_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  DISCORD_E2E_SLA_S3_INPUT: absolutePath,
  DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT: absolutePath,
  DISCORD_E2E_SLA_VOICE_INPUTS: z.string().transform((value, context) => {
    try {
      return z.array(absolutePath).length(6).parse(JSON.parse(value) as unknown);
    } catch {
      context.addIssue({ code: "custom", message: "Expected six absolute voice input paths" });
      return z.NEVER;
    }
  }),
});

export const hostedServiceLevelsReportV1Schema = z.discriminatedUnion("status", [
  z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    outputCreated: z.literal(false),
    runId: z.string().min(1),
    schemaVersion: z.literal(1),
    status: z.literal("blocked"),
  }).strict(),
  z.object({
    measurementCount: z.literal(3),
    outputCreated: z.literal(true),
    runId: z.string().min(1),
    schemaVersion: z.literal(1),
    status: z.literal("ready"),
  }).strict(),
]);

export class HostedServiceLevelsBlockedError extends Error {}

function loadCollectHostedServiceLevelsConfig(
  environment: NodeJS.ProcessEnv,
): CollectHostedServiceLevelsConfig {
  const value = environmentSchema.parse(environment);
  return collectHostedServiceLevelsConfigSchema.parse({
    campaignId: value.DISCORD_E2E_SLA_CAMPAIGN_ID,
    meetingId: value.DISCORD_E2E_SLA_MEETING_ID,
    outputPath: value.DISCORD_E2E_SLA_OUTPUT,
    recordingId: value.DISCORD_E2E_SLA_RECORDING_ID,
    reportPath: value.DISCORD_E2E_SLA_REPORT_OUTPUT,
    runId: value.DISCORD_E2E_SLA_RUN_ID,
    sources: {
      campaignProof: value.DISCORD_E2E_SLA_CAMPAIGN_PROOF_INPUT,
      ...(value.DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT === undefined ? {} : {
        clockAttestations: value.DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT,
      }),
      database: value.DISCORD_E2E_SLA_DATABASE_INPUT,
      fixtureManifest: value.DISCORD_E2E_SLA_FIXTURE_MANIFEST_INPUT,
      meetingPlatformLogs: value.DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT,
      playbackLinkProof: value.DISCORD_E2E_SLA_PLAYBACK_LINK_PROOF_INPUT,
      readyReceipt: value.DISCORD_E2E_SLA_READY_RECEIPT_INPUT,
      s3: value.DISCORD_E2E_SLA_S3_INPUT,
      supplementalPlayback: value.DISCORD_E2E_SLA_SUPPLEMENTAL_PLAYBACK_INPUT,
      voice: value.DISCORD_E2E_SLA_VOICE_INPUTS,
    },
  });
}

export async function collectHostedServiceLevels(
  configInput: CollectHostedServiceLevelsConfig,
): Promise<Awaited<ReturnType<typeof deriveHostedServiceLevels>>> {
  const config = collectHostedServiceLevelsConfigSchema.parse(configInput);
  await assertMissing(config.outputPath, "Service-level output");
  await assertMissing(config.reportPath, "Service-level report");
  let serviceLevels: Awaited<ReturnType<typeof deriveHostedServiceLevels>>;
  try {
    const sources = await readSourceInputs(config);
    serviceLevels = await deriveHostedServiceLevels(sources);
    assertServiceLevelIdentity(serviceLevels, config);
  } catch (error) {
    const failure = failureDetails(error);
    await writeCreateOnlyPrivateJson(config.reportPath, hostedServiceLevelsReportV1Schema.parse({
      code: failure.code,
      message: failure.message,
      outputCreated: false,
      runId: config.runId,
      schemaVersion: 1,
      status: "blocked",
    }));
    throw new HostedServiceLevelsBlockedError(
      `Hosted service-level collection blocked [${failure.code}]: ${failure.message}`,
      { cause: error },
    );
  }
  await writeCreateOnlyPrivateJson(config.outputPath, serviceLevels);
  await writeCreateOnlyPrivateJson(config.reportPath, hostedServiceLevelsReportV1Schema.parse({
    measurementCount: serviceLevels.measurements.length,
    outputCreated: true,
    runId: config.runId,
    schemaVersion: 1,
    status: "ready",
  }));
  return serviceLevels;
}

function assertServiceLevelIdentity(
  serviceLevels: Awaited<ReturnType<typeof deriveHostedServiceLevels>>,
  config: CollectHostedServiceLevelsConfig,
): void {
  for (const measurement of serviceLevels.measurements) {
    if (measurement.start.source.runId !== config.runId || measurement.end.source.runId !== config.runId
      || measurement.start.source.meetingId !== config.meetingId
      || measurement.end.source.meetingId !== config.meetingId) {
      throw new HostedServiceLevelDerivationError(
        "SOURCE_IDENTITY_MISMATCH", "Derived service levels do not match the declared run and meeting",
      );
    }
    const recordingIds = [
      "recordingId" in measurement.start.source ? measurement.start.source.recordingId : undefined,
      "recordingId" in measurement.end.source ? measurement.end.source.recordingId : undefined,
    ].filter((value): value is string => value !== undefined);
    if (recordingIds.some((recordingId) => recordingId !== config.recordingId)) {
      throw new HostedServiceLevelDerivationError(
        "SOURCE_IDENTITY_MISMATCH", "Derived service levels do not match the declared recording",
      );
    }
  }
}

export async function collectHostedServiceLevelClockBindingRequest(
  configInput: CollectHostedServiceLevelsConfig,
): Promise<HostedServiceLevelClockBindingRequest> {
  const config = collectHostedServiceLevelsConfigSchema.parse(configInput);
  const sources = await readSourceInputs(config, false);
  const { clockAttestations: _clockAttestations, ...withoutClock } = sources;
  return hostedServiceLevelClockBindingRequest(withoutClock);
}

async function readSourceInputs(
  config: CollectHostedServiceLevelsConfig,
  requireClock = true,
): Promise<HostedServiceLevelSourceInput> {
  const paths = config.sources;
  const requiredPaths = [
    paths.campaignProof, paths.database, paths.fixtureManifest, paths.meetingPlatformLogs,
    paths.playbackLinkProof, paths.readyReceipt, paths.s3, paths.supplementalPlayback,
    ...paths.voice,
  ];
  if (requireClock && paths.clockAttestations === undefined) {
    throw new HostedServiceLevelDerivationError(
      "CLOCK_ATTESTATION_MISSING", "Clock attestation input path is required",
    );
  }
  try {
    const contents = await Promise.all(requiredPaths.map(readPrivateInput));
    const required = (index: number, label: string): string => {
      const value = contents[index];
      if (value === undefined) {
        throw new Error(`Missing loaded ${label}`);
      }
      return value;
    };
    const campaignProof = required(0, "campaign proof");
    const database = required(1, "database observation");
    const fixtureManifest = required(2, "fixture manifest");
    const meetingPlatformLogs = required(3, "meeting-platform logs");
    const playbackLinkProof = required(4, "playback-link proof");
    const readyReceipt = required(5, "recording-ready receipt");
    const s3 = required(6, "S3 observation");
    const supplementalPlayback = required(7, "supplemental playback");
    const voice = contents.slice(8);
    const clockAttestations = !requireClock || paths.clockAttestations === undefined
      ? undefined : await readPrivateInput(paths.clockAttestations);
    return {
      campaignProof: parseJson(campaignProof, "campaign proof"),
      ...(clockAttestations === undefined ? {} : {
        clockAttestations: parseJson(clockAttestations, "clock attestations"),
      }),
      database: parseJson(database, "database observation"),
      fixtureManifest: parseJson(fixtureManifest, "fixture manifest"),
      meetingPlatformLogs,
      playbackLinkProof: parseJson(playbackLinkProof, "playback-link proof"),
      readyReceipt: parseJson(readyReceipt, "recording-ready receipt"),
      runId: config.runId,
      s3: parseJson(s3, "S3 observation"),
      supplementalPlayback: parseJson(supplementalPlayback, "supplemental playback"),
      voice: voice.slice(0, 6).map((voiceContents, index) =>
        parseJson(voiceContents, `voice capture ${index + 1}`)
      ),
    };
  } catch (error) {
    if (error instanceof HostedServiceLevelDerivationError) {
      throw error;
    }
    const code = isErrno(error, "ENOENT") ? "SOURCE_INPUT_MISSING" : "SOURCE_INPUT_INVALID";
    throw new HostedServiceLevelDerivationError(code, "Private hosted source input could not be read", { cause: error });
  }
}

const maximumInputBytes = 32 * 1024 * 1024;

async function readPrivateInput(path: string): Promise<string> {
  let handle: FileHandle | undefined;
  try {
    const pathStatus = await lstat(path);
    assertPrivateRegularFile(pathStatus, path);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    assertPrivateRegularFile(before, path);
    if (before.dev !== pathStatus.dev || before.ino !== pathStatus.ino) {
      throw new Error(`Private input changed before read: ${path}`);
    }
    if (before.size < 1 || before.size > maximumInputBytes) {
      throw new Error(`Private input size is unsafe: ${path}`);
    }
    const bytes = new Uint8Array(before.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`Private input changed while reading: ${path}`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } finally {
    await handle?.close();
  }
}

async function writeCreateOnlyPrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStatus = await lstat(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink() ||
    (directoryStatus.mode & 0o077) !== 0 ||
    typeof process.getuid === "function" && directoryStatus.uid !== process.getuid()) {
    throw new Error("Service-level output directory must be a private owned directory");
  }
  const temporaryPath = `${path}.partial-${process.pid}-${Date.now()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, path);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
  assertPrivateRegularFile(await lstat(path), path);
}

async function assertMissing(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists and will not be replaced`);
}

function assertPrivateRegularFile(status: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (status.isSymbolicLink() || !status.isFile() || (Number(status.mode) & 0o777) !== 0o600 ||
    typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error(`Expected a regular owned mode-0600 file: ${path}`);
  }
}

function parseJson(contents: string, label: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new HostedServiceLevelDerivationError(
      "SOURCE_INPUT_INVALID", `${label} is not valid JSON`, { cause: error },
    );
  }
}

function failureDetails(error: unknown): { readonly code: HostedServiceLevelFailureCode; readonly message: string } {
  return error instanceof HostedServiceLevelDerivationError
    ? { code: error.code, message: error.message }
    : { code: "SOURCE_INPUT_INVALID", message: error instanceof Error ? error.message : "Unknown source failure" };
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function main(): Promise<void> {
  const config = loadCollectHostedServiceLevelsConfig(process.env);
  const serviceLevels = await collectHostedServiceLevels(config);
  process.stdout.write(`${JSON.stringify({
    campaignId: config.campaignId,
    kind: "hosted-service-levels-completion",
    measurementCount: serviceLevels.measurements.length,
    meetingId: config.meetingId,
    outputPath: config.outputPath,
    recordingId: config.recordingId,
    reportPath: config.reportPath,
    runId: config.runId,
    status: "ready",
  })}\n`);
}

const invokedAsEntrypoint = process.argv[1]?.endsWith("collect-hosted-service-levels.js") === true;
if (invokedAsEntrypoint) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown hosted SLA failure"}\n`);
    process.exitCode = 1;
  });
}
