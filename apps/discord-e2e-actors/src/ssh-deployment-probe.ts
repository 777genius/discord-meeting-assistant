import { createHash } from "node:crypto";

import type {
  DatabaseObservation,
  DeploymentEvidenceProbe,
  ReplayJobEvidence,
  S3RecordingEvidence,
} from "./e2e-collector.js";
import type { ReplayTargetAttestation } from "./e2e-retained-evidence-contracts.js";
import type {
  CurrentDeploymentProvenance,
  DeployedServiceProvenance,
} from "./e2e-evidence.js";
import {
  parseConversationLifecycleEvidenceLogs,
  parseProcessingEvidenceLogs,
} from "./e2e-processing-log-parser.js";
import {
  parseLastJsonLine,
  runDockerContainerProbe,
  runDockerComposeProbe,
  runRemoteProbe,
} from "./ssh-deployment-probe-commands.js";
import {
  containerProvenanceFormat,
  imageProvenanceFormat,
  postgresEvidenceQuery,
  replayJobScript,
  replayReadinessScript,
  replayTargetContainerFormat,
  s3EvidenceScript,
} from "./ssh-deployment-probe-scripts.js";
import {
  assertReplayTargetAttestation,
  assertReplayTargetContainer,
  containerProvenanceOutputSchema,
  correlationId,
  databaseOutputSchema,
  imageProvenanceOutputSchema,
  parseDockerContainerId,
  parseSshDeploymentProbeOptions,
  replayOutputSchema,
  replayReadinessOutputSchema,
  recordingStartedAtSchema,
  s3OutputSchema,
  type SshDeploymentProbeOptions,
  type SshDeploymentProbeSettings,
} from "./ssh-deployment-probe-validation.js";

export type { SshDeploymentProbeOptions } from "./ssh-deployment-probe-validation.js";

export interface SshDeploymentProbeCommands {
  readonly runContainer: typeof runDockerContainerProbe;
  readonly runCompose: typeof runDockerComposeProbe;
  readonly runRemote: typeof runRemoteProbe;
}

const defaultCommands: SshDeploymentProbeCommands = {
  runContainer: runDockerContainerProbe,
  runCompose: runDockerComposeProbe,
  runRemote: runRemoteProbe,
};

const attestationFileGuard = [
  "set -eu",
  "directory=${1%/*}",
  'test -d "$directory"',
  'test ! -L "$directory"',
  'test -f "$1"',
  'test ! -L "$1"',
  '[ "$(stat -c %u -- "$directory")" = "$(id -u)" ]',
  '[ "$(stat -c %a -- "$directory")" = 700 ]',
  '[ "$(stat -c %u -- "$1")" = "$(id -u)" ]',
  '[ "$(stat -c %a -- "$1")" = 600 ]',
  '[ "$(stat -c %s -- "$1")" -le 4096 ]',
] as const;

export class SshDeploymentEvidenceProbe implements DeploymentEvidenceProbe {
  readonly #commands: SshDeploymentProbeCommands;
  readonly #options: SshDeploymentProbeSettings;

  public constructor(
    options: SshDeploymentProbeOptions,
    commands: SshDeploymentProbeCommands = defaultCommands,
  ) {
    this.#commands = commands;
    this.#options = parseSshDeploymentProbeOptions(options);
  }

  public async assertReplayTargetSafe(attestation: ReplayTargetAttestation): Promise<void> {
    await this.#inspectReplayTarget(attestation);
  }

