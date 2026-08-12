import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
import { HostedCampaignArtifactStore } from "./hosted-campaign-artifact-store.js";
import {
  HostedCampaignProcessAdapter,
  type HostedCampaignTrustedRuntimeEnvironment,
  validateHostedCampaignTrustedRuntimeEnvironment,
} from "./hosted-campaign-process-adapter.js";

export interface HostedCampaignCliDependencies {
  readonly now: () => number;
  readonly ports: HostedCampaignPorts;
  readonly readPlan: (path: string) => Promise<unknown>;
  readonly writeReceipt: (path: string, receipt: HostedCampaignPassReceipt) => Promise<void>;
}

export class HostedCampaignInterruptedError extends Error {
  readonly exitCode: 130 | 143;

  constructor(readonly signal: "SIGINT" | "SIGTERM") {
    super(`Received ${signal}`);
    this.name = "HostedCampaignInterruptedError";
    this.exitCode = signal === "SIGINT" ? 130 : 143;
  }
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
  if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o777) !== 0o600
    || status.size > 1024 * 1024) {
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

export function loadHostedCampaignTrustedRuntimeEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): HostedCampaignTrustedRuntimeEnvironment {
  const optional = <Name extends "LANG" | "LC_ALL" | "SSH_AUTH_SOCK">(
    name: Name,
  ): { readonly [Key in Name]: string } | Record<never, never> => {
    const value = environment[name];
    return value === undefined ? {} : { [name]: value } as { readonly [Key in Name]: string };
  };
  return validateHostedCampaignTrustedRuntimeEnvironment({
    HOME: environment.HOME ?? "",
    ...optional("LANG"),
    ...optional("LC_ALL"),
    PATH: environment.PATH ?? "",
    ...optional("SSH_AUTH_SOCK"),
  });
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const forwardSignal = (signal: "SIGINT" | "SIGTERM") =>
    controller.abort(new HostedCampaignInterruptedError(signal));
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  try {
    const config = parseHostedCampaignArguments(process.argv.slice(2));
    const plan = parseHostedCampaignPlan(await readPrivateHostedCampaignPlan(config.planPath));
    const campaignId = plan.runs[0]!.campaignId;
    const artifactRoot = join(dirname(config.receiptPath), `${campaignId}.artifacts`);
    const store = new HostedCampaignArtifactStore(artifactRoot, campaignId);
    await store.initialize();
    const adapter = new HostedCampaignProcessAdapter({
      artifactStore: store,
      distRoot: dirname(fileURLToPath(import.meta.url)),
      trustedRuntimeEnvironment: loadHostedCampaignTrustedRuntimeEnvironment(process.env),
    });
    await runHostedCampaignCli(process.argv.slice(2), {
      now: Date.now,
      ports: adapter,
      readPlan: readPrivateHostedCampaignPlan,
      writeReceipt: writeCreateOnlyHostedCampaignReceipt,
    }, controller.signal);
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/run-hosted-campaign.js") === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown hosted campaign failure";
    process.stderr.write(`Hosted campaign failed: ${message}\n`);
    process.exitCode = error instanceof HostedCampaignInterruptedError ? error.exitCode : 1;
  });
}
