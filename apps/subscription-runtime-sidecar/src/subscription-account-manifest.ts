import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { z } from "zod";

import {
  subscriptionProviderInstanceId,
  type SubscriptionRuntimeAccount,
} from "./subscription-account-pool.js";

export const maximumAccountPoolSize = 8;

const accountPoolManifestSchema = z.object({
  generation: z.string().regex(/^[0-9a-f]{32}$/u),
  schemaVersion: z.literal(1),
  slots: z.array(z.object({
    authJsonPath: z.string().min(1),
    id: z.string().regex(/^slot-[1-9][0-9]*$/u),
  }).strict()).min(1).max(maximumAccountPoolSize),
}).strict();

export async function resolveSubscriptionAccountPool(
  manifestPath: string,
): Promise<readonly SubscriptionRuntimeAccount[]> {
  const manifestStat = await lstat(manifestPath);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    (manifestStat.mode & 0o022) !== 0 ||
    (await realpath(manifestPath)) !== manifestPath
  ) {
    throw new Error("Subscription account pool manifest is unsafe");
  }
  const parsed = accountPoolManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
  );
  const poolRoot = await realpath(dirname(manifestPath));
  const accounts: SubscriptionRuntimeAccount[] = [];
  for (const [index, slot] of parsed.slots.entries()) {
    const expectedId = `slot-${index + 1}`;
    if (
      slot.id !== expectedId ||
      slot.authJsonPath !==
        `generations/${parsed.generation}/${expectedId}/auth.json`
    ) {
      throw new Error("Subscription account pool slots are not canonical");
    }
    const authJsonPath = resolve(poolRoot, slot.authJsonPath);
    if (
      !authJsonPath.startsWith(`${poolRoot}${sep}`) ||
      (await realpath(authJsonPath)) !== authJsonPath
    ) {
      throw new Error("Subscription account pool auth path escapes custody root");
    }
    accounts.push({
      authJsonPath,
      id: slot.id,
      providerInstanceId: subscriptionProviderInstanceId(slot.id),
    });
  }
  return accounts;
}
