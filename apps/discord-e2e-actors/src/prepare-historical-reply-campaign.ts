import { isAbsolute } from "node:path";

import { z } from "zod";

import { readStablePrivateJson } from "./compile-hosted-campaign-plan.js";
import { writeCreateOnlyPrivateJson } from "./create-only-private-json.js";
import { retainedVoiceE2eEvidenceV10Schema } from "./e2e-evidence-schema.js";
import {
  assertHistoricalReplyReadinessMatchesCampaign,
  historicalReplyCampaignInputV1Schema,
} from "./historical-reply-campaign-contract.js";
import { lateGreetingObservationV1Schema } from "./late-greeting-observation.js";
import { recordingReadyReceiptV2Schema } from "./recording-ready-receipt.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";
import { rejectTokenEnvironment, sanitizedCliError } from "./cli-secret-safety.js";
import { governedCampaignObservationPolicyV1Schema } from
  "./governed-private-campaign-observation-contract.js";

export const HISTORICAL_SUPPORTED_RU_QUESTION =
  "Что Meeting Platform сохраняет по словам участника?";
export const HISTORICAL_UNSUPPORTED_EN_QUESTION =
  "What launch date was agreed for the nonexistent Project Zephyr?";

const environmentSchema = z.object({
  DISCORD_E2E_HISTORICAL_PREP_ARM_OUTPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_PREP_CAMPAIGN_ID: z.string().trim().min(1),
  DISCORD_E2E_HISTORICAL_PREP_EVIDENCE_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_PREP_LATE_GREETING_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_PREP_MUTATION_TARGET: z.literal("private-test-guild"),
  DISCORD_E2E_HISTORICAL_PREP_OBSERVATION_POLICY: z.string().min(2),
  DISCORD_E2E_HISTORICAL_PREP_OUTPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_PREP_REMOTE_COMPOSE_FILE: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_PREP_REMOTE_ENV_FILE: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_PREP_REMOTE_HOST: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u),
  DISCORD_E2E_HISTORICAL_PREP_REMOTE_SOURCE_ROOT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_PREP_RECORDING_READY_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_PREP_RUN_ID: z.string().trim().min(1),
  DISCORD_E2E_HISTORICAL_PREP_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(600_000).default(300_000),
  DISCORD_E2E_HISTORICAL_PREP_V2_TEMPLATE_INPUT: z.string().refine(isAbsolute),
}).loose();

async function main(): Promise<void> {
  rejectTokenEnvironment(process.env);
  const config = environmentSchema.parse(process.env);
  const [evidenceValue, lateValue, readyValue, templateValue] = await Promise.all([
    readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_PREP_EVIDENCE_INPUT),
    readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_PREP_LATE_GREETING_INPUT),
    readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_PREP_RECORDING_READY_INPUT),
    readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_PREP_V2_TEMPLATE_INPUT),
  ]);
  const evidence = retainedVoiceE2eEvidenceV10Schema.parse(evidenceValue);
  const late = lateGreetingObservationV1Schema.parse(lateValue);
  const ready = recordingReadyReceiptV2Schema.parse(readyValue);
  const template = historicalReplyCampaignInputV1Schema.parse(templateValue);
  const observationPolicy = governedCampaignObservationPolicyV1Schema.parse(
    JSON.parse(config.DISCORD_E2E_HISTORICAL_PREP_OBSERVATION_POLICY),
  );
  if (JSON.stringify(template.observationScope) !== JSON.stringify(observationPolicy)) {
    throw new Error("Historical template observation policy differs from the compiled campaign plan");
  }
  assertTemplateBindings(config, evidence, late, ready, template);

  const probe = new SshDeploymentEvidenceProbe({
    composeFile: config.DISCORD_E2E_HISTORICAL_PREP_REMOTE_COMPOSE_FILE,
    craigProjectName: "craig-meeting-e2e", craigServiceName: "bot",
    envFile: config.DISCORD_E2E_HISTORICAL_PREP_REMOTE_ENV_FILE,
    host: config.DISCORD_E2E_HISTORICAL_PREP_REMOTE_HOST,
    mutationTarget: "test-only", projectName: "discord-meeting-assistant",
    sourceRoot: config.DISCORD_E2E_HISTORICAL_PREP_REMOTE_SOURCE_ROOT,
    timeoutMs: config.DISCORD_E2E_HISTORICAL_PREP_TIMEOUT_MS,
  });
  const live = await probe.collectHistoricalReplyReadiness(evidence.meetingId);
  assertHistoricalReplyReadinessMatchesCampaign(template, live);
  if (live.service.hostProcessId !== late.restart.after.hostProcessId) {
    throw new Error("Historical V2 template no longer matches restarted durable state");
  }
  await writeCreateOnlyPrivateJson(config.DISCORD_E2E_HISTORICAL_PREP_ARM_OUTPUT, {
    campaignId: template.campaignId,
    injectionId: `public-reply-crash:${template.runId}`,
    schemaVersion: 1,
  });
  await writeCreateOnlyPrivateJson(config.DISCORD_E2E_HISTORICAL_PREP_OUTPUT, template);
  process.stdout.write(`${JSON.stringify({
    kind: "historical-reply-preparer-completion",
    outputPath: config.DISCORD_E2E_HISTORICAL_PREP_OUTPUT,
    runId: config.DISCORD_E2E_HISTORICAL_PREP_RUN_ID,
    status: "completed",
  })}\n`);
}

