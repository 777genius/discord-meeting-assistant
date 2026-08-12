import type { DatabaseObservation, S3RecordingEvidence } from
  "./e2e-retained-evidence-contracts.js";
import type { HostedServiceLevelSourceConfig } from "./hosted-service-level-source-config.js";
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

const defaultCommands: HostedServiceLevelRawProbeCommands = {
  runCompose: runDockerComposeProbe,
  runRemote: runRemoteProbe,
};

export class SshHostedServiceLevelRawProbe {
  readonly #commands: HostedServiceLevelRawProbeCommands;
  readonly #settings: SshDeploymentProbeSettings;

  constructor(
    remote: HostedServiceLevelSourceConfig["remote"],
    commands: HostedServiceLevelRawProbeCommands = defaultCommands,
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
