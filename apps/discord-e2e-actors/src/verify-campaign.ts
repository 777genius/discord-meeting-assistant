import { readFile } from "node:fs/promises";

import {
  fixtureManifestV1Schema,
  retainedE2eEvidenceV1Schema,
  verifyE2eCampaign,
} from "./e2e-evidence.js";

async function main(): Promise<void> {
  const [manifestPath, ...evidencePaths] = process.argv.slice(2);
  if (manifestPath === undefined || evidencePaths.length < 3) {
    throw new Error("Usage: verify-campaign <manifest.json> <evidence.json> <evidence.json> <evidence.json> [...]");
  }
  const manifest = fixtureManifestV1Schema.parse(await readJson(manifestPath));
  const runs = await Promise.all(
    evidencePaths.map(async (path) => retainedE2eEvidenceV1Schema.parse(await readJson(path))),
  );
  const verification = verifyE2eCampaign(manifest, runs);
  process.stdout.write(`${JSON.stringify(verification, undefined, 2)}\n`);
  if (!verification.passed) {
    process.exitCode = 1;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown campaign verifier failure";
  process.stderr.write(`Discord E2E campaign verification failed: ${message}\n`);
  process.exitCode = 1;
});
