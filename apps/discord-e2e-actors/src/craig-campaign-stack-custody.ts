import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { assertUnsymlinkedParents } from "./craig-campaign-stack-local-adapters.js";
import { validateRenderedCraigCompose } from "./craig-campaign-compose-validation.js";
import { validateSourceCraigCompose } from "./craig-campaign-source-compose-validation.js";
import { digestCraigCampaignStackCanonical as digestCanonical } from "./craig-campaign-stack-digest.js";
import type {
  CraigCampaignStackCommandResult,
  CraigCampaignStackInput,
} from "./craig-disposable-campaign-stack.js";
import type { HostedCampaignLeaseHandle } from "./hosted-campaign-coordinator.js";

export type PinnedFileIdentityV1 = Readonly<{ device: number; inode: number; sha256: string }>;
type Execute = (args: readonly string[]) => Promise<CraigCampaignStackCommandResult>;

export async function revalidateCraigMutationInputs(input: Readonly<{
  compose: readonly string[];
  databaseVolume: string;
  execute: Execute;
  expectedConfigSha256: string;
  input: CraigCampaignStackInput;
  lease: HostedCampaignLeaseHandle;
  projectName: string;
  verifyPinnedImages: () => Promise<void>;
}>): Promise<void> {
  validateSourceCraigCompose(input.input.composeCanonical, input.input);
  await inspectCanonicalCampaignLease(input.input.campaignRoot, input.input.campaignId, input.lease);
  await input.verifyPinnedImages();
  const rendered = await input.execute([...input.compose, "config", "--format", "json"]);
  requireSuccess(rendered, "Craig rendered Compose mutation fence");
  const config = validateRenderedCraigCompose(
    rendered.stdout, input.input, input.projectName, input.databaseVolume,
  );
  if (digestCanonical(config) !== input.expectedConfigSha256) {
    throw new Error("Craig rendered Compose configuration changed before Docker mutation");
  }
}

export async function verifyStableFileIdentity(
  path: string,
  expected: PinnedFileIdentityV1,
): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.dev !== expected.device || before.ino !== expected.inode
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || createHash("sha256").update(contents).digest("hex") !== expected.sha256) {
      throw new Error("Craig pinned file identity or digest changed");
    }
  } finally { await handle?.close(); }
}

export async function inspectStableFile(path: string): Promise<PinnedFileIdentityV1> {
  let handle: FileHandle | undefined;
  try {
    await assertUnsymlinkedParents(path);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    const contents = await handle.readFile();
    const after = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Craig pinned input changed while it was opened");
    }
    return Object.freeze({ device: after.dev, inode: after.ino,
      sha256: createHash("sha256").update(contents).digest("hex") });
  } finally { await handle?.close(); }
}

export async function assertCanonicalUnsymlinkedCampaignPath(
  campaignRoot: string,
  campaignId: string,
): Promise<void> {
  const resolvedRoot = await realpath(campaignRoot);
  if (resolvedRoot !== campaignRoot) {
    throw new Error("Hosted campaign root must be canonical and contain no symlink");
  }
  await assertUnsymlinkedParents(join(campaignRoot, campaignId, "control", "craig.env"));
}

export async function inspectCanonicalCampaignLease(
  campaignRoot: string,
  campaignId: string,
  expected: HostedCampaignLeaseHandle,
): Promise<Readonly<{ device: number; inode: number; sha256: string }>> {
  const path = join(campaignRoot, campaignId, "barriers", "campaign.lease");
  const expectedRoot = join(campaignRoot, campaignId);
  if (expected.campaignId !== campaignId || expected.campaignRoot !== expectedRoot) {
    throw new Error("Craig stack root does not match the already-acquired campaign lease");
  }
  await assertUnsymlinkedParents(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) {
      throw new Error("Craig provisioning requires the canonical owner-held campaign lease");
    }
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    const expectedContents = `${JSON.stringify({ campaignId, campaignRoot: expectedRoot,
      planSha256: expected.planSha256 })}\n`;
    if (contents !== expectedContents || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error("Craig provisioning campaign lease changed or does not match the campaign");
    }
    const digest = createHash("sha256").update(contents).digest("hex");
    if (after.dev !== expected.device || after.ino !== expected.inode || digest !== expected.leaseSha256) {
      throw new Error("Craig provisioning lease inode/device/digest does not match the acquired handle");
    }
    return Object.freeze({ device: after.dev, inode: after.ino, sha256: digest });
  } finally { await handle?.close(); }
}

function requireSuccess(result: CraigCampaignStackCommandResult, label: string): void {
  if (result.exitCode !== 0) { throw new Error(`${label} failed closed (exit ${result.exitCode})`); }
}
