import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { readStablePrivateJson, readStablePrivateJsonText } from
  "./compile-hosted-campaign-plan.js";
import { verifyFiniteArtifactManifest } from "./finite-artifact-manifest.js";
import { verifyHostedCampaignPassReceiptPlan } from "./hosted-campaign-pass-receipt.js";
import { parseHostedCampaignPlan } from "./hosted-campaign-run-config.js";
import { assertThinRemediationProofMatchesPlan } from "./thin-remediation-proof.js";
import type { HostedCampaignInput } from "./hosted-campaign-coordinator.js";
import { craigCampaignStackReceiptV2Schema, verifyCraigCampaignStackInputBindings,
  type CraigCampaignStackReceiptV2 } from
  "./craig-disposable-campaign-stack.js";
import { digestCanonical } from "./hosted-campaign-local-admission.js";

export function parsePassVerificationArguments(arguments_: readonly string[]): {
  readonly artifactRoot: string;
  readonly planPath: string;
  readonly receiptPath: string;
} {
  const values = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (values.length !== 3 || values.some((value) => !value.startsWith("/"))) {
    throw new Error("Usage: verify-hosted-campaign-pass <pass-receipt.json> <exact-plan.json> <artifact-root>");
  }
  return { receiptPath: values[0]!, planPath: values[1]!, artifactRoot: values[2]! };
}

async function main(): Promise<void> {
  const paths = parsePassVerificationArguments(process.argv.slice(2));
  const receipt = await verifyHostedCampaignPassFiles(paths);
  process.stdout.write(`${JSON.stringify({
    artifactCount: receipt.artifacts.length,
    artifactsSha256: receipt.artifactsSha256,
    campaignId: receipt.campaignId,
    kind: "hosted-campaign-pass-verification",
    planSha256: receipt.planSha256,
    receiptSha256: receipt.receiptSha256,
    status: "verified",
  })}\n`);
}

export async function verifyHostedCampaignPassFiles(paths: Readonly<{
  artifactRoot: string; planPath: string; receiptPath: string;
}>) {
  const plan = parseHostedCampaignPlan(await readStablePrivateJson(paths.planPath));
  const receipt = verifyHostedCampaignPassReceiptPlan(
    await readStablePrivateJson(paths.receiptPath), plan,
  );
  await verifyFiniteArtifactManifest(paths.artifactRoot, receipt.artifacts);
  await verifyHostedCampaignArtifactsAgainstPlan(paths.artifactRoot, plan);
  const stack = await verifyRetainedCraigStackReceipt(paths.artifactRoot, plan, receipt);
  const lease = await verifyCampaignLeaseReceipt(paths.artifactRoot, plan, receipt, stack);
  await verifyCraigMutationStartReceipt(paths.artifactRoot, receipt);
  const teardown = await verifyCraigTeardownReceipt(paths.artifactRoot, receipt, lease);
  await verifyCampaignLeaseCleanupReceipt(paths.artifactRoot, receipt, stack, lease, teardown);
  return receipt;
}

async function verifyCraigMutationStartReceipt(
  artifactRoot: string,
  pass: ReturnType<typeof verifyHostedCampaignPassReceiptPlan>,
): Promise<void> {
  const [value, stack] = await Promise.all([
    readStablePrivateJson(join(artifactRoot, "control/craig-stack-mutation-start.json")),
    readStablePrivateJson(join(artifactRoot, "control/craig-stack-receipt.json")),
  ]);
  if (!isRecord(value) || !isRecord(stack) || value.kind !== "craig-stack-mutation-start"
    || value.schemaVersion !== 1 || value.campaignId !== pass.campaignId
    || value.hostedPlanSha256 !== pass.planSha256 || value.projectName !== pass.craigStack.projectName
    || value.planSha256 !== stack.planSha256 || value.campaignLeaseSha256 !== (stack.campaignLease as
      Record<string, unknown> | undefined)?.sha256
    || value.composeCanonicalSha256 !== (stack.composeFileIdentity as Record<string, unknown> | undefined)?.sha256
    || JSON.stringify(value.release) !== JSON.stringify(pass.release)
    || typeof value.startedAt !== "string" || !Number.isSafeInteger(Date.parse(value.startedAt))
    || typeof value.receiptSha256 !== "string" || !/^[a-f\d]{64}$/u.test(value.receiptSha256)) {
    throw new Error("Craig mutation-start receipt does not match the retained pass and stack receipts");
  }
  const { receiptSha256, ...content } = value;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Craig mutation-start receipt digest is invalid");
  }
}

