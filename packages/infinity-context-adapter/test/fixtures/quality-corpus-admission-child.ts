import { runQualityCampaignProductionCli } from
  "../../src/quality-campaign/production-cli.js";

const [phasePath, statusPath] = process.argv.slice(2);
if (phasePath === undefined || statusPath === undefined) {process.exitCode = 2;}
else {
  process.exitCode = await runQualityCampaignProductionCli({
    argv: ["corpus-admit", phasePath, statusPath],
    corpusAdmissionClock: { nowEpochMs: () => 1_000_000 },
  });
}
