import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { HostedCampaignPassReceipt } from "./hosted-campaign-coordinator.js";
import type { HostedCampaignPassReceiptV2 } from "./hosted-campaign-pass-receipt.js";

export async function writeCreateOnlyHostedCampaignReceipt(
  path: string,
  receipt: HostedCampaignPassReceipt | HostedCampaignPassReceiptV2,
): Promise<void> {
  const parentPath = dirname(path);
  const temporaryPath = join(parentPath, `.${basename(path)}.partial-${randomUUID()}`);
  const payload = `${JSON.stringify(receipt, undefined, 2)}\n`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, path);
    await syncDirectory(parentPath);
  } finally {
    await handle.close().catch(() => {});
    await rm(temporaryPath, { force: true });
    await syncDirectory(parentPath);
  }
}

export async function assertHostedCampaignReceiptAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") { return; }
    throw error;
  }
  throw new Error("Hosted campaign receipt already exists; use a new campaign ID and artifact root");
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
    await handle.sync();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") { throw error; }
  } finally { await handle?.close(); }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) { return undefined; }
  return typeof error.code === "string" ? error.code : undefined;
}
