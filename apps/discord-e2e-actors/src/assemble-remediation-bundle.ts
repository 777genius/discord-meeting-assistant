import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { readStablePrivateJsonText } from "./compile-hosted-campaign-plan.js";
import { writeCreateOnlyPrivateJson } from "./create-only-private-json.js";
import { thinRemediationProofV1Schema } from "./thin-remediation-proof.js";
import { sanitizedCliError } from "./cli-secret-safety.js";

const environmentSchema = z.object({
  DISCORD_E2E_REMEDIATION_BUNDLE_CAMPAIGN_ID: z.string().trim().min(1),
  DISCORD_E2E_REMEDIATION_BUNDLE_GREETING_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_REMEDIATION_BUNDLE_HISTORICAL_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_REMEDIATION_BUNDLE_LATE_GREETING_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_REMEDIATION_BUNDLE_LIVE_MEMORY_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_REMEDIATION_BUNDLE_OUTPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_REMEDIATION_BUNDLE_PRIVATE_COVERAGE_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_REMEDIATION_BUNDLE_RECORDING_READY_INPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_REMEDIATION_BUNDLE_RUN_ID: z.string().trim().min(1),
  DISCORD_E2E_REMEDIATION_BUNDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
}).loose();

async function main(): Promise<void> {
  const config = environmentSchema.parse(process.env);
  const deadline = Date.now() + config.DISCORD_E2E_REMEDIATION_BUNDLE_TIMEOUT_MS;
  const [greeting, historical, lateGreeting, liveMemory, privateCoverage, recordingReady] =
    await Promise.all([
    waitForText(config.DISCORD_E2E_REMEDIATION_BUNDLE_GREETING_INPUT, deadline),
    waitForText(config.DISCORD_E2E_REMEDIATION_BUNDLE_HISTORICAL_INPUT, deadline),
    waitForText(config.DISCORD_E2E_REMEDIATION_BUNDLE_LATE_GREETING_INPUT, deadline),
    waitForText(config.DISCORD_E2E_REMEDIATION_BUNDLE_LIVE_MEMORY_INPUT, deadline),
    waitForText(config.DISCORD_E2E_REMEDIATION_BUNDLE_PRIVATE_COVERAGE_INPUT, deadline),
    waitForText(config.DISCORD_E2E_REMEDIATION_BUNDLE_RECORDING_READY_INPUT, deadline),
  ]);
  const historicalContent = JSON.parse(historical) as { campaign?: { release?: unknown } };
  const bundle = thinRemediationProofV1Schema.parse({
    artifacts: {
      greetingLedger: retained("greeting-ledger", greeting),
      historicalReply: retained("historical-reply", historical),
      lateGreeting: retained("late-greeting", lateGreeting),
      liveMemory: retained("live-memory", liveMemory),
      privateCoverage: retained("private-coverage", privateCoverage),
      recordingReady: retained("recording-ready", recordingReady),
    },
    campaignId: config.DISCORD_E2E_REMEDIATION_BUNDLE_CAMPAIGN_ID,
    kind: "hosted-campaign-remediation-bundle",
    release: historicalContent.campaign?.release,
    runId: config.DISCORD_E2E_REMEDIATION_BUNDLE_RUN_ID,
    schemaVersion: 3,
  });
  await writeCreateOnlyPrivateJson(config.DISCORD_E2E_REMEDIATION_BUNDLE_OUTPUT, bundle);
  process.stdout.write(`${JSON.stringify({
    kind: "remediation-bundle-completion", outputPath: config.DISCORD_E2E_REMEDIATION_BUNDLE_OUTPUT,
    runId: config.DISCORD_E2E_REMEDIATION_BUNDLE_RUN_ID, status: "completed",
  })}\n`);
}

function retained(role: string, bytes: string) {
  return { content: JSON.parse(bytes) as unknown, outputArtifactSha256: sha256(bytes), role };
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
async function waitForText(path: string, deadline: number): Promise<string> {
  for (;;) {
    try { return await readStablePrivateJsonText(path); }
    catch (error: unknown) {
      if (Date.now() >= deadline) { throw error; }
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/assemble-remediation-bundle.js") === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Remediation bundle assembly failed: ${sanitizedCliError(error, process.env)}\n`);
    process.exitCode = 1;
  });
}