async function verifyCampaignLeaseReceipt(
  artifactRoot: string,
  plan: HostedCampaignInput,
  pass: ReturnType<typeof verifyHostedCampaignPassReceiptPlan>,
  stack: CraigCampaignStackReceiptV2,
): Promise<Record<string, unknown>> {
  const value = await readStablePrivateJson(join(artifactRoot, "control/campaign-lease-receipt.json"));
  if (!isRecord(value) || value.kind !== "campaign-lease-receipt" || value.schemaVersion !== 1
    || value.campaignId !== pass.campaignId || value.hostedPlanSha256 !== pass.planSha256
    || value.campaignRoot !== artifactRoot || typeof value.device !== "number"
    || !Number.isSafeInteger(value.device) || value.device < 0 || typeof value.inode !== "number"
    || !Number.isSafeInteger(value.inode) || value.inode < 0 || typeof value.leaseSha256 !== "string"
    || !/^[a-f\d]{64}$/u.test(value.leaseSha256) || typeof value.receiptSha256 !== "string"
    || !/^[a-f\d]{64}$/u.test(value.receiptSha256) || plan.runs[0]?.campaignId !== value.campaignId) {
    throw new Error("Campaign lease receipt does not match the retained pass and plan");
  }
  const { receiptSha256, ...content } = value;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Campaign lease receipt digest is invalid");
  }
  assertCampaignLeaseCustodyMatches({ artifactRoot, lease: value, pass, stack });
  return value;
}

export function assertCampaignLeaseCustodyMatches(input: Readonly<{
  artifactRoot: string;
  lease: Record<string, unknown>;
  pass: ReturnType<typeof verifyHostedCampaignPassReceiptPlan>;
  stack: CraigCampaignStackReceiptV2;
}>): void {
  const { artifactRoot, lease, pass, stack } = input;
  if (lease.device !== stack.campaignLease.device || lease.inode !== stack.campaignLease.inode
    || lease.leaseSha256 !== stack.campaignLease.sha256 || lease.campaignRoot !== stack.campaignRoot
    || lease.hostedPlanSha256 !== stack.hostedPlanSha256
    || lease.device !== pass.campaignLease.device || lease.inode !== pass.campaignLease.inode
    || lease.leaseSha256 !== pass.campaignLease.leaseSha256
    || lease.campaignRoot !== pass.campaignLease.campaignRoot
    || lease.hostedPlanSha256 !== pass.campaignLease.planSha256
    || lease.receiptSha256 !== pass.campaignLease.receiptSha256
    || lease.campaignRoot !== artifactRoot) {
    throw new Error("Campaign lease receipt contradicts the retained stack or pass receipt");
  }
}

async function verifyCraigTeardownReceipt(
  artifactRoot: string,
  pass: ReturnType<typeof verifyHostedCampaignPassReceiptPlan>,
  lease: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const value = await readStablePrivateJson(join(artifactRoot, "control/craig-stack-teardown.json"));
  if (!isRecord(value) || value.kind !== "craig-stack-teardown" || value.schemaVersion !== 1
    || value.projectName !== pass.craigStack.projectName
    || value.stackReceiptSha256 !== pass.craigStack.receiptSha256
    || value.campaignLeaseReceiptSha256 !== lease.receiptSha256
    || value.campaignLeaseSha256 !== lease.leaseSha256
    || value.hostedPlanSha256 !== pass.planSha256
    || value.passReceiptSha256 !== pass.receiptSha256 || typeof value.receiptSha256 !== "string"
    || typeof value.completedAt !== "string") {
    throw new Error("Craig teardown receipt does not match the retained pass and stack receipts");
  }
  const { receiptSha256, ...content } = value;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Craig teardown receipt digest is invalid");
  }
  return value;
}

