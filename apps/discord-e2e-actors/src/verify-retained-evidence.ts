import { readFile } from "node:fs/promises";

import {
  fixtureManifestV1Schema,
  retainedE2eEvidenceV2Schema,
  verifyRetainedE2eEvidence,
} from "./e2e-evidence.js";

async function main(): Promise<void> {
  const [manifestPath, evidencePath] = process.argv.slice(2);
  if (manifestPath === undefined || evidencePath === undefined) {
    throw new Error("Usage: verify-retained-evidence <manifest.json> <retained-evidence.json>");
  }

  const [manifestJson, evidenceJson] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(evidencePath, "utf8"),
  ]);
  const manifest = fixtureManifestV1Schema.parse(JSON.parse(manifestJson));
  const evidence = retainedE2eEvidenceV2Schema.parse(JSON.parse(evidenceJson));
  const verification = verifyRetainedE2eEvidence(manifest, evidence);
  process.stdout.write(`${JSON.stringify(verification, undefined, 2)}\n`);
  if (!verification.passed) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown E2E verifier failure";
  process.stderr.write(`Discord E2E verification failed: ${message}\n`);
  process.exitCode = 1;
});
