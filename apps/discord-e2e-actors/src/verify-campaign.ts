import { readFile } from "node:fs/promises";

import {
  fixtureManifestV1Schema,
  retainedE2eEvidenceV2Schema,
  verifyE2eCampaign,
} from "./e2e-evidence.js";

async function main(): Promise<void> {
  const { evidencePaths, manifestPath } = parseCampaignArguments(process.argv.slice(2));
  const manifest = fixtureManifestV1Schema.parse(await readJson(manifestPath));
  const runs = await Promise.all(
    evidencePaths.map(async (path) => retainedE2eEvidenceV2Schema.parse(await readJson(path))),
  );
  const verification = verifyE2eCampaign(manifest, runs);
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
