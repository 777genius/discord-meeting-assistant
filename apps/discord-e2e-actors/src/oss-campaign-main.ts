import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchive, readRegular, createReceipt, same, requireEvidence } from "./oss-campaign-artifacts.js";
import { verifyOssCampaign } from "./oss-campaign-verification.js";

// Offline only: never invokes actors, Docker, providers, Discord or a queue replay.
export async function runOssCampaignCommand(args: readonly string[]) {
  const [mode, planPath, root, manifestPath, receiptPath, ...extra] = args;
  requireEvidence((mode === "check" || mode === "qualify" || mode === "verify") && planPath && root && manifestPath &&
    receiptPath && extra.length === 0,
  "Usage: oss-campaign-main.js check|verify|qualify PLAN ARCHIVE FIXTURE_MANIFEST REPORT");
  const archive = await loadArchive(planPath, root);
  const receipt = await verifyOssCampaign(archive, await readRegular(manifestPath));
  requireEvidence(mode !== "qualify" || receipt.status === "passed",
    `Campaign PASS unavailable: ${receipt.missingSourceCapabilities.join("; ")}. ` +
    "Use check for a sources-unverified consistency report; no pass receipt was written.");
  if (mode === "check" || mode === "qualify") await createReceipt(receiptPath, receipt);
  else requireEvidence(same(JSON.parse((await readRegular(receiptPath)).toString("utf8")), receipt),
    "Evidence report differs from reverified artifacts");
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
