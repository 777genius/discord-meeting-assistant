import { loadArchive, readRegular, createReceipt, same, requireEvidence } from "./oss-campaign-artifacts.js";
import { verifyOssCampaign } from "./oss-campaign-verification.js";

// Offline only: never invokes actors, Docker, providers, Discord or a queue replay.
async function main(): Promise<void> {
  const [mode, planPath, root, manifestPath, receiptPath, ...extra] = process.argv.slice(2);
  requireEvidence((mode === "qualify" || mode === "verify") && planPath && root && manifestPath &&
    receiptPath && extra.length === 0,
  "Usage: oss-campaign-main.js qualify|verify PLAN ARCHIVE FIXTURE_MANIFEST RECEIPT");
  const archive = await loadArchive(planPath, root);
  const receipt = await verifyOssCampaign(archive, await readRegular(manifestPath));
  if (mode === "qualify") await createReceipt(receiptPath, receipt);
  else requireEvidence(same(JSON.parse((await readRegular(receiptPath)).toString("utf8")), receipt),
    "Pass receipt differs from independently reverified artifacts");
  process.stdout.write(`${JSON.stringify({ kind: "oss-discord-stt-verification", status: "verified",
    campaignId: receipt.campaignId, collectionSha256: receipt.collectionSha256 })}\n`);
}
void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "OSS campaign verification failed"}\n`);
  process.exitCode = 1;
});
