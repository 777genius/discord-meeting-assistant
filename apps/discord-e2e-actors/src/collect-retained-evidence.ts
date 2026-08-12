import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { DiscordJsEvidenceProbe } from "./discord-evidence-probe.js";
import {
  collectRetainedE2eEvidence,
  createReplayTargetAttestation,
} from "./e2e-collector.js";
import { collectorEnvironmentSchema } from "./e2e-collector-environment.js";
import {
  conversationVoiceEvidenceV3Schema,
  deploymentRevisionExpectationSchema,
  fixtureManifestV1Schema,
  supplementalPlaybackEvidenceV1Schema,
  unboundActorRunEvidenceV1Schema,
  verifyRetainedE2eEvidence,
} from "./e2e-evidence.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";
import { EvidenceProbeInterruptedError } from "./ssh-deployment-probe-commands.js";

async function main(): Promise<void> {
  const config = collectorEnvironmentSchema.parse(process.env);
  const [actorRun, manifest, conversationVoice, supplementalPlayback] = await Promise.all([
    readJson(config.DISCORD_E2E_ACTOR_RUN_INPUT),
    readJson(config.DISCORD_E2E_FIXTURE_MANIFEST).then((value) =>
      fixtureManifestV1Schema.parse(value)
    ),
    Promise.all((config.DISCORD_E2E_CONVERSATION_VOICE_INPUTS ?? []).map((path) =>
      readJson(path).then((value) => conversationVoiceEvidenceV3Schema.parse(value))
    )),
    readSupplementalPlayback(config.DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT),
  ]);
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
    recordingId: config.DISCORD_E2E_RECORDING_ID,
    runId: config.DISCORD_E2E_RUN_ID,
  }, unboundActorRunEvidenceV1Schema.parse(actorRun));
  await deployment.assertReplayTargetSafe(replayTarget);
  const token = await (config.DISCORD_E2E_SECRET_DIRECTORY === undefined
    ? new MacOsKeychainSecretReader(config.DISCORD_E2E_KEYCHAIN_SERVICE)
    : new FileSecretReader(config.DISCORD_E2E_SECRET_DIRECTORY))
    .read(config.DISCORD_E2E_SUT_ACCOUNT);
  const discord = new DiscordJsEvidenceProbe();
  const conversation = config.DISCORD_E2E_BOTIK_SPEAKER_ID === undefined
    ? undefined
    : {
        botSpeakerId: config.DISCORD_E2E_BOTIK_SPEAKER_ID,
        reconnectParticipantId: reconnectParticipantId(manifest),
        supplementalPlayback: requireDefined(
          supplementalPlayback,
          "supplemental playback evidence",
        ),
        voice: conversationVoice,
      };
  try {
    await discord.connect(token);
    const evidence = await collectRetainedE2eEvidence({
      actorRun,
      ...(conversation === undefined ? {} : { conversation }),
      fixtureSetId: manifest.fixtureSetId,
      recordingId: config.DISCORD_E2E_RECORDING_ID,
      runId: config.DISCORD_E2E_RUN_ID,
    }, deployment, discord);
    const expectedRevisions = deploymentRevisionExpectationSchema.parse({
      craig: config.DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION,
      meetingPlatform: config.DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION,
      pipecat: config.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION,
      subscriptionRuntime: config.DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION,
    });
    const verification = verifyRetainedE2eEvidence(manifest, evidence, expectedRevisions);
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

async function readSupplementalPlayback(path: string | undefined) {
  if (path === undefined) {
    return;
  }
  return supplementalPlaybackEvidenceV1Schema.parse(await readJson(path));
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
