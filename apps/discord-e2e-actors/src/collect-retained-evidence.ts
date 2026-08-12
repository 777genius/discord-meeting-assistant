import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DiscordJsEvidenceProbe } from "./discord-evidence-probe.js";
import {
  collectRetainedE2eEvidence,
  createReplayTargetAttestation,
} from "./e2e-collector.js";
import { collectorEnvironmentSchema } from "./e2e-collector-environment.js";
import {
  readPrivateLiveDiscordPlaybackLinkProof,
  serviceLevelSourcesFromLiveProof,
} from "./e2e-collector-service-level-input.js";
import {
  conversationVoiceCampaignProofV1Schema,
  conversationVoiceEvidenceV3Schema,
  deploymentRevisionExpectationSchema,
  e2eServiceLevelsV1Schema,
  fixtureManifestV1Schema,
  supplementalPlaybackEvidenceV1Schema,
  serviceLevelThresholdsSchema,
  unboundActorRunEvidenceV1Schema,
  verifyRetainedE2eEvidence,
} from "./e2e-evidence.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";
import { HttpRecordingPlaybackEvidenceProbe } from "./recording-playback-evidence-probe.js";
import { accessDiscordWithBoundConversation } from
  "./conversation-voice-collection-preflight.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";
import { EvidenceProbeInterruptedError } from "./ssh-deployment-probe-commands.js";
import {
  deploymentProvenanceDigest,
  recordingReadyReceiptV1Schema,
} from "./recording-ready-receipt.js";

