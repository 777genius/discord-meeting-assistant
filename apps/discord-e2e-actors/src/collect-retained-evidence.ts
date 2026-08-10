import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { z } from "zod";

import { DiscordJsEvidenceProbe } from "./discord-evidence-probe.js";
import { collectRetainedE2eEvidence } from "./e2e-collector.js";
import {
  conversationVoiceEvidenceV3Schema,
  deploymentRevisionExpectationSchema,
  fixtureManifestV1Schema,
  verifyRetainedE2eEvidence,
} from "./e2e-evidence.js";
import { MacOsKeychainSecretReader } from "./keychain.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";

const absolutePath = z.string().refine(isAbsolute);
const correlationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const environmentSchema = z.object({
  DISCORD_E2E_ACTOR_RUN_INPUT: absolutePath,
  DISCORD_E2E_BOTIK_SPEAKER_ID: correlationId.optional(),
  DISCORD_E2E_CONVERSATION_VOICE_INPUTS: z.string().transform((value, context) => {
    try {
      return z.array(absolutePath).min(5).parse(JSON.parse(value) as unknown);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Expected a JSON array of at least five absolute voice evidence paths",
      });
      return z.NEVER;
    }
  }).optional(),
  DISCORD_E2E_EVIDENCE_OUTPUT: absolutePath,
  DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: z.string().min(1),
  DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION: z.string().min(1),
  DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: z.string().min(1).optional(),
  DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION: z.string().min(1),
  DISCORD_E2E_FIXTURE_MANIFEST: z.string().min(1).default("test/fixtures/manifest.v1.json"),
  DISCORD_E2E_KEYCHAIN_SERVICE: z.string().min(1).default("discord-voice-bot-e2e"),
  DISCORD_E2E_RECORDING_ID: correlationId,
  DISCORD_E2E_REMOTE_CRAIG_PROJECT: z.string().min(1).default("craig-meeting-e2e"),
  DISCORD_E2E_REMOTE_CRAIG_SERVICE: z.string().min(1).default("bot"),
  DISCORD_E2E_REMOTE_COMPOSE_FILE: absolutePath.default(
    "/mnt/volume_ams3_1784742570542/discord-meeting-assistant/source/infra/deployment/compose.yaml",
  ),
  DISCORD_E2E_REMOTE_ENV_FILE: absolutePath.default(
    "/mnt/volume_ams3_1784742570542/discord-meeting-assistant/source.env",
  ),
  DISCORD_E2E_REMOTE_HOST: z.string().min(1).default("codex-workers-eu-01"),
  DISCORD_E2E_REMOTE_PROJECT: z.string().min(1).default("discord-meeting-assistant"),
  DISCORD_E2E_REMOTE_SOURCE_ROOT: absolutePath.default(
    "/mnt/volume_ams3_1784742570542/discord-meeting-assistant/source",
  ),
  DISCORD_E2E_RUN_ID: correlationId,
  DISCORD_E2E_SUT_ACCOUNT: z.string().min(1).default("sut"),
}).superRefine((value, context) => {
  if ((value.DISCORD_E2E_BOTIK_SPEAKER_ID === undefined) !==
    (value.DISCORD_E2E_CONVERSATION_VOICE_INPUTS === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Botik speaker ID and conversation voice inputs must be supplied together",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_INPUTS"],
    });
  }
});

async function main(): Promise<void> {
  const config = environmentSchema.parse(process.env);
  const [actorRun, manifest, token, conversationVoice] = await Promise.all([
    readJson(config.DISCORD_E2E_ACTOR_RUN_INPUT),
    readJson(config.DISCORD_E2E_FIXTURE_MANIFEST).then((value) =>
      fixtureManifestV1Schema.parse(value)
    ),
    new MacOsKeychainSecretReader(config.DISCORD_E2E_KEYCHAIN_SERVICE)
      .read(config.DISCORD_E2E_SUT_ACCOUNT),
    Promise.all((config.DISCORD_E2E_CONVERSATION_VOICE_INPUTS ?? []).map((path) =>
      readJson(path).then((value) => conversationVoiceEvidenceV3Schema.parse(value))
    )),
  ]);
  const deployment = new SshDeploymentEvidenceProbe({
    composeFile: config.DISCORD_E2E_REMOTE_COMPOSE_FILE,
    craigProjectName: config.DISCORD_E2E_REMOTE_CRAIG_PROJECT,
    craigServiceName: config.DISCORD_E2E_REMOTE_CRAIG_SERVICE,
    envFile: config.DISCORD_E2E_REMOTE_ENV_FILE,
    host: config.DISCORD_E2E_REMOTE_HOST,
    includePipecatProvenance:
      config.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION !== undefined,
    projectName: config.DISCORD_E2E_REMOTE_PROJECT,
    sourceRoot: config.DISCORD_E2E_REMOTE_SOURCE_ROOT,
  });
  const discord = new DiscordJsEvidenceProbe();
  try {
    await discord.connect(token);
    const evidence = await collectRetainedE2eEvidence({
      actorRun,
      ...(config.DISCORD_E2E_BOTIK_SPEAKER_ID === undefined
        ? {}
        : {
            conversation: {
              botSpeakerId: config.DISCORD_E2E_BOTIK_SPEAKER_ID,
              voice: conversationVoice,
            },
          }),
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

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
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
  process.exitCode = 1;
});
