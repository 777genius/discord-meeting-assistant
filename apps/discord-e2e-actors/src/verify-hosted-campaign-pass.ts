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
import { verifyCraigMutationStartReceipt as parseCraigMutationStartReceipt } from
  "./craig-campaign-stack-evidence.js";
import { hostedCampaignReleaseReferenceV1Schema } from "./hosted-campaign-release-reference.js";

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
  const mutation = parseCraigMutationStartReceipt(value);
  const retainedStack = craigCampaignStackReceiptV2Schema.parse(stack);
  const { containerId: _containerId, databaseContainerId: _databaseContainerId,
    networkId: _networkId, semanticPolicySha256: _semanticPolicySha256,
    ...stackNetworkPolicy } = retainedStack.networkPolicy;
  if (mutation.campaignId !== pass.campaignId || mutation.hostedPlanSha256 !== pass.planSha256
    || mutation.projectName !== pass.craigStack.projectName || mutation.planSha256 !== retainedStack.planSha256
    || mutation.campaignLeaseSha256 !== retainedStack.campaignLease.sha256
    || mutation.composeCanonicalSha256 !== retainedStack.composeFileIdentity.sha256
    || digestCanonical(mutation.networkPolicy) !== digestCanonical(stackNetworkPolicy)
    || JSON.stringify(mutation.release) !== JSON.stringify(pass.release)) {
    throw new Error("Craig mutation-start receipt does not match the retained pass and stack receipts");
  }
}

async function verifyCampaignLeaseReceipt(
  artifactRoot: string,
  plan: HostedCampaignInput,
  pass: ReturnType<typeof verifyHostedCampaignPassReceiptPlan>,
  stack: CraigCampaignStackReceiptV2,
): Promise<Record<string, unknown>> {
  const schema = z.object({ campaignId: z.literal(pass.campaignId), campaignRoot: z.literal(artifactRoot),
    device: z.number().int().nonnegative(), hostedPlanSha256: z.literal(pass.planSha256),
    inode: z.number().int().nonnegative(), kind: z.literal("campaign-lease-receipt"),
    leaseSha256: z.string().regex(/^[a-f\d]{64}$/u), receiptSha256: z.string().regex(/^[a-f\d]{64}$/u),
    schemaVersion: z.literal(1) }).strict();
  const parsed = schema.safeParse(await readStablePrivateJson(join(artifactRoot, "control/campaign-lease-receipt.json")));
  if (!parsed.success || plan.runs[0]?.campaignId !== parsed.data.campaignId) {
    throw new Error("Campaign lease receipt does not match the retained pass and plan");
  }
  const value = parsed.data;
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
  const digest = z.string().regex(/^[a-f\d]{64}$/u);
  const stack = craigCampaignStackReceiptV2Schema.parse(
    await readStablePrivateJson(join(artifactRoot, "control/craig-stack-receipt.json")));
  const schema = z.object({ absenceProof: z.object({
    absentContainerIds: z.tuple([z.literal(stack.containerId), z.literal(stack.databaseContainerId)]),
    absentNetworkId: z.literal(stack.networkPolicy.networkId),
    absentNetworkName: z.literal(stack.networkPolicy.name), absentVolumeName: z.literal(stack.databaseVolume),
    campaignId: z.literal(stack.campaignId), kind: z.literal("craig-stack-absence-proof"),
    planSha256: z.literal(stack.planSha256), projectName: z.literal(stack.projectName),
    release: hostedCampaignReleaseReferenceV1Schema, schemaVersion: z.literal(1) }).strict(),
    campaignLeaseReceiptSha256: digest, campaignLeaseSha256: digest, completedAt: z.iso.datetime(),
    hostedPlanSha256: digest, kind: z.literal("craig-stack-teardown"), passReceiptSha256: digest,
    projectName: z.literal(pass.craigStack.projectName), receiptSha256: digest, schemaVersion: z.literal(1),
    stackReceiptSha256: digest }).strict();
  const parsed = schema.safeParse(value);
  if (!parsed.success) { throw new Error("Craig teardown receipt schema is not closed", { cause: parsed.error }); }
  const teardown = parsed.data;
  if (JSON.stringify(teardown.absenceProof.release) !== JSON.stringify(stack.release)
    || teardown.stackReceiptSha256 !== pass.craigStack.receiptSha256
    || teardown.campaignLeaseReceiptSha256 !== lease.receiptSha256
    || teardown.campaignLeaseSha256 !== lease.leaseSha256
    || teardown.hostedPlanSha256 !== pass.planSha256
    || teardown.passReceiptSha256 !== pass.receiptSha256) {
    throw new Error("Craig teardown receipt does not match the retained pass and stack receipts");
  }
  const { receiptSha256, ...content } = teardown;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Craig teardown receipt digest is invalid");
  }
  return teardown;
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
