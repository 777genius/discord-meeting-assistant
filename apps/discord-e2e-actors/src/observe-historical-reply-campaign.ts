import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { readStablePrivateJson } from "./compile-hosted-campaign-plan.js";
import { writeCreateOnlyPrivateJson } from "./create-only-private-json.js";
import { DiscordJsHistoricalReplyCampaignAdapter } from
  "./discordjs-historical-reply-campaign-adapter.js";
import {
  assertHistoricalReplyReadinessMatchesCampaign,
  historicalReplyCampaignInputV1Schema,
  historicalReplyCrashReceiptV1Schema,
  historicalReplyLiveReadinessV1Schema,
} from "./historical-reply-campaign-contract.js";
import {
  assertHistoricalPostRestartMutationAdmission,
  runHistoricalReplyCampaign,
} from "./historical-reply-campaign.js";
import { verifyHostedCampaignAdmissionReceipt } from "./hosted-campaign-admission.js";
import { digestCanonical } from "./hosted-campaign-local-admission.js";
import {
  admitCompiledHostedCampaignReleaseBinding,
  COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT,
} from
  "./hosted-campaign-release-binding.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";
import { FileSecretReader, MacOsKeychainSecretReader } from "./keychain.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";

const environmentSchema = z.object({
  DISCORD_E2E_HISTORICAL_REPLY_ADMISSION_RECEIPT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_ANSWER_TIMEOUT_MS: z.coerce.number().int()
    .min(1_000).max(300_000).default(60_000),
  DISCORD_E2E_HISTORICAL_REPLY_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_CRASH_RECEIPT_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_KEYCHAIN_SERVICE: z.string().min(1)
    .default("discord-voice-bot-e2e"),
  DISCORD_E2E_HISTORICAL_REPLY_MUTATION_TARGET: z.literal("private-test-guild"),
  DISCORD_E2E_HISTORICAL_REPLY_OBSERVER_ACCOUNT: z.literal("conversation-observer")
    .default("conversation-observer"),
  DISCORD_E2E_HISTORICAL_REPLY_OUTPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_PLAN: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_POLL_INTERVAL_MS: z.coerce.number().int()
    .min(100).max(10_000).default(1_000),
  DISCORD_E2E_HISTORICAL_REPLY_QUIET_WINDOW_MS: z.coerce.number().int()
    .min(1_000).max(30_000).default(10_000),
  DISCORD_E2E_HISTORICAL_REPLY_RELEASE_BINDING: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_REMOTE_COMPOSE_FILE: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_REMOTE_ENV_FILE: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_REMOTE_HOST: z.string().regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u,
  ),
  DISCORD_E2E_HISTORICAL_REPLY_REMOTE_SOURCE_ROOT: z.string().refine(isAbsolute),
  DISCORD_E2E_HISTORICAL_REPLY_REMOTE_TIMEOUT_MS: z.coerce.number().int()
    .min(1_000).max(330_000).default(60_000),
  DISCORD_E2E_HISTORICAL_REPLY_SECRET_DIRECTORY: z.string().refine(isAbsolute).optional(),
}).loose();

