import { isAbsolute } from "node:path";

import { z } from "zod";

import { readStablePrivateJson } from "./compile-hosted-campaign-plan.js";
import { writeCreateOnlyPrivateJson } from "./create-only-private-json.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";
import {
  observePrivateCampaignCoverage,
  type PrivateCampaignCoverageObservationPort,
} from "./private-campaign-coverage-qualification.js";

const environmentSchema = z.object({
  DISCORD_E2E_PRIVATE_COVERAGE_CAMPAIGN_ID: z.string().trim().min(1),
  DISCORD_E2E_PRIVATE_COVERAGE_MUTATION_TARGET: z.literal("private-test-guild"),
  DISCORD_E2E_PRIVATE_COVERAGE_OUTPUT: z.string().refine(isAbsolute),
  DISCORD_E2E_PRIVATE_COVERAGE_RUN_ID: z.string().trim().min(1),
  DISCORD_E2E_PRIVATE_COVERAGE_SOURCE_INPUT: z.string().refine(isAbsolute),
}).loose();

export async function observePrivateCampaignCoverageCli(
  environment: NodeJS.ProcessEnv,
  portFactory: (path: string) => PrivateCampaignCoverageObservationPort = (path) => ({
    observe: async () => readStablePrivateJson(path),
  }),
): Promise<void> {
  const config = environmentSchema.parse(environment);
  const proof = await observePrivateCampaignCoverage(
    portFactory(config.DISCORD_E2E_PRIVATE_COVERAGE_SOURCE_INPUT),
  );
  if (proof.campaignId !== config.DISCORD_E2E_PRIVATE_COVERAGE_CAMPAIGN_ID ||
    proof.privateTestGuildId !== HOSTED_CAMPAIGN_TARGET.guildId ||
    proof.observerActorId !== HOSTED_CAMPAIGN_TARGET.observerApplicationId ||
    proof.sutActorId !== HOSTED_CAMPAIGN_TARGET.sutApplicationId ||
    proof.liveMemory.runId !== config.DISCORD_E2E_PRIVATE_COVERAGE_RUN_ID ||
    proof.simultaneousGreetings.runId !== config.DISCORD_E2E_PRIVATE_COVERAGE_RUN_ID ||
    proof.questionScenarios.some(({ identity }) =>
      identity.runId !== config.DISCORD_E2E_PRIVATE_COVERAGE_RUN_ID)) {
    throw new Error("Private campaign coverage is bound to another campaign, run, or bot identity");
  }
  await writeCreateOnlyPrivateJson(config.DISCORD_E2E_PRIVATE_COVERAGE_OUTPUT, proof);
  process.stdout.write(`${JSON.stringify({
    kind: "private-coverage-observer-completion",
    outputPath: config.DISCORD_E2E_PRIVATE_COVERAGE_OUTPUT,
    runId: config.DISCORD_E2E_PRIVATE_COVERAGE_RUN_ID,
    status: "completed",
  })}\n`);
}

if (process.argv[1]?.replaceAll("\\", "/")
  .endsWith("/observe-private-campaign-coverage.js") === true) {
  void observePrivateCampaignCoverageCli(process.env).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown private coverage failure";
    process.stderr.write(`Private Discord campaign coverage failed: ${message}\n`);
    process.exitCode = 1;
  });
}
