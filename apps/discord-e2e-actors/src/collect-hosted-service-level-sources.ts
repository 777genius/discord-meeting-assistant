import { hostedServiceLevelClockBindingRequest } from "./hosted-service-levels.js";
import {
  hostedServiceLevelSourceConfigSchema,
  loadHostedServiceLevelSourceConfig,
  type HostedServiceLevelSourceConfig,
} from "./hosted-service-level-source-config.js";
import {
  hostedServiceLevelSourceReportV1Schema,
  privateHostedServiceLevelArtifactExists,
  readPrivateHostedServiceLevelArtifact,
  writeCreateOnlyPrivateHostedServiceLevelArtifact,
} from "./hosted-service-level-source-artifact.js";
import { attestHostedServiceLevelClocksV2 } from "./hosted-service-level-clock-preflight.js";
import { bindHostedClockRunV2 } from "./hosted-clock-proof-v2.js";
import { SshHostedServiceLevelRawProbe } from "./hosted-service-level-raw-probe.js";
import {
  databaseOutputSchema,
  s3OutputSchema,
} from "./ssh-deployment-probe-validation.js";
import { normalizeDatabase } from "./e2e-retained-evidence-snapshot.js";

export interface HostedServiceLevelRawProbe {
  collectClockCompletion(): Promise<unknown>;
  collectDatabase(recordingId: string): Promise<unknown>;
  collectMeetingPlatformLogs(meetingId: string, recordingStartedAt: string): Promise<string>;
  collectS3(manifestLocator: string, recordingId: string): Promise<unknown>;
}

export class HostedServiceLevelSourceCaptureBlockedError extends Error {}

interface SourceValues {
  readonly campaignProof: unknown;
  readonly fixtureManifest: unknown;
  readonly playbackLinkProof: unknown;
  readonly readyReceipt: unknown;
  readonly supplementalPlayback: unknown;
  readonly voice: readonly unknown[];
}

