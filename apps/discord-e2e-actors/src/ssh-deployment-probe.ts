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
  completionReceiptsScript,
  postgresEvidenceQuery,
  replayJobScript,
  replayReadinessScript,
  replayTargetContainerFormat,
  s3EvidenceScript,
} from "./ssh-deployment-probe-scripts.js";
import {
  assertReplayTargetAttestation,
  assertReplayTargetContainer,
  completionReceiptsOutputSchema,
  correlationId,
  databaseOutputSchema,
  parseDockerContainerId,
  parseReplayMarkerDocument,
  parseSshDeploymentProbeOptions,
  replayOutputSchema,
  replayReadinessOutputSchema,
  recordingStartedAtSchema,
  s3OutputSchema,
  type SshDeploymentProbeOptions,
  type SshDeploymentProbeSettings,
} from "./ssh-deployment-probe-validation.js";
import { collectServiceProvenance } from "./ssh-deployment-probe-provenance.js";
import {
  collectQualificationGreetingRows, collectQualificationHistoricalAdmission,
  collectQualificationHistoricalReadiness,
  collectQualificationLiveRows, collectQualificationLogs,
  collectQualificationQuestionOutcome, collectQualificationSettlement,
  collectQualificationWorker,
} from "./ssh-deployment-probe-qualification.js";

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

  public async collectHistoricalReplyReadiness(meetingId: string) {
    return collectQualificationHistoricalReadiness(this.#qualificationPorts(), meetingId); }

  public async collectHistoricalReplyQuestionOutcome(questionId: string) {
    return collectQualificationQuestionOutcome(this.#qualificationPorts(), questionId); }

  public async collectHistoricalReplySettlement(questionId: string) {
    return collectQualificationSettlement(this.#qualificationPorts(), questionId); }

  public async collectGreetingLedgerRows(receiptIds: readonly [string, string, string, string]) {
    return collectQualificationGreetingRows(this.#qualificationPorts(), receiptIds); }

  public async collectLiveMemoryRows(meetingId: string) {
    return collectQualificationLiveRows(this.#qualificationPorts(), meetingId); }

  public async collectMeetingPlatformLogsSince(since: string): Promise<string> {
    return collectQualificationLogs(this.#qualificationPorts(), since); }

  public async collectMeetingPlatformWorkerProcess() {
    return collectQualificationWorker(this.#qualificationPorts()); }

  public async restartMeetingPlatformForPrivateTest(): Promise<void> {
    await this.#qualificationPorts().restartMeetingPlatform();
  }

  public async collectHistoricalReplyQuestionAdmission(questionId: string) {
    return collectQualificationHistoricalAdmission(this.#qualificationPorts(), questionId);
  }

  #qualificationPorts() {
    return {
      collectService: () => this.#collectServiceProvenance(this.#options.projectName, "meeting-platform"),
      dockerExecPostgres: (arguments_: readonly string[]) => this.#dockerExec("postgres", arguments_),
      findMeetingPlatformContainerId: () => this.#findContainerId(this.#options.projectName, "meeting-platform"),
      restartMeetingPlatform: () => this.#commands.runRemote(this.#options, [
        "docker", "compose", "--project-directory", this.#options.sourceRoot,
        "--env-file", this.#options.envFile, "-f", this.#options.composeFile,
        "-p", this.#options.projectName, "restart", "--timeout", "30", "meeting-platform",
      ]),
      runRemote: (arguments_: readonly string[]) => this.#commands.runRemote(this.#options, arguments_),
    };
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
    const since = recordingStartedAtSchema.parse(recordingStartedAt);
    const [meetingPlatformContainerId, craigContainerId] = await Promise.all([
      this.#findContainerId(this.#options.projectName, "meeting-platform"),
      this.#findContainerId(this.#options.craigProjectName, this.#options.craigServiceName),
    ]);
    const [meetingPlatformOutput, craigOutput] = await Promise.all([
      this.#commands.runRemote(this.#options, [
        "docker", "logs", "--since", since, meetingPlatformContainerId,
      ]),
      this.#commands.runRemote(this.#options, [
        "docker", "logs", "--since", since, craigContainerId,
      ]),
    ]);
    return parseConversationLifecycleEvidenceLogs(
      `${meetingPlatformOutput}\n${craigOutput}`,
      validatedMeetingId,
    );
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

  public async collectRecordingCompletionReceipts(): Promise<readonly unknown[]> {
    const containerId = await this.#findContainerId(this.#options.projectName, "meeting-platform");
    const output = await this.#commands.runContainer(this.#options, containerId, [
      "node",
      "--input-type=module",
      "-e",
      completionReceiptsScript,
    ]);
    return completionReceiptsOutputSchema.parse(parseLastJsonLine(output));
  }

  public async collectS3(
    recording: Parameters<DeploymentEvidenceProbe["collectS3"]>[0],
    recordingId: string,
  ): Promise<S3RecordingEvidence> {
    const output = await this.#dockerExec("meeting-platform", [
      "node",
      "--input-type=module",
      "-e",
      s3EvidenceScript,
      JSON.stringify(recording),
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
    return collectServiceProvenance({
      findContainerId: (project, service) => this.#findContainerId(project, service),
      projectName,
      runRemote: (arguments_) => this.#commands.runRemote(this.#options, arguments_),
      serviceName,
    });
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
    const attestationFile = this.#replayAttestationFile();
    const provenance = await this.#collectServiceProvenance(this.#options.projectName, "meeting-platform");
    const [containerOutput, markerDocument] = await Promise.all([
      this.#commands.runRemote(this.#options, [
        "docker",
        "inspect",
        "--format",
        replayTargetContainerFormat,
        provenance.containerId,
      ]),
      this.#commands.runRemote(this.#options, [
        "sh",
        "-c",
        [...attestationFileGuard, 'cat -- "$1"'].join("; "),
        "discord-e2e-attestation",
        attestationFile,
      ]),
    ]);
    assertReplayTargetAttestation(
      parseLastJsonLine(containerOutput),
      parseReplayMarkerDocument(markerDocument),
      attestation,
      {
        containerId: provenance.containerId,
        imageId: provenance.imageId,
        sourceRevision: provenance.sourceRevision,
      },
    );
    const confirmedContainerId = await this.#findContainerId(
      this.#options.projectName,
      "meeting-platform",
    );
    if (confirmedContainerId !== provenance.containerId) {
      throw new Error("Replay target container changed during immutable provenance inspection");
    }
    return { containerId: provenance.containerId, markerDocument };
  }

  async #consumeReplayMarker(markerDocument: string): Promise<void> {
    const attestationFile = this.#replayAttestationFile();
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
      attestationFile,
      expectedChecksum,
    ]);
  }

  #replayAttestationFile(): string {
    const attestationFile = this.#options.attestationFile;
    if (attestationFile === undefined) {
      throw new Error("Replay target attestation file is required for replay operations");
    }
    return attestationFile;
  }
}
