import { readFile } from "node:fs/promises";

import {
  deploymentRevisionExpectationSchema,
  fixtureManifestV1Schema,
  retainedE2eEvidenceSchema,
  verifyE2eCampaign,
} from "./e2e-evidence.js";

async function main(): Promise<void> {
  const { evidencePaths, manifestPath } = parseCampaignArguments(process.argv.slice(2));
  const manifest = fixtureManifestV1Schema.parse(await readJson(manifestPath));
  const runs = await Promise.all(
    evidencePaths.map(async (path) => retainedE2eEvidenceSchema.parse(await readJson(path))),
  );
  const expectedRevisions = deploymentRevisionExpectationSchema.parse({
    craig: process.env.DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION,
    meetingPlatform: process.env.DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION,
    subscriptionRuntime: process.env.DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION,
  });
  const verification = verifyE2eCampaign(manifest, runs, expectedRevisions);
  process.stdout.write(`${JSON.stringify(verification, undefined, 2)}\n`);
  if (!verification.passed) {
    process.exitCode = 1;
  }
}

export function parseCampaignArguments(args: readonly string[]): {
  readonly evidencePaths: readonly string[];
  readonly manifestPath: string;
} {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  const [manifestPath, ...evidencePaths] = normalized;
  if (manifestPath === undefined || evidencePaths.length < 3) {
    throw new Error("Usage: verify-campaign <manifest.json> <evidence.json> <evidence.json> <evidence.json> [...]");
  }
  return { evidencePaths, manifestPath };
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
