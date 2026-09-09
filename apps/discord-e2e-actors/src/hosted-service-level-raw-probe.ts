import type { DatabaseObservation, DeploymentEvidenceProbe, S3RecordingEvidence } from
  "./e2e-retained-evidence-contracts.js";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import { z } from "zod";

import type { HostedClockExchangeV2 } from "./hosted-clock-proof-v2.js";
import type { HostedServiceLevelSourceConfig } from "./hosted-service-level-source-config.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";
import {
  parseLastJsonLine,
  runDockerComposeProbe,
  runRemoteProbe,
} from "./ssh-deployment-probe-commands.js";
import {
  postgresEvidenceQuery,
  s3EvidenceScript,
} from "./ssh-deployment-probe-scripts.js";
import {
  correlationId,
  databaseOutputSchema,
  parseDockerContainerId,
  recordingStartedAtSchema,
  s3OutputSchema,
  type SshDeploymentProbeSettings,
} from "./ssh-deployment-probe-validation.js";

export interface HostedServiceLevelRawProbeCommands {
  readonly runCompose: typeof runDockerComposeProbe;
  readonly runRemote: typeof runRemoteProbe;
}

export interface HostedClockObserver {
  sample(signal?: AbortSignal): Promise<{ readonly bootId: string; readonly epochMs: number; readonly monotonicNs: string }>;
}

const defaultCommands: HostedServiceLevelRawProbeCommands = {
  runCompose: runDockerComposeProbe,
  runRemote: runRemoteProbe,
};

const clockSampleSchema = z.object({
  bootId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u),
  epochMs: z.number().int().nonnegative(),
  monotonicNs: z.string().regex(/^(?:0|[1-9]\d*)$/u),
}).strict();
const sourceClockBracketSchema = z.object({
  after: clockSampleSchema,
  before: clockSampleSchema,
  sample: clockSampleSchema,
}).strict();

const bootSessionIdSchema = z.string().regex(
  /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/u,
);

const sourceClockBracketScript = `
const fs = require("node:fs");
const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase();
const sample = () => ({ bootId, epochMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() });
process.stdout.write(JSON.stringify({ before: sample(), sample: sample(), after: sample() }) + "\\n");
`;

export interface LocalHostedClockObserverDependencies {
  readonly monotonicNow: () => bigint;
  readonly now: () => number;
  readonly platform: NodeJS.Platform;
  readonly readFile: (path: string, encoding: "utf8") => Promise<string>;
  readonly runFile: (file: string, args: readonly string[], options: Readonly<{
    encoding: "utf8"; maxBuffer: number; timeout: number;
  }>) => Promise<string>;
}

const defaultClockObserverDependencies: LocalHostedClockObserverDependencies = {
  monotonicNow: () => process.hrtime.bigint(), now: Date.now, platform: process.platform, readFile,
  runFile: runBoundedFile,
};

export class LocalHostedClockObserver implements HostedClockObserver {
  readonly #bootId: Promise<string>;
  readonly #dependencies: LocalHostedClockObserverDependencies;

  constructor(
    dependencies: LocalHostedClockObserverDependencies = defaultClockObserverDependencies,
  ) {
    this.#dependencies = dependencies;
    this.#bootId = readLocalBootSessionId(dependencies);
  }

  async sample(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return clockSampleSchema.parse({
      bootId: await this.#bootId,
      epochMs: this.#dependencies.now(),
      monotonicNs: this.#dependencies.monotonicNow().toString(),
    });
  }
}

async function readLocalBootSessionId(
  dependencies: LocalHostedClockObserverDependencies,
): Promise<string> {
  const raw = dependencies.platform === "linux"
    ? await dependencies.readFile("/proc/sys/kernel/random/boot_id", "utf8")
    : dependencies.platform === "darwin"
      ? await dependencies.runFile("sysctl", ["-n", "kern.bootsessionuuid"], {
          encoding: "utf8", maxBuffer: 1_024, timeout: 2_000,
        })
      : Promise.reject(new Error(`Unsupported clock observer platform: ${dependencies.platform}`));
  return bootSessionIdSchema.parse((await raw).trim().toLowerCase());
}

function runBoundedFile(
  file: string,
  args: readonly string[],
  options: Readonly<{ encoding: "utf8"; maxBuffer: number; timeout: number }>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], options, (error, stdout) => {
      if (error === null) { resolve(stdout); }
      else { reject(new Error("Unable to read the local boot session identity", { cause: error })); }
    });
  });
}

