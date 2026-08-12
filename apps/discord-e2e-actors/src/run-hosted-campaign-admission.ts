import { readFile } from "node:fs/promises";

import {
  inspectHostedCampaignAdmission,
  writeCreateOnlyAdmissionReceipt,
} from "./hosted-campaign-admission.js";

export interface HostedAdmissionArguments {
  readonly definitionPath: string;
  readonly minimumFreeBytes: number;
  readonly receiptPath: string;
  readonly remoteEvidencePath?: string;
}

export function parseHostedAdmissionArguments(arguments_: readonly string[]): HostedAdmissionArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--") || values.has(flag)) {
      throw new Error("Usage: --definition <path> --receipt <path> --minimum-free-bytes <bytes> [--remote-evidence <path>]");
    }
    values.set(flag, value);
  }
  const definitionPath = values.get("--definition");
  const receiptPath = values.get("--receipt");
  const minimumFreeBytes = Number(values.get("--minimum-free-bytes"));
  const allowed = new Set(["--definition", "--receipt", "--minimum-free-bytes", "--remote-evidence"]);
  if (definitionPath === undefined || receiptPath === undefined || !Number.isSafeInteger(minimumFreeBytes)
    || minimumFreeBytes < 1 || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new Error("Usage: --definition <path> --receipt <path> --minimum-free-bytes <bytes> [--remote-evidence <path>]");
  }
  const remoteEvidencePath = values.get("--remote-evidence");
  return { definitionPath, minimumFreeBytes, receiptPath, ...(remoteEvidencePath === undefined ? {} : { remoteEvidencePath }) };
}

async function main(): Promise<void> {
  const config = parseHostedAdmissionArguments(process.argv.slice(2));
  const definition = JSON.parse(await readFile(config.definitionPath, "utf8")) as unknown;
  const remoteEvidence = config.remoteEvidencePath === undefined ? undefined
    : JSON.parse(await readFile(config.remoteEvidencePath, "utf8")) as unknown;
  const receipt = await inspectHostedCampaignAdmission({
    definition, minimumFreeBytes: config.minimumFreeBytes, remoteEvidence,
  });
  await writeCreateOnlyAdmissionReceipt(config.receiptPath, receipt);
  if (receipt.status !== "admitted") {
    throw new Error(`Hosted campaign admission blocked: ${receipt.missingCapabilities.join(",")}`);
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/run-hosted-campaign-admission.js") === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Hosted campaign admission failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