async function main(): Promise<void> {
  const config = collectorEnvironmentSchema.parse(process.env);
  const [actorRun, manifest, readyReceipt, conversationVoice, supplementalPlayback, campaignProof, serviceLevels, serviceLevelThresholds, playbackLinkProof] = await Promise.all([
    readJson(config.DISCORD_E2E_ACTOR_RUN_INPUT),
    readJson(config.DISCORD_E2E_FIXTURE_MANIFEST).then((value) =>
      fixtureManifestV1Schema.parse(value)
    ),
    readJson(config.DISCORD_E2E_READY_RECEIPT_INPUT).then((value) =>
      recordingReadyReceiptV1Schema.parse(value)
    ),
    Promise.all((config.DISCORD_E2E_CONVERSATION_VOICE_INPUTS ?? []).map((path) =>
      readJson(path).then((value) => conversationVoiceEvidenceV3Schema.parse(value))
    )),
    readSupplementalPlayback(config.DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT),
    readCampaignProof(config.DISCORD_E2E_CONVERSATION_CAMPAIGN_PROOF_INPUT),
    readOptionalJson(config.DISCORD_E2E_SERVICE_LEVELS_INPUT, e2eServiceLevelsV1Schema),
    readOptionalJson(config.DISCORD_E2E_SERVICE_LEVEL_THRESHOLDS_INPUT, serviceLevelThresholdsSchema),
    config.DISCORD_E2E_DISCORD_PLAYBACK_LINK_PROOF_INPUT === undefined
      ? undefined
      : readPrivateLiveDiscordPlaybackLinkProof(config.DISCORD_E2E_DISCORD_PLAYBACK_LINK_PROOF_INPUT),
  ]);
  const serviceLevelSources = playbackLinkProof === undefined || serviceLevels === undefined
    ? undefined
    : serviceLevelSourcesFromLiveProof(playbackLinkProof, serviceLevels, {
        playbackOrigin: config.DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN,
        recordingId: readyReceipt.recordingId,
        runId: config.DISCORD_E2E_RUN_ID,
      });
  const deployment = new SshDeploymentEvidenceProbe({
    attestationFile: config.DISCORD_E2E_REMOTE_ATTESTATION_FILE,
    composeFile: config.DISCORD_E2E_REMOTE_COMPOSE_FILE,
    craigProjectName: config.DISCORD_E2E_REMOTE_CRAIG_PROJECT,
    craigServiceName: config.DISCORD_E2E_REMOTE_CRAIG_SERVICE,
    envFile: config.DISCORD_E2E_REMOTE_ENV_FILE,
    host: config.DISCORD_E2E_REMOTE_HOST,
    includePipecatProvenance:
      config.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION !== undefined,
    mutationTarget: config.DISCORD_E2E_MUTATION_TARGET,
    projectName: config.DISCORD_E2E_REMOTE_PROJECT,
    sourceRoot: config.DISCORD_E2E_REMOTE_SOURCE_ROOT,
  });
  const replayTarget = createReplayTargetAttestation({
    fixtureSetId: manifest.fixtureSetId,
    recordingId: readyReceipt.recordingId,
    runId: config.DISCORD_E2E_RUN_ID,
  }, unboundActorRunEvidenceV1Schema.parse(actorRun));
  await deployment.assertReplayTargetSafe(replayTarget);
  if (readyReceipt.runId !== config.DISCORD_E2E_RUN_ID) {
    throw new Error("Recording-ready receipt does not match the requested run correlation");
  }
  const discord = new DiscordJsEvidenceProbe();
  const rawConversation = config.DISCORD_E2E_BOTIK_SPEAKER_ID === undefined
    ? undefined
    : {
        botSpeakerId: config.DISCORD_E2E_BOTIK_SPEAKER_ID,
        campaignProof: requireDefined(campaignProof, "conversation campaign proof"),
        reconnectParticipantId: reconnectParticipantId(manifest),
        serviceLevels: requireDefined(serviceLevels, "service-level evidence"),
        serviceLevelSources: requireDefined(serviceLevelSources, "service-level source evidence"),
        supplementalPlayback: requireDefined(
          supplementalPlayback,
          "supplemental playback evidence",
        ),
        voice: conversationVoice,
      };
  const secretReader = config.DISCORD_E2E_SECRET_DIRECTORY === undefined
    ? new MacOsKeychainSecretReader(config.DISCORD_E2E_KEYCHAIN_SERVICE)
    : new FileSecretReader(config.DISCORD_E2E_SECRET_DIRECTORY);
  try {
    const evidence = await accessDiscordWithBoundConversation({
      connect: (token) => discord.connect(token),
      rawVoice: rawConversation?.voice,
      readSecret: () => secretReader.read(config.DISCORD_E2E_SUT_ACCOUNT),
      recordingId: readyReceipt.recordingId,
      run: (boundVoice) => collectRetainedE2eEvidence({
        actorRun,
        ...(rawConversation === undefined || boundVoice === undefined
          ? {}
          : { conversation: { ...rawConversation, voice: boundVoice } }),
        fixtureSetId: manifest.fixtureSetId,
        recordingId: readyReceipt.recordingId,
        recordingPlayback: new HttpRecordingPlaybackEvidenceProbe({
          expectedOrigin: config.DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN,
        }),
        recordingPlaybackOrigin: config.DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN,
        recordingPlaybackReadiness: config.DISCORD_E2E_RECORDING_PLAYBACK_READINESS,
        recordingPlaybackTestScope: config.DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE,
        runId: config.DISCORD_E2E_RUN_ID,
      }, deployment, discord),
    });
    if (
      evidence.meetingId !== readyReceipt.meetingId ||
      deploymentProvenanceDigest(evidence.deployment) !==
        readyReceipt.pinnedTestTarget.provenanceDigestSha256
    ) {
      throw new Error("Retained evidence does not match the recording-ready receipt");
    }
    const expectedRevisions = deploymentRevisionExpectationSchema.parse({
      craig: config.DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION,
      meetingPlatform: config.DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION,
      pipecat: config.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION,
      subscriptionRuntime: config.DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION,
    });
    const verification = verifyRetainedE2eEvidence(
      manifest,
      evidence,
      expectedRevisions,
      serviceLevelThresholds,
    );
    if (!verification.passed) {
      throw new Error(`collected evidence failed: ${JSON.stringify(verification.failures)}`);
    }
    await atomicWriteJson(config.DISCORD_E2E_EVIDENCE_OUTPUT, evidence);
    process.stdout.write(`${JSON.stringify({
      evidencePath: config.DISCORD_E2E_EVIDENCE_OUTPUT,
      metrics: verification.metrics,
      recordingId: evidence.recording.recordingId,
      runId: evidence.actorRun.runId,
      status: "passed",
    })}\n`);
  } finally {
    await discord.close();
  }
}

function reconnectParticipantId(
  manifest: ReturnType<typeof fixtureManifestV1Schema.parse>,
): string {
  const reconnectParticipant = manifest.fixtures.filter(
    ({ actorName }) => actorName === "speaker-b",
  );
  if (reconnectParticipant.length !== 1) {
    throw new Error("Fixture manifest must pin exactly one reconnect speaker-b");
  }
  return reconnectParticipant[0]!.speakerId;
}

function requireDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label} after environment validation`);
  }
  return value;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function readSupplementalPlayback(path: string | undefined): Promise<
  ReturnType<typeof supplementalPlaybackEvidenceV1Schema.parse> | undefined
> {
  if (path === undefined) {
    return undefined;
  }
  return supplementalPlaybackEvidenceV1Schema.parse(await readJson(path));
}

async function readCampaignProof(path: string | undefined): Promise<unknown> {
  if (path === undefined) {
    return undefined;
  }
  return conversationVoiceCampaignProofV1Schema.parse(await readJson(path));
}

async function readOptionalJson<T>(
  path: string | undefined,
  schema: { parse(value: unknown): T },
): Promise<T | undefined> {
  return path === undefined ? undefined : schema.parse(await readJson(path));
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, path);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown E2E collector failure";
  process.stderr.write(`Discord E2E evidence collection failed: ${message}\n`);
  process.exitCode = error instanceof EvidenceProbeInterruptedError ? error.exitCode : 1;
});