  public async assertRecordingPlaybackTargetSafe(
    input: {
      readonly meetingPlatformContainerId: string;
      readonly origin: string;
      readonly scope: string;
    },
  ): Promise<void> {
    if (input.scope !== "private-test-deployment") {
      throw new Error("Recording playback target has an invalid test scope");
    }
    const containerId = await this.#findContainerId(
      this.#options.projectName,
      "meeting-platform",
    );
    if (containerId !== input.meetingPlatformContainerId) {
      throw new Error("Recording playback target changed after provenance collection");
    }
    const container = parseLastJsonLine(await this.#commands.runRemote(this.#options, [
      "docker",
      "inspect",
      "--format",
      replayTargetContainerFormat,
      containerId,
    ]));
    assertReplayTargetContainer(container);
    await this.#assertRecordingPlaybackOrigin(containerId, input.origin);
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

  public async collectProcessing(meetingId: string, recordingStartedAt: string) {
    const validatedMeetingId = correlationId.parse(meetingId);
    const containerId = await this.#findContainerId(this.#options.projectName, "meeting-platform");
    const output = await this.#commands.runRemote(this.#options, [
      "docker",
      "logs",
      "--since",
      recordingStartedAtSchema.parse(recordingStartedAt),
      containerId,
    ]);
    return parseProcessingEvidenceLogs(output, validatedMeetingId);
  }

  public async collectConversationLifecycle(meetingId: string, recordingStartedAt: string) {
    const validatedMeetingId = correlationId.parse(meetingId);
    const containerId = await this.#findContainerId(this.#options.projectName, "meeting-platform");
    const output = await this.#commands.runRemote(this.#options, [
      "docker",
      "logs",
      "--since",
      recordingStartedAtSchema.parse(recordingStartedAt),
      containerId,
    ]);
    return parseConversationLifecycleEvidenceLogs(output, validatedMeetingId);
  }

  public async collectProvenance(): Promise<CurrentDeploymentProvenance> {
    const [craig, meetingPlatform, pipecat, subscriptionRuntime] = await Promise.all([
      this.#collectServiceProvenance(
        this.#options.craigProjectName,
        this.#options.craigServiceName,
      ),
      this.#collectServiceProvenance(this.#options.projectName, "meeting-platform"),
      this.#options.includePipecatProvenance
        ? this.#collectServiceProvenance(this.#options.projectName, "pipecat-runtime")
        : undefined,
      this.#collectServiceProvenance(this.#options.projectName, "subscription-runtime-sidecar"),
    ]);
    return {
      craig,
      meetingPlatform,
      subscriptionRuntime,
      ...(pipecat === undefined ? {} : { pipecat }),
    };
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

  public async replayPostCall(
    attestation: ReplayTargetAttestation,
  ): Promise<ReplayJobEvidence> {
    const initialTarget = await this.#inspectReplayTarget(attestation);
    const readiness = replayReadinessOutputSchema.parse(parseLastJsonLine(
      await this.#commands.runContainer(this.#options, initialTarget.containerId, [
        "node",
        "--input-type=module",
        "-e",
        replayReadinessScript,
        attestation.recordingId,
      ]),
    ));
    const confirmedTarget = await this.#inspectReplayTarget(attestation);
    if (confirmedTarget.containerId !== initialTarget.containerId) {
      throw new Error("Replay target container changed after safety preflight");
    }
    await this.#consumeReplayMarker(confirmedTarget.markerDocument);
    const replay = replayOutputSchema.parse(parseLastJsonLine(
      await this.#commands.runContainer(this.#options, initialTarget.containerId, [
        "node",
        "--input-type=module",
        "-e",
        replayJobScript,
        attestation.recordingId,
        String(readiness.beforeProcessedOn),
      ]),
    ));
    if (
      replay.jobId !== readiness.jobId ||
      replay.beforeProcessedOn !== readiness.beforeProcessedOn
    ) {
      throw new Error("Replay result does not match the completed-job safety preflight");
    }
    return replay;
  }

  async #collectServiceProvenance(
    projectName: string,
    serviceName: string,
  ): Promise<DeployedServiceProvenance> {
    const containerId = await this.#findContainerId(projectName, serviceName);
    const container = containerProvenanceOutputSchema.parse(parseLastJsonLine(
      await this.#commands.runRemote(this.#options, [
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
      await this.#commands.runRemote(this.#options, [
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

  async #findContainerId(projectName: string, serviceName: string): Promise<string> {
    const containerIds = (await this.#commands.runRemote(this.#options, [
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
    return parseDockerContainerId(containerIds[0]);
  }

  async #assertRecordingPlaybackOrigin(containerId: string, expectedOrigin: string): Promise<void> {
    const output = (await this.#commands.runRemote(this.#options, [
      "docker",
      "exec",
      containerId,
      "printenv",
      "RECORDING_PLAYBACK_PUBLIC_BASE_URL",
    ])).trim();
    let actualOrigin: string;
    try {
      const url = new URL(output);
      if (url.protocol !== "https:" || url.origin !== output) {
        throw new Error("not an exact HTTPS origin");
      }
      actualOrigin = url.origin;
    } catch {
      throw new Error("Test deployment has no valid recording playback HTTPS origin");
    }
    if (actualOrigin !== expectedOrigin) {
      throw new Error("Recording playback origin does not match the attested test deployment");
    }
  }

  async #dockerExec(
    service: "meeting-platform" | "postgres",
    args: readonly string[],
  ): Promise<string> {
    return this.#commands.runCompose(this.#options, service, args);
  }

  async #inspectReplayTarget(attestation: ReplayTargetAttestation): Promise<{
    readonly containerId: string;
    readonly markerDocument: string;
  }> {
    const containerId = await this.#findContainerId(
      this.#options.projectName,
      "meeting-platform",
    );
    const [containerOutput, markerDocument] = await Promise.all([
      this.#commands.runRemote(this.#options, [
        "docker",
        "inspect",
        "--format",
        replayTargetContainerFormat,
        containerId,
      ]),
      this.#commands.runRemote(this.#options, [
        "sh",
        "-c",
        [...attestationFileGuard, 'cat -- "$1"'].join("; "),
        "discord-e2e-attestation",
        this.#options.attestationFile,
      ]),
    ]);
    assertReplayTargetAttestation(
      parseLastJsonLine(containerOutput),
      parseMarkerDocument(markerDocument),
      attestation,
    );
    return { containerId, markerDocument };
  }

  async #consumeReplayMarker(markerDocument: string): Promise<void> {
    const expectedChecksum = createHash("sha256").update(markerDocument).digest("hex");
    await this.#commands.runRemote(this.#options, [
      "sh",
      "-c",
      [
        ...attestationFileGuard,
        'actual=$(sha256sum -- "$1")',
        'actual=${actual%% *}',
        '[ "$actual" = "$2" ]',
        'rm -- "$1"',
      ].join("; "),
      "discord-e2e-attestation-consume",
      this.#options.attestationFile,
      expectedChecksum,
    ]);
  }
}

function parseMarkerDocument(document: string): unknown {
  if (Buffer.byteLength(document, "utf8") > 4_096) {
    throw new Error("Remote replay marker exceeds 4 KiB");
  }
  try {
    return JSON.parse(document) as unknown;
  } catch {
    throw new Error("Remote replay marker is not valid JSON");
  }
}