export async function verifyCampaignLeaseCleanupReceipt(
  artifactRoot: string,
  pass: ReturnType<typeof verifyHostedCampaignPassReceiptPlan>,
  stack: CraigCampaignStackReceiptV2,
  lease: Record<string, unknown>,
  teardown: Record<string, unknown>,
): Promise<void> {
  const leasePath = join(artifactRoot, "barriers/campaign.lease");
  try {
    await lstat(leasePath);
    throw new Error("Live campaign lease remains present after successful cleanup");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") { throw error; }
  }
  const digest = z.string().regex(/^[a-f\d]{64}$/u);
  const cleanupSchema = z.object({ campaignId: z.literal(pass.campaignId), campaignRoot: z.literal(artifactRoot),
    deleted: z.literal(true), device: z.literal(lease.device as number),
    hostedPlanSha256: z.literal(lease.hostedPlanSha256 as string), inode: z.literal(lease.inode as number),
    kind: z.literal("campaign-lease-cleanup"), leasePath: z.literal(leasePath),
    leaseReceiptSha256: z.literal(lease.receiptSha256 as string),
    leaseSha256: z.literal(lease.leaseSha256 as string), passReceiptSha256: z.literal(pass.receiptSha256),
    projectName: z.literal(stack.projectName), receiptSha256: digest, schemaVersion: z.literal(1),
    stackReceiptSha256: z.literal(stack.receiptSha256),
    teardownReceiptSha256: z.literal(teardown.receiptSha256 as string) }).strict();
  const parsed = cleanupSchema.safeParse(
    await readStablePrivateJson(join(artifactRoot, "control/campaign-lease-cleanup.json")));
  if (!parsed.success) {
    throw new Error("Campaign lease cleanup receipt contradicts retained lease/stack/pass/teardown custody",
      { cause: parsed.error });
  }
  const value = parsed.data;
  const { receiptSha256, ...content } = value;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Campaign lease cleanup receipt digest is invalid");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function verifyRetainedCraigStackReceipt(
  artifactRoot: string,
  plan: HostedCampaignInput,
  pass: ReturnType<typeof verifyHostedCampaignPassReceiptPlan>,
): Promise<CraigCampaignStackReceiptV2> {
  const stack = craigCampaignStackReceiptV2Schema.parse(
    await readStablePrivateJson(join(artifactRoot, "control/craig-stack-receipt.json")),
  );
  const { receiptSha256, ...content } = stack;
  const createdAt = Date.parse(stack.createdAt);
  if (digestCanonical(content) !== receiptSha256
    || pass.craigStack.receiptSha256 !== receiptSha256
    || pass.craigStack.projectName !== stack.projectName
    || stack.campaignId !== pass.campaignId
    || stack.projectName !== plan.target.craigProject
    || stack.hostedPlanSha256 !== pass.planSha256
    || JSON.stringify(stack.release) !== JSON.stringify(pass.release)
    || !Number.isSafeInteger(createdAt) || createdAt > Date.now()
    || Date.now() - createdAt > 24 * 60 * 60_000) {
    throw new Error("Retained Craig stack receipt is stale, replayed, corrupt, or mismatched");
  }
  await verifyCraigCampaignStackInputBindings(
    stack,
    await readStablePrivateJson(join(artifactRoot, "control/craig-stack-input.json")),
  );
  return stack;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : undefined;
}

export async function verifyHostedCampaignArtifactsAgainstPlan(
  artifactRoot: string,
  plan: HostedCampaignInput,
): Promise<void> {
  const proof = assertThinRemediationProofMatchesPlan(
    await readStablePrivateJson(join(artifactRoot, "thin-remediation.json")),
    plan,
  );
  const recordingReadyBytes = await readStablePrivateJsonText(
    join(artifactRoot, "run-3/recording-ready.json"),
  );
  const retainedReady = proof.artifacts.recordingReady;
  if (retainedReady.outputArtifactSha256 !== sha256(recordingReadyBytes) ||
    JSON.stringify(retainedReady.content) !==
      JSON.stringify(JSON.parse(recordingReadyBytes) as unknown)) {
    throw new Error("Remediation bundle does not bind the independent recording-ready artifact");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/verify-hosted-campaign-pass.js") === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown pass verification failure";
    process.stderr.write(`Hosted campaign pass verification failed: ${message}\n`);
    process.exitCode = 1;
  });
}
