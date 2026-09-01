import { isAbsolute } from "node:path";

import { z } from "zod";

import { readStablePrivateJson } from "./compile-hosted-campaign-plan.js";
import { writeCreateOnlyPrivateJson } from "./create-only-private-json.js";
import { conversationVoiceCampaignProofV1Schema } from "./conversation-voice-campaign-proof.js";
import {
  buildGreetingLedgerQualification,
  greetingReceiptId,
  OFFICIAL_GREETING_TEST_IDENTITIES,
} from "./greeting-ledger-qualification.js";
import { SshDeploymentEvidenceProbe } from "./ssh-deployment-probe.js";
import { rejectTokenEnvironment, sanitizedCliError } from "./cli-secret-safety.js";

const environmentSchema = z.object({
  DISCORD_E2E_GREETING_LEDGER_CAMPAIGN_ID: z.string().trim().min(1),
  DISCORD_E2E_GREETING_LEDGER_CAMPAIGN_PROOF_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_GREETING_LEDGER_CAPTURE_INPUTS: z.string().transform((value, context) => {
    try { return z.array(z.string().refine(isAbsolute)).length(4).parse(JSON.parse(value)); }
    catch { context.addIssue({ code: "custom", message: "Greeting capture inputs are invalid" }); return z.NEVER; }
  }),
  DISCORD_E2E_GREETING_LEDGER_MUTATION_TARGET: z.literal("private-test-guild"),
  DISCORD_E2E_GREETING_LEDGER_OUTPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_GREETING_LEDGER_REMOTE_COMPOSE_FILE: z.string().refine(isAbsolute),
  DISCORD_E2E_GREETING_LEDGER_REMOTE_ENV_FILE: z.string().refine(isAbsolute),
  DISCORD_E2E_GREETING_LEDGER_REMOTE_HOST: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u),
  DISCORD_E2E_GREETING_LEDGER_REMOTE_SOURCE_ROOT: z.string().refine(isAbsolute),
  DISCORD_E2E_GREETING_LEDGER_REMOTE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  DISCORD_E2E_GREETING_LEDGER_RUN_ID: z.string().trim().min(1),
}).loose();

async function main(): Promise<void> {
  rejectTokenEnvironment(process.env);
  const config = environmentSchema.parse(process.env);
  const deadline = Date.now() + config.DISCORD_E2E_GREETING_LEDGER_REMOTE_TIMEOUT_MS;
  const campaignProof = conversationVoiceCampaignProofV1Schema.parse(await waitForJson(
    config.DISCORD_E2E_GREETING_LEDGER_CAMPAIGN_PROOF_INPUT, deadline,
  ));
  if (campaignProof.observerReadyReceipt.runId !== config.DISCORD_E2E_GREETING_LEDGER_RUN_ID) {
    throw new Error("Greeting ledger observer is bound to another campaign run");
  }
  const meetingId = campaignProof.observerReadyReceipt.meetingId;
  const receiptIds = OFFICIAL_GREETING_TEST_IDENTITIES.map((participantId) =>
    greetingReceiptId(meetingId, participantId)) as unknown as readonly [string, string, string, string];
  const probe = new SshDeploymentEvidenceProbe({
    composeFile: config.DISCORD_E2E_GREETING_LEDGER_REMOTE_COMPOSE_FILE,
    craigProjectName: "craig-meeting-e2e", craigServiceName: "bot",
    envFile: config.DISCORD_E2E_GREETING_LEDGER_REMOTE_ENV_FILE,
    host: config.DISCORD_E2E_GREETING_LEDGER_REMOTE_HOST,
    mutationTarget: "test-only", projectName: "discord-meeting-assistant",
    sourceRoot: config.DISCORD_E2E_GREETING_LEDGER_REMOTE_SOURCE_ROOT,
    timeoutMs: config.DISCORD_E2E_GREETING_LEDGER_REMOTE_TIMEOUT_MS,
  });
  const ledger = await probe.collectGreetingLedgerRows(receiptIds);
  const captures = await Promise.all(config.DISCORD_E2E_GREETING_LEDGER_CAPTURE_INPUTS.map(
    async (path) => waitForJson(path, deadline),
  ));
  const firstPacketTimes = captures.map((capture) =>
    z.object({ capture: z.object({ firstPacketAt: z.object({
      epochMilliseconds: z.number().int().nonnegative(),
    }).loose() }).loose() }).loose().parse(capture)
      .capture.firstPacketAt.epochMilliseconds);
  const lifecycle = await probe.collectConversationLifecycle(
    meetingId,
    new Date(Math.min(...firstPacketTimes) - 5 * 60_000).toISOString(),
  );
  const proof = buildGreetingLedgerQualification({
    campaignId: config.DISCORD_E2E_GREETING_LEDGER_CAMPAIGN_ID, campaignProof,
    captures, ledgerRows: ledger.rows, lifecycle,
    settlementObservedAt: ledger.settlementObservedAt,
  });
  await writeCreateOnlyPrivateJson(config.DISCORD_E2E_GREETING_LEDGER_OUTPUT, proof);
  process.stdout.write(`${JSON.stringify({
    kind: "greeting-ledger-observer-completion",
    outputPath: config.DISCORD_E2E_GREETING_LEDGER_OUTPUT,
    runId: config.DISCORD_E2E_GREETING_LEDGER_RUN_ID,
    status: "completed",
  })}\n`);
}

async function waitForJson(path: string, deadline: number): Promise<unknown> {
  for (;;) {
    try { return await readStablePrivateJson(path); }
    catch (error: unknown) {
      if (Date.now() >= deadline) { throw error; }
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/observe-greeting-ledger.js") === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Greeting ledger observation failed: ${sanitizedCliError(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
