import {
  inspectHostedCampaignAdmission,
} from "./hosted-campaign-admission.js";
import { writeCreateOnlyAdmissionReceipt } from "./hosted-admission-receipt-store.js";
import type { HostedCampaignRemoteAdmissionProbe } from "./hosted-campaign-remote-admission.js";
import { createHostedCampaignProductionComposition } from "./hosted-campaign-production-composition.js";
import { readStablePrivateJson } from "./compile-hosted-campaign-plan.js";

export interface HostedAdmissionArguments {
  readonly bindingsPath: string;
  readonly definitionPath: string;
  readonly minimumFreeBytes: number;
  readonly planPath: string;
  readonly receiptPath: string;
  readonly remoteEvidencePath?: string;
}

export function parseHostedAdmissionArguments(arguments_: readonly string[]): HostedAdmissionArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") || values.has(flag)) {
      throw new Error("Usage: --definition <path> --bindings <path> --plan <path> --receipt <path> --minimum-free-bytes <bytes> [--remote-evidence <path>]");
    }
    values.set(flag, value);
  }
  const definitionPath = values.get("--definition");
  const bindingsPath = values.get("--bindings");
  const planPath = values.get("--plan");
  const receiptPath = values.get("--receipt");
  const minimumFreeBytes = Number(values.get("--minimum-free-bytes"));
  const allowed = new Set(["--definition", "--bindings", "--plan", "--receipt", "--minimum-free-bytes", "--remote-evidence"]);
  if (definitionPath === undefined || bindingsPath === undefined || planPath === undefined || receiptPath === undefined || !Number.isSafeInteger(minimumFreeBytes)
    || minimumFreeBytes < 1 || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("Usage: --definition <path> --bindings <path> --plan <path> --receipt <path> --minimum-free-bytes <bytes> [--remote-evidence <path>]");
  }
  const remoteEvidencePath = values.get("--remote-evidence");
  return { bindingsPath, definitionPath, minimumFreeBytes, planPath, receiptPath, ...(remoteEvidencePath === undefined ? {} : { remoteEvidencePath }) };
}

interface HostedAdmissionCliDependencies {
  readonly createRemoteAdmissionProbe?: (input: Readonly<{
    bindings: unknown;
    definition: unknown;
    plan: unknown;
  }>) => HostedCampaignRemoteAdmissionProbe;
  readonly now: () => number;
  readonly readJson: (path: string) => Promise<unknown>;
  readonly remoteAdmissionProbe?: HostedCampaignRemoteAdmissionProbe;
  readonly writeReceipt: typeof writeCreateOnlyAdmissionReceipt;
}

async function runHostedCampaignAdmissionCli(
  arguments_: readonly string[],
  dependencies: HostedAdmissionCliDependencies,
  signal?: AbortSignal,
): Promise<void> {
  const config = parseHostedAdmissionArguments(arguments_);
  const definition = await dependencies.readJson(config.definitionPath);
  const bindings = await dependencies.readJson(config.bindingsPath);
  const plan = await dependencies.readJson(config.planPath);
  const remoteEvidence = config.remoteEvidencePath === undefined ? undefined
    : await dependencies.readJson(config.remoteEvidencePath);
  const remoteAdmissionProbe = dependencies.remoteAdmissionProbe
    ?? dependencies.createRemoteAdmissionProbe?.({ bindings, definition, plan });
  const receipt = await inspectHostedCampaignAdmission({
    bindings, definition, minimumFreeBytes: config.minimumFreeBytes, plan,
    ...(remoteAdmissionProbe === undefined ? {} : {
      remoteAdmissionProbe,
    }), remoteEvidence, ...(signal === undefined ? {} : { signal }),
  }, dependencies.now);
  await dependencies.writeReceipt(config.receiptPath, receipt);
  if (receipt.status !== "admitted") {
    throw new Error(`Hosted campaign admission blocked: ${receipt.missingCapabilities.join(",")}`);
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/run-hosted-campaign-admission.js") === true) {
  const controller = new AbortController();
  const abort = (): void => { controller.abort(new Error("Hosted campaign admission interrupted")); };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const production = createHostedCampaignProductionComposition();
  void runHostedCampaignAdmissionCli(process.argv.slice(2), {
    createRemoteAdmissionProbe: (input) => production.createInitialAdmissionProbe(input),
    now: Date.now, readJson: readStablePrivateJson, writeReceipt: writeCreateOnlyAdmissionReceipt,
  }, controller.signal).catch((error: unknown) => {
    process.stderr.write(`Hosted campaign admission failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }).finally(() => {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  });
}
