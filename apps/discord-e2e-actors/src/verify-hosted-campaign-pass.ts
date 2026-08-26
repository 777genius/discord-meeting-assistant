import { createHash } from "node:crypto";
import { join } from "node:path";

import { readStablePrivateJson, readStablePrivateJsonText } from
  "./compile-hosted-campaign-plan.js";
import { verifyFiniteArtifactManifest } from "./finite-artifact-manifest.js";
import { verifyHostedCampaignPassReceiptPlan } from "./hosted-campaign-pass-receipt.js";
import { parseHostedCampaignPlan } from "./hosted-campaign-run-config.js";
import { assertThinRemediationProofMatchesPlan } from "./thin-remediation-proof.js";
import type { HostedCampaignInput } from "./hosted-campaign-coordinator.js";

export function parsePassVerificationArguments(arguments_: readonly string[]): {
  readonly artifactRoot: string;
  readonly planPath: string;
  readonly receiptPath: string;
} {
  const values = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (values.length !== 3 || values.some((value) => !value.startsWith("/"))) {
    throw new Error("Usage: verify-hosted-campaign-pass <pass-receipt.json> <exact-plan.json> <artifact-root>");
  }
  return { receiptPath: values[0]!, planPath: values[1]!, artifactRoot: values[2]! };
}

async function main(): Promise<void> {
  const paths = parsePassVerificationArguments(process.argv.slice(2));
  const plan = parseHostedCampaignPlan(await readStablePrivateJson(paths.planPath));
  const receipt = verifyHostedCampaignPassReceiptPlan(
    await readStablePrivateJson(paths.receiptPath), plan,
  );
  await verifyFiniteArtifactManifest(paths.artifactRoot, receipt.artifacts);
  await verifyHostedCampaignArtifactsAgainstPlan(paths.artifactRoot, plan);
  process.stdout.write(`${JSON.stringify({
    artifactCount: receipt.artifacts.length,
    artifactsSha256: receipt.artifactsSha256,
    campaignId: receipt.campaignId,
    kind: "hosted-campaign-pass-verification",
    planSha256: receipt.planSha256,
    receiptSha256: receipt.receiptSha256,
    status: "verified",
  })}\n`);
}

export async function verifyHostedCampaignArtifactsAgainstPlan(
  artifactRoot: string,
  plan: HostedCampaignInput,
): Promise<void> {
  const proof = assertThinRemediationProofMatchesPlan(
    await readStablePrivateJson(join(artifactRoot, "thin-remediation.json")),
    plan,
  );
  const recordingReadyBytes = await readStablePrivateJsonText(
    join(artifactRoot, "run-3/recording-ready.json"),
  );
  const retainedReady = proof.artifacts.recordingReady;
  if (retainedReady.outputArtifactSha256 !== sha256(recordingReadyBytes) ||
    JSON.stringify(retainedReady.content) !==
      JSON.stringify(JSON.parse(recordingReadyBytes) as unknown)) {
    throw new Error("Remediation bundle does not bind the independent recording-ready artifact");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/verify-hosted-campaign-pass.js") === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown pass verification failure";
    process.stderr.write(`Hosted campaign pass verification failed: ${message}\n`);
    process.exitCode = 1;
  });
}