// oxlint-disable-next-line complexity
async function main(): Promise<void> {
  const config = environmentSchema.parse(process.env);
  const input = historicalReplyCampaignInputV1Schema.parse(
    await readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_REPLY_INPUT),
  );
  const admission = verifyHostedCampaignAdmissionReceipt(
    await readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_REPLY_ADMISSION_RECEIPT),
  );
  const plan = await readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_REPLY_PLAN);
  const admittedRelease = admitCompiledHostedCampaignReleaseBinding(
    await readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_REPLY_RELEASE_BINDING),
  );
  if (admission.status !== "admitted" || admission.remoteReadiness === undefined ||
    admission.campaignId !== input.campaignId ||
    admission.planSha256 !== digestCanonical(plan) ||
    JSON.stringify(admittedRelease.releaseReference) !== JSON.stringify(input.release)) {
    throw new Error("Historical mutation is not bound to the trusted campaign/release admission");
  }
  if (Date.parse(input.mutationAdmission.freshDiscordIdentity.generatedAt) > Date.now() ||
    Date.parse(input.mutationAdmission.freshDiscordIdentity.expiresAt) <= Date.now() ||
    Date.parse(input.mutationAdmission.freshDiscordIdentity.expiresAt) -
      Date.parse(input.mutationAdmission.freshDiscordIdentity.generatedAt) > 60_000) {
    throw new Error("Historical mutation has no fresh trusted Discord identity admission");
  }
  if (input.guildId !== HOSTED_CAMPAIGN_TARGET.guildId ||
    input.answerQuietWindowMilliseconds !==
      config.DISCORD_E2E_HISTORICAL_REPLY_QUIET_WINDOW_MS ||
    input.observerApplicationId !== HOSTED_CAMPAIGN_TARGET.observerApplicationId ||
    input.sutApplicationId !== HOSTED_CAMPAIGN_TARGET.sutApplicationId ||
    input.target.parentChannelId !== HOSTED_CAMPAIGN_TARGET.publicationChannelId ||
    config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_HOST !== HOSTED_CAMPAIGN_TARGET.host ||
    COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT === undefined ||
    config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_COMPOSE_FILE !==
      COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT.remoteComposeFile ||
    config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_ENV_FILE !==
      COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT.environmentFile ||
    config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_SOURCE_ROOT !==
      COMPILED_HOSTED_CAMPAIGN_RELEASE_TRUST_ROOT.sourceRoot) {
    throw new Error("Historical mutation target is not the compiled reviewed private Discord SUT");
  }
  if (Date.now() < Date.parse(input.restart.readyAt)) {
    throw new Error("Historical reply input is not durably rehydrated and ready");
  }
  const probe = new SshDeploymentEvidenceProbe({
    composeFile: config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_COMPOSE_FILE,
    craigProjectName: "craig-meeting-e2e",
    craigServiceName: "bot",
    envFile: config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_ENV_FILE,
    host: config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_HOST,
    mutationTarget: "test-only",
    projectName: "discord-meeting-assistant",
    sourceRoot: config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_SOURCE_ROOT,
    timeoutMs: config.DISCORD_E2E_HISTORICAL_REPLY_REMOTE_TIMEOUT_MS,
  });
  const liveReadiness = historicalReplyLiveReadinessV1Schema.parse(
    await probe.collectHistoricalReplyReadiness(input.canonicalAuthority.meetingId),
  );
  assertHistoricalReplyReadinessMatchesCampaign(input, liveReadiness);
  const consumedAdmissionIds = new Set<string>();
  assertHistoricalPostRestartMutationAdmission({
    admissionReceiptSha256: admission.receiptSha256,
    campaign: input,
    consumedAdmissionIds,
    evidenceOutputPathSha256: createHash("sha256")
      .update(config.DISCORD_E2E_HISTORICAL_REPLY_OUTPUT, "utf8").digest("hex"),
    nowEpochMs: Date.now(),
    planSha256: admission.planSha256,
  });
  const admissionUseIdSha256 = createHash("sha256")
    .update(input.mutationAdmission.admissionId, "utf8").digest("hex");
  await writeCreateOnlyPrivateJson(
    `${admission.artifactRoot}/historical-reply-mutation-${admissionUseIdSha256}.use.v1.json`,
    {
      admissionId: input.mutationAdmission.admissionId,
      kind: "historical-reply-mutation-admission-use",
      mutationAdmissionReceiptSha256: input.mutationAdmission.receiptSha256,
      schemaVersion: 1,
    },
  );
  const secrets = config.DISCORD_E2E_HISTORICAL_REPLY_SECRET_DIRECTORY === undefined
    ? new MacOsKeychainSecretReader(config.DISCORD_E2E_HISTORICAL_REPLY_KEYCHAIN_SERVICE)
    : new FileSecretReader(config.DISCORD_E2E_HISTORICAL_REPLY_SECRET_DIRECTORY);
  const token = await secrets.read(config.DISCORD_E2E_HISTORICAL_REPLY_OBSERVER_ACCOUNT);
  const adapter = new DiscordJsHistoricalReplyCampaignAdapter({
    answerTimeoutMilliseconds: config.DISCORD_E2E_HISTORICAL_REPLY_ANSWER_TIMEOUT_MS,
    observeCrashReceipts: async () => [historicalReplyCrashReceiptV1Schema.parse(
      await readStablePrivateJson(config.DISCORD_E2E_HISTORICAL_REPLY_CRASH_RECEIPT_INPUT),
    )],
    observeQuestionAdmission: async (questionId) => {
      const deadline = Date.now() + config.DISCORD_E2E_HISTORICAL_REPLY_ANSWER_TIMEOUT_MS;
      for (;;) {
        try {
          return await probe.collectHistoricalReplyQuestionAdmission(questionId);
        } catch (error: unknown) {
          if (Date.now() >= deadline) {
            throw error;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, config.DISCORD_E2E_HISTORICAL_REPLY_POLL_INTERVAL_MS);
          });
        }
      }
    },
    observeQuestionOutcome: async (questionId) => {
      const deadline = Date.now() + config.DISCORD_E2E_HISTORICAL_REPLY_ANSWER_TIMEOUT_MS;
      for (;;) {
        try {
          return await probe.collectHistoricalReplyQuestionOutcome(questionId);
        } catch (error: unknown) {
          if (Date.now() >= deadline) {
            throw error;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, config.DISCORD_E2E_HISTORICAL_REPLY_POLL_INTERVAL_MS);
          });
        }
      }
    },
    observeQuestionSettlement: async (questionId) => {
      const deadline = Date.now() + config.DISCORD_E2E_HISTORICAL_REPLY_ANSWER_TIMEOUT_MS;
      for (;;) {
        try {
          return await probe.collectHistoricalReplySettlement(questionId);
        } catch (error: unknown) {
          if (Date.now() >= deadline) {
            throw error;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, config.DISCORD_E2E_HISTORICAL_REPLY_POLL_INTERVAL_MS);
          });
        }
      }
    },
    pollIntervalMilliseconds: config.DISCORD_E2E_HISTORICAL_REPLY_POLL_INTERVAL_MS,
    quietWindowMilliseconds: config.DISCORD_E2E_HISTORICAL_REPLY_QUIET_WINDOW_MS,
    revalidateRuntime: async () => {
      const current = historicalReplyLiveReadinessV1Schema.parse(
        await probe.collectHistoricalReplyReadiness(input.canonicalAuthority.meetingId),
      );
      assertHistoricalReplyReadinessMatchesCampaign(input, current);
    },
  });
  try {
    await adapter.connect(token);
    const evidence = await runHistoricalReplyCampaign(input, adapter);
    await writeCreateOnlyPrivateJson(config.DISCORD_E2E_HISTORICAL_REPLY_OUTPUT, evidence);
  } finally {
    await adapter.close();
  }
}

if (process.argv[1]?.replaceAll("\\", "/")
  .endsWith("/observe-historical-reply-campaign.js") === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown historical reply failure";
    process.stderr.write(`Discord historical reply campaign failed: ${message}\n`);
    process.exitCode = 1;
  });
}