export class SshHostedServiceLevelRawProbe {
  readonly #commands: HostedServiceLevelRawProbeCommands;
  readonly #clockObserver: HostedClockObserver;
  readonly #settings: SshDeploymentProbeSettings;

  constructor(
    remote: HostedServiceLevelSourceConfig["remote"],
    commands: HostedServiceLevelRawProbeCommands = defaultCommands,
    clockObserver?: HostedClockObserver,
  ) {
    this.#settings = {
      attestationFile: "/tmp/discord-e2e-attestations/unused-read-only-source-capture.json",
      composeFile: remote.composeFile,
      craigProjectName: remote.craigProjectName,
      craigServiceName: remote.craigServiceName,
      envFile: remote.environmentFile,
      host: remote.host,
      includePipecatProvenance: false,
      mutationTarget: remote.mutationTarget,
      projectName: remote.projectName,
      sourceRoot: remote.sourceRoot,
      timeoutMs: 330_000,
    };
    this.#commands = commands;
    this.#clockObserver = clockObserver ?? new LocalHostedClockObserver();
  }

  async collectDatabase(recordingId: string): Promise<DatabaseObservation> {
    const validatedId = correlationId.parse(recordingId);
    const output = await this.#commands.runCompose(this.#settings, "postgres", [
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

  async collectClockCompletion(signal?: AbortSignal): Promise<HostedClockExchangeV2> {
    return this.#collectClockExchange(signal);
  }

  async collectClockPreflight(signal?: AbortSignal): Promise<HostedClockExchangeV2> {
    return this.#collectClockExchange(signal);
  }

  async #collectClockExchange(signal?: AbortSignal): Promise<HostedClockExchangeV2> {
    const before = await this.#clockObserver.sample(signal);
    const output = await this.#commands.runCompose(this.#settings, "meeting-platform", [
      "node", "--input-type=commonjs", "-e", sourceClockBracketScript,
    ], signal);
    const after = await this.#clockObserver.sample(signal);
    return {
      observer: { after, before },
      observerClockId: "local-actor-clock",
      source: sourceClockBracketSchema.parse(parseLastJsonLine(output)),
      sourceClockId: "container:meeting-platform",
      target: {
        environment: HOSTED_CAMPAIGN_TARGET.environment,
        host: HOSTED_CAMPAIGN_TARGET.host,
        project: HOSTED_CAMPAIGN_TARGET.project,
      },
    };
  }

  async collectS3(
    recording: Parameters<DeploymentEvidenceProbe["collectS3"]>[0],
    recordingId: string,
  ): Promise<S3RecordingEvidence> {
    const output = await this.#commands.runCompose(this.#settings, "meeting-platform", [
      "node",
      "--input-type=module",
      "-e",
      s3EvidenceScript,
      JSON.stringify(recording),
      correlationId.parse(recordingId),
    ]);
    return s3OutputSchema.parse(parseLastJsonLine(output));
  }

  async collectMeetingPlatformLogs(
    meetingId: string,
    recordingStartedAt: string,
  ): Promise<string> {
    const validatedMeetingId = correlationId.parse(meetingId);
    const containerId = await this.#findMeetingPlatformContainer();
    const output = await this.#commands.runRemote(this.#settings, [
      "docker",
      "logs",
      "--since",
      recordingStartedAtSchema.parse(recordingStartedAt),
      containerId,
    ]);
    const lines = output.split("\n").flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return typeof value === "object" && value !== null && !Array.isArray(value) &&
            "meetingId" in value && value.meetingId === validatedMeetingId
          ? [JSON.stringify(value)] : [];
      } catch {
        return [];
      }
    });
    if (lines.length === 0) {
      throw new Error("Meeting Platform emitted no correlated JSON logs for the hosted SLA run");
    }
    return `${lines.join("\n")}\n`;
  }

  async #findMeetingPlatformContainer(): Promise<string> {
    const containerIds = (await this.#commands.runRemote(this.#settings, [
      "docker",
      "ps",
      "--no-trunc",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${this.#settings.projectName}`,
      "--filter",
      "label=com.docker.compose.service=meeting-platform",
    ])).trim().split("\n").filter((value) => value.length > 0);
    if (containerIds.length !== 1) {
      throw new Error(`Expected one running Meeting Platform container, found ${containerIds.length}`);
    }
    return parseDockerContainerId(containerIds[0]);
  }
}
