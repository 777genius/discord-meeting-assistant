import { readFile } from "node:fs/promises";

import {
  inspectHostedCampaignAdmission,
  writeCreateOnlyAdmissionReceipt,
} from "./hosted-campaign-admission.js";
import type { HostedCampaignRemoteAdmissionProbe } from "./hosted-campaign-remote-admission.js";

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

export interface HostedAdmissionCliDependencies {
  readonly now: () => number;
  readonly readJson: (path: string) => Promise<unknown>;
  readonly remoteAdmissionProbe?: HostedCampaignRemoteAdmissionProbe;
  readonly writeReceipt: typeof writeCreateOnlyAdmissionReceipt;
}

export async function runHostedCampaignAdmissionCli(
  arguments_: readonly string[],
  dependencies: HostedAdmissionCliDependencies,
): Promise<void> {
  const config = parseHostedAdmissionArguments(arguments_);
  const definition = await dependencies.readJson(config.definitionPath);
  const bindings = await dependencies.readJson(config.bindingsPath);
  const plan = await dependencies.readJson(config.planPath);
  const remoteEvidence = config.remoteEvidencePath === undefined ? undefined
    : await dependencies.readJson(config.remoteEvidencePath);
  const receipt = await inspectHostedCampaignAdmission({
    bindings, definition, minimumFreeBytes: config.minimumFreeBytes, plan,
    ...(dependencies.remoteAdmissionProbe === undefined ? {} : {
      remoteAdmissionProbe: dependencies.remoteAdmissionProbe,
    }), remoteEvidence,
  }, dependencies.now);
  await dependencies.writeReceipt(config.receiptPath, receipt);
  if (receipt.status !== "admitted") {
    throw new Error(`Hosted campaign admission blocked: ${receipt.missingCapabilities.join(",")}`);
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/run-hosted-campaign-admission.js") === true) {
  void runHostedCampaignAdmissionCli(process.argv.slice(2), {
    now: Date.now, readJson, writeReceipt: writeCreateOnlyAdmissionReceipt,
  }).catch((error: unknown) => {
    process.stderr.write(`Hosted campaign admission failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
