import { HostedCampaignInterruptedError, runProductionHostedCampaignCli } from "./run-hosted-campaign.js";

const controller = new AbortController();
const forwardSignal = (signal: "SIGINT" | "SIGTERM"): void => {
  controller.abort(new HostedCampaignInterruptedError(signal));
};
process.once("SIGINT", forwardSignal);
process.once("SIGTERM", forwardSignal);
void runProductionHostedCampaignCli(process.argv.slice(2), process.env, controller.signal)
  .catch((error: unknown) => {
    process.stderr.write(`Hosted campaign failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    process.exitCode = error instanceof HostedCampaignInterruptedError ? error.exitCode : 1;
  }).finally(() => {
    process.off("SIGINT", forwardSignal); process.off("SIGTERM", forwardSignal);
  });
