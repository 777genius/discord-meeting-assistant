import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";

import {
  runHostedCampaign,
  type HostedCampaignPassReceipt,
  type HostedCampaignPorts,
} from "./hosted-campaign-coordinator.js";
import {
  assertExecutableEnvironmentPaths,
  parseHostedCampaignArguments,
  parseHostedCampaignPlan,
} from "./hosted-campaign-run-config.js";

export interface HostedCampaignCliDependencies {
  readonly now: () => number;
  readonly ports: HostedCampaignPorts;
  readonly readPlan: (path: string) => Promise<unknown>;
  readonly writeReceipt: (path: string, receipt: HostedCampaignPassReceipt) => Promise<void>;
}

export async function runHostedCampaignCli(
  arguments_: readonly string[],
  dependencies: HostedCampaignCliDependencies,
  signal: AbortSignal,
): Promise<HostedCampaignPassReceipt> {
  const config = parseHostedCampaignArguments(arguments_);
  const input = parseHostedCampaignPlan(await dependencies.readPlan(config.planPath));
  assertExecutableEnvironmentPaths(input.children);
  const deadlineEpochMilliseconds = dependencies.now() + config.timeoutMilliseconds;
  if (!Number.isSafeInteger(deadlineEpochMilliseconds)) {
    throw new Error("Hosted campaign deadline is unsafe");
  }
  const receipt = await runHostedCampaign(input, dependencies.ports, { deadlineEpochMilliseconds, signal });
  await dependencies.writeReceipt(config.receiptPath, receipt);
  return receipt;
}

export async function readPrivateHostedCampaignPlan(path: string): Promise<unknown> {
  const status = await lstat(path);
  if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o777) !== 0o600) {
    throw new Error("Hosted campaign plan must be a regular owned mode-0600 file");
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error("Hosted campaign plan must be owned by the current user");
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function writeCreateOnlyHostedCampaignReceipt(
  path: string,
  receipt: HostedCampaignPassReceipt,
): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(receipt, undefined, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  throw new Error(
    "Hosted campaign process adapter is not wired; the typed coordinator cannot yet map the full real action order",
  );
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/run-hosted-campaign.js") === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown hosted campaign failure";
    process.stderr.write(`Hosted campaign failed: ${message}\n`);
    process.exitCode = 1;
  });
}
