import { readFile } from "node:fs/promises";

import {
  deploymentRevisionExpectationSchema,
  fixtureManifestV1Schema,
  retainedE2eEvidenceSchema,
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
  const evidence = retainedE2eEvidenceSchema.parse(JSON.parse(evidenceJson));
  const expectedRevisions = deploymentRevisionExpectationSchema.parse({
    craig: process.env.DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION,
    meetingPlatform: process.env.DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION,
    pipecat: process.env.DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION,
    subscriptionRuntime: process.env.DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION,
  });
  const verification = verifyRetainedE2eEvidence(manifest, evidence, expectedRevisions);
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
