import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchive, readRegular, createReceipt, same, requireEvidence, sha256, canonical } from "./oss-campaign-artifacts.js";
import { verifyOssCampaign } from "./oss-campaign-verification.js";

// Offline only: never invokes actors, Docker, providers, Discord or a queue replay.
export async function runOssCampaignCommand(args: readonly string[]) {
  const [mode, planPath, root, manifestPath, receiptPath, ...extra] = args;
  requireEvidence((mode === "check" || mode === "qualify" || mode === "verify") && planPath && root && manifestPath &&
    receiptPath && extra.length === 0,
  "Usage: oss-campaign-main.js check|verify|qualify PLAN ARCHIVE FIXTURE_MANIFEST REPORT");
  const archive = await loadArchive(planPath, root);
  const receipt = await verifyOssCampaign(archive, await readRegular(manifestPath));
  requireEvidence(mode !== "qualify",
    "Campaign PASS unavailable from offline archives. Use trusted-collect for independent runtime custody. " +
    "Use check for a sources-unverified consistency report; no pass receipt was written.");
  if (mode === "check") await createReceipt(receiptPath, receipt);
  else {
    const retained: unknown = JSON.parse((await readRegular(receiptPath)).toString("utf8"));
    const replayEnvelope = { kind: "oss-discord-stt-trusted-pass-v1", status: "passed", origin: "root-runtime-collection",
      evidence: receipt, inventorySha256: sha256(canonical(receipt.artifacts)) };
    requireEvidence(same(retained, receipt) || (receipt.consistency === "complete" && same(retained, replayEnvelope)),
      "Evidence report differs from reverified artifacts");
    // Replay checks retained content, not where a claimed receipt originated.
  }
  return { kind: "oss-discord-stt-verification", status: receipt.status,
    campaignId: receipt.campaignId, collectionSha256: receipt.collectionSha256 };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runOssCampaignCommand(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "OSS campaign verification failed"}\n`);
    process.exitCode = 1;
  });
}
