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
import {
  parseLastJsonLine,
  runDockerComposeProbe,
  runRemoteProbe,
} from "./ssh-deployment-probe-commands.js";
import {
  containerProvenanceFormat,
  imageProvenanceFormat,
  postgresEvidenceQuery,
  replayJobScript,
  s3EvidenceScript,
} from "./ssh-deployment-probe-scripts.js";
import {
  containerProvenanceOutputSchema,
  correlationId,
  databaseOutputSchema,
  imageProvenanceOutputSchema,
  parseDockerContainerId,
  parseSshDeploymentProbeOptions,
  replayOutputSchema,
  s3OutputSchema,
  type SshDeploymentProbeOptions,
  type SshDeploymentProbeSettings,
} from "./ssh-deployment-probe-validation.js";

export type { SshDeploymentProbeOptions } from "./ssh-deployment-probe-validation.js";

export class SshDeploymentEvidenceProbe implements DeploymentEvidenceProbe {
  readonly #options: SshDeploymentProbeSettings;

  public constructor(options: SshDeploymentProbeOptions) {
    this.#options = parseSshDeploymentProbeOptions(options);
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
    const containerIds = (await runRemoteProbe(this.#options, [
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
    const containerId = parseDockerContainerId(containerIds[0]);
    const container = containerProvenanceOutputSchema.parse(parseLastJsonLine(
      await runRemoteProbe(this.#options, [
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
      await runRemoteProbe(this.#options, [
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

  async #dockerExec(
    service: "meeting-platform" | "postgres",
    args: readonly string[],
  ): Promise<string> {
    return runDockerComposeProbe(this.#options, service, args);
  }
}
