import { readFile } from "node:fs/promises";

import {
  deploymentRevisionExpectationSchema,
  fixtureManifestV1Schema,
  retainedE2eEvidenceSchema,
  serviceLevelThresholdsSchema,
  verifyE2eCampaign,
} from "./e2e-evidence.js";

async function main(): Promise<void> {
  const { evidencePaths, manifestPath, thresholdsPath } = parseCampaignArguments(process.argv.slice(2));
  const manifest = fixtureManifestV1Schema.parse(await readJson(manifestPath));
  const runs = await Promise.all(
    evidencePaths.map(async (path) => retainedE2eEvidenceSchema.parse(await readJson(path))),
  );
  const expectedRevisions = deploymentRevisionExpectationSchema.parse({
    craig: process.env.DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION,
    meetingPlatform: process.env.DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION,
    pipecat: process.env.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION,
    subscriptionRuntime: process.env.DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION,
  });
  const thresholds = thresholdsPath === undefined
    ? undefined
    : serviceLevelThresholdsSchema.parse(await readJson(thresholdsPath));
  const verification = verifyE2eCampaign(manifest, runs, expectedRevisions, thresholds);
  process.stdout.write(`${JSON.stringify(verification, undefined, 2)}\n`);
  if (!verification.passed) {
    process.exitCode = 1;
  }
}

export function parseCampaignArguments(args: readonly string[]): {
  readonly evidencePaths: readonly string[];
  readonly manifestPath: string;
  readonly thresholdsPath?: string;
} {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const thresholdsFlagIndex = normalized.indexOf("--service-level-thresholds");
  const thresholdsPath = thresholdsFlagIndex < 0 ? undefined : normalized[thresholdsFlagIndex + 1];
  if (thresholdsFlagIndex >= 0 && (thresholdsPath === undefined || thresholdsFlagIndex !== normalized.length - 2)) {
    throw new Error("Service-level thresholds require one final JSON path");
  }
  const positional = thresholdsFlagIndex < 0 ? normalized : normalized.slice(0, thresholdsFlagIndex);
  const [manifestPath, ...evidencePaths] = positional;
  if (manifestPath === undefined || evidencePaths.length < 3) {
    throw new Error(
      "Usage: verify-campaign <manifest.json> <evidence.json> <evidence.json> <evidence.json> [...] "
      + "[--service-level-thresholds <thresholds.json>]",
    );
  }
  return { evidencePaths, manifestPath, ...(thresholdsPath === undefined ? {} : { thresholdsPath }) };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/verify-campaign.js") === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown campaign verifier failure";
    process.stderr.write(`Discord E2E campaign verification failed: ${message}\n`);
    process.exitCode = 1;
  });
}