function assertTemplateBindings(
  config: z.infer<typeof environmentSchema>,
  evidence: z.infer<typeof retainedVoiceE2eEvidenceV10Schema>,
  late: z.infer<typeof lateGreetingObservationV1Schema>,
  ready: z.infer<typeof recordingReadyReceiptV2Schema>,
  template: z.infer<typeof historicalReplyCampaignInputV1Schema>,
): void {
  const citedTurnId = template.questions.supported.expectedCitationTurnIds[0];
  const cited = evidence.transcript.turns.find(({ turnId }) => turnId === citedTurnId);
  const intendedActors = [
    ...[...new Set(evidence.transcript.turns.map(({ speakerId }) => speakerId))]
      .filter((actorId) => actorId !== evidence.conversation.botSpeakerId)
      .map((actorId) => ({ actorId, kind: "human" as const })),
    { actorId: evidence.conversation.botSpeakerId, kind: "automation" as const },
  ].toSorted((left, right) => left.actorId.localeCompare(right.actorId) ||
    left.kind.localeCompare(right.kind));
  if (evidence.actorRun.runId !== config.DISCORD_E2E_HISTORICAL_PREP_RUN_ID ||
    template.runId !== evidence.actorRun.runId || template.campaignId !==
      config.DISCORD_E2E_HISTORICAL_PREP_CAMPAIGN_ID ||
    template.botActorId !== evidence.conversation.botSpeakerId ||
    ready.runId !== evidence.actorRun.runId || ready.meetingId !== evidence.meetingId ||
    JSON.stringify(template.producerEvidence) !== JSON.stringify(ready.producerEvidence) ||
    JSON.stringify(template.producerEvidence.authoritativeLifecycleCompletion) !==
      JSON.stringify({
        eventDigestSha256: ready.authoritativeSource.eventDigestSha256,
        eventId: ready.authoritativeSource.eventId,
        eventType: ready.authoritativeSource.eventType,
        lifecycleGeneration: ready.authoritativeSource.lifecycleGeneration,
        occurredAt: ready.authoritativeSource.occurredAt,
        receiptKind: ready.authoritativeSource.kind,
      }) ||
    JSON.stringify(template.intendedActors) !== JSON.stringify(intendedActors) ||
    JSON.stringify(ready.producerEvidence.actors) !== JSON.stringify(intendedActors) ||
    template.release.releaseBindingSha256 !== evidence.release.releaseBindingSha256 ||
    late.runId !== template.runId || late.meetingId !== template.target.meetingId ||
    template.restart.before.containerId !== late.restart.before.containerId ||
    template.restart.after.containerId !== late.restart.after.containerId ||
    template.restart.requestedAt !== late.restart.requestedAt ||
    template.restart.readyAt < late.restart.completedAt ||
    template.questions.supported.text !== HISTORICAL_SUPPORTED_RU_QUESTION ||
    template.questions.unsupported.text !== HISTORICAL_UNSUPPORTED_EN_QUESTION ||
    template.target.kind !== "final-summary" ||
    template.unsupportedTarget.kind !== "live-transcript" ||
    cited === undefined || !/[А-Яа-яЁё]/u.test(cited.text) ||
    !cited.text.includes("Meeting Platform") || !cited.text.includes("Craig recording") ||
    template.questions.supported.expectedClaims.length !== 1 ||
    template.questions.supported.expectedClaims[0]?.text !== cited.text ||
    !template.questions.supported.expectedAnswerTerms.includes("Craig recording")) {
    throw new Error("Historical V2 template is not the deterministic trusted-human RU/EN projection pair");
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/prepare-historical-reply-campaign.js") === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Historical reply preparation failed: ${sanitizedCliError(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