export async function collectHostedServiceLevelSources(
  configValue: HostedServiceLevelSourceConfig,
  probe: HostedServiceLevelRawProbe,
): Promise<void> {
  const config = hostedServiceLevelSourceConfigSchema.parse(configValue);
  await assertAllOutputsMissing(config);
  if (config.clockPreflightPath === undefined) {
    await block(config, "CLOCK_PREFLIGHT_MISSING", "External host clock-skew preflight is required");
  }
  const clockPreflightPath = requireClockPreflightPath(config.clockPreflightPath);
  try {
    const [sources, preflight] = await Promise.all([
      readSourceValues(config),
      readPrivateJson(clockPreflightPath),
    ]);
    const database = databaseOutputSchema.parse(await probe.collectDatabase(config.recordingId));
    const snapshot = normalizeDatabase(database).snapshot;
    if (snapshot.meetingId !== config.meetingId || snapshot.recording.recordingId !== config.recordingId) {
      throw new Error("Postgres source does not match the requested meeting and recording");
    }
    const s3 = s3OutputSchema.parse(await probe.collectS3(
      snapshot.recording.manifestLocator,
      config.recordingId,
    ));
    const meetingPlatformLogs = await probe.collectMeetingPlatformLogs(
      config.meetingId,
      s3.startedAt,
    );
    const request = await hostedServiceLevelClockBindingRequest({
      ...sources,
      database,
      meetingPlatformLogs,
      runId: config.runId,
      s3,
    });
    if (
      request.runId !== config.runId || request.meetingId !== config.meetingId ||
      request.recordingId !== config.recordingId
    ) {
      throw new Error("Hosted SLA sources do not match the declared identity");
    }
    const completion = await probe.collectClockCompletion();
    const runClock = bindHostedClockRunV2({
      admission: preflight,
      completion,
      meetingId: request.meetingId,
      recordingId: request.recordingId,
      runId: request.runId,
    });
    const clockAttestations = attestHostedServiceLevelClocksV2(runClock, request);
    await publishOutputs(config, { clockAttestations, database, meetingPlatformLogs, s3 });
  } catch (error) {
    if (error instanceof HostedServiceLevelSourceCaptureBlockedError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown hosted SLA source failure";
    await block(config, "SOURCE_CAPTURE_FAILED", message, error);
  }
}

function requireClockPreflightPath(path: string | undefined): string {
  if (path === undefined) {
    throw new Error("Clock preflight path remained absent after blocked report publication");
  }
  return path;
}

async function readSourceValues(config: HostedServiceLevelSourceConfig): Promise<SourceValues> {
  const paths = config.sources;
  const values = await Promise.all([
    readPrivateJson(paths.campaignProof),
    readPrivateJson(paths.fixtureManifest),
    readPrivateJson(paths.playbackLinkProof),
    readPrivateJson(paths.readyReceipt),
    readPrivateJson(paths.supplementalPlayback),
    ...paths.voice.map(readPrivateJson),
  ]);
  return {
    campaignProof: values[0],
    fixtureManifest: values[1],
    playbackLinkProof: values[2],
    readyReceipt: values[3],
    supplementalPlayback: values[4],
    voice: values.slice(5),
  };
}

const json = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

async function publishOutputs(
  config: HostedServiceLevelSourceConfig,
  values: {
    readonly clockAttestations: unknown;
    readonly database: unknown;
    readonly meetingPlatformLogs: string;
    readonly s3: unknown;
  },
): Promise<void> {
  await writeCreateOnlyPrivateHostedServiceLevelArtifact(
    config.outputs.database,
    json(values.database),
  );
  await writeCreateOnlyPrivateHostedServiceLevelArtifact(config.outputs.s3, json(values.s3));
  await writeCreateOnlyPrivateHostedServiceLevelArtifact(
    config.outputs.meetingPlatformLogs,
    values.meetingPlatformLogs,
  );
  await writeCreateOnlyPrivateHostedServiceLevelArtifact(
    config.outputs.clockAttestations,
    json(values.clockAttestations),
  );
  await writeCreateOnlyPrivateHostedServiceLevelArtifact(config.outputs.report, json(
    hostedServiceLevelSourceReportV1Schema.parse({
      campaignId: config.campaignId,
      meetingId: config.meetingId,
      outputs: {
        clockAttestations: config.outputs.clockAttestations,
        database: config.outputs.database,
        meetingPlatformLogs: config.outputs.meetingPlatformLogs,
        s3: config.outputs.s3,
      },
      outputsCreated: true,
      recordingId: config.recordingId,
      reportPath: config.outputs.report,
      runId: config.runId,
      schemaVersion: 1,
      status: "ready",
    }),
  ));
}

async function block(
  config: HostedServiceLevelSourceConfig,
  code: "CLOCK_PREFLIGHT_MISSING" | "SOURCE_CAPTURE_FAILED",
  message: string,
  cause?: unknown,
): Promise<never> {
  const outputEntries = [
    ["clockAttestations", config.outputs.clockAttestations],
    ["database", config.outputs.database],
    ["meetingPlatformLogs", config.outputs.meetingPlatformLogs],
    ["s3", config.outputs.s3],
  ] as const;
  const outputExists = await Promise.all(outputEntries.map(([, path]) =>
    privateHostedServiceLevelArtifactExists(path)
  ));
  const createdOutputs = outputEntries.flatMap(([name], index) =>
    outputExists[index] === true ? [name] : []
  );
  await writeCreateOnlyPrivateHostedServiceLevelArtifact(config.outputs.report, `${JSON.stringify(
    hostedServiceLevelSourceReportV1Schema.parse({
      campaignId: config.campaignId,
      code,
      createdOutputs,
      meetingId: config.meetingId,
      message,
      outputsCreated: false,
      recordingId: config.recordingId,
      reportPath: config.outputs.report,
      runId: config.runId,
      schemaVersion: 1,
      status: "blocked",
    }),
    undefined,
    2,
  )}\n`);
  throw new HostedServiceLevelSourceCaptureBlockedError(
    `Hosted service-level source capture blocked [${code}]: ${message}`,
    { cause },
  );
}

async function assertAllOutputsMissing(config: HostedServiceLevelSourceConfig): Promise<void> {
  const entries = Object.entries(config.outputs);
  const exists = await Promise.all(entries.map(([, path]) =>
    privateHostedServiceLevelArtifactExists(path)
  ));
  const collision = entries.find((_entry, index) => exists[index] === true);
  if (collision !== undefined) {
    throw new Error(`Hosted service-level ${collision[0]} output already exists and will not be replaced`);
  }
}

async function readPrivateJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readPrivateHostedServiceLevelArtifact(path)) as unknown;
  } catch (error) {
    throw new Error(`Private hosted service-level JSON source is invalid: ${path}`, { cause: error });
  }
}

function makeSshProbe(config: HostedServiceLevelSourceConfig): SshHostedServiceLevelRawProbe {
  return new SshHostedServiceLevelRawProbe(config.remote);
}

async function main(): Promise<void> {
  const config = loadHostedServiceLevelSourceConfig(process.env);
  await collectHostedServiceLevelSources(config, makeSshProbe(config));
  process.stdout.write(`${JSON.stringify({
    campaignId: config.campaignId,
    clockAttestationsPath: config.outputs.clockAttestations,
    databasePath: config.outputs.database,
    kind: "hosted-service-level-sources-completion",
    meetingId: config.meetingId,
    meetingPlatformLogsPath: config.outputs.meetingPlatformLogs,
    recordingId: config.recordingId,
    reportPath: config.outputs.report,
    runId: config.runId,
    s3Path: config.outputs.s3,
    status: "ready",
  })}\n`);
}

if (process.argv[1]?.endsWith("collect-hosted-service-level-sources.js") === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Unknown hosted SLA source failure"}\n`);
    process.exitCode = 1;
  });
}
