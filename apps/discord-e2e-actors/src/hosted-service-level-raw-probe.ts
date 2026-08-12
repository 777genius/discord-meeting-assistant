import type { DatabaseObservation, S3RecordingEvidence } from
  "./e2e-retained-evidence-contracts.js";
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
  sample(): Promise<{ readonly bootId: string; readonly epochMs: number; readonly monotonicNs: string }>;
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

const defaultClockObserver: HostedClockObserver = {
  async sample() {
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    return clockSampleSchema.parse({
      bootId,
      epochMs: Date.now(),
      monotonicNs: process.hrtime.bigint().toString(),
    });
  },
};

const sourceClockBracketScript = `
const fs = require("node:fs");
const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
const sample = () => ({ bootId, epochMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() });
process.stdout.write(JSON.stringify({ before: sample(), sample: sample(), after: sample() }) + "\\n");
`;

export class SshHostedServiceLevelRawProbe {
  readonly #commands: HostedServiceLevelRawProbeCommands;
  readonly #clockObserver: HostedClockObserver;
  readonly #settings: SshDeploymentProbeSettings;

  constructor(
    remote: HostedServiceLevelSourceConfig["remote"],
    commands: HostedServiceLevelRawProbeCommands = defaultCommands,
    clockObserver: HostedClockObserver = defaultClockObserver,
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
    this.#clockObserver = clockObserver;
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

  async collectClockCompletion(): Promise<HostedClockExchangeV2> {
    const before = await this.#clockObserver.sample();
    const output = await this.#commands.runCompose(this.#settings, "meeting-platform", [
      "node", "--input-type=commonjs", "-e", sourceClockBracketScript,
    ]);
    const after = await this.#clockObserver.sample();
    return {
      observer: { after, before },
      observerClockId: `host:${this.#settings.host}`,
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
    manifestLocator: string,
    recordingId: string,
  ): Promise<S3RecordingEvidence> {
    const output = await this.#commands.runCompose(this.#settings, "meeting-platform", [
      "node",
      "--input-type=module",
      "-e",
      s3EvidenceScript,
      manifestLocator,
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
