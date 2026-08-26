import { createHash } from "node:crypto";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";

import { readStablePrivateJson } from "./compile-hosted-campaign-plan.js";
import { removeCraigCampaignFirewall } from "./craig-campaign-network-lifecycle.js";
import { craigProjectName, deriveCraigCampaignNetworkPolicy } from "./craig-campaign-network-plan.js";
import { validateRenderedCraigCompose } from "./craig-campaign-compose-validation.js";
import { craigCredentialEnvironment } from "./craig-campaign-stack-credentials.js";
import { inspectCraigRecoveryResourceCustody } from "./craig-campaign-stack-custody.js";
import { digestCraigCampaignStackCanonical as digestCanonical } from "./craig-campaign-stack-digest.js";
import { verifyCraigFailedStackReceipt, verifyCraigFailedStackRecoveryReceipt,
  verifyCraigMutationStartReceipt, type CraigFailedStackRecoveryReceiptV1 } from
  "./craig-campaign-stack-evidence.js";
import { LocalDockerCommandExecutor, trustedDockerEnvironment, writeCreateOnlyPrivateJson } from
  "./craig-campaign-stack-local-adapters.js";
import { craigCampaignStackInputSchema } from "./craig-campaign-stack-schemas.js";
import { planCraigDisposableCampaignStack, type CraigCampaignStackCommandResult } from
  "./craig-disposable-campaign-stack.js";

export const MAX_UNRECOVERED_CRAIG_STACKS = 8;

type Executor = Pick<LocalDockerCommandExecutor, "execute">;

export async function assertCraigFailedStackRetentionAdmission(campaignRoot: string): Promise<void> {
  let entries;
  try { entries = await readdir(campaignRoot, { withFileTypes: true }); } catch (error) {
    if (errorCode(error) === "ENOENT") { return; }
    throw error;
  }
  let unrecovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Craig retention root contains a foreign or malformed campaign entry");
    }
    const control = join(campaignRoot, entry.name, "control");
    const mutationPath = join(control, "craig-stack-mutation-start.json");
    const failurePath = join(control, "craig-stack-failure.json");
    const recoveryPath = join(control, "craig-stack-recovery.json");
    const [hasMutation, hasFailure, hasRecovery] = await Promise.all([
      exists(mutationPath), exists(failurePath), exists(recoveryPath),
    ]);
    if (!hasMutation) {
      if (hasFailure || hasRecovery) {
        throw new Error("Craig retention root contains failure/recovery evidence without mutation custody");
      }
      continue;
    }
    const mutation = verifyCraigMutationStartReceipt(await readStablePrivateJson(mutationPath));
    const expectedNetworkPolicy = deriveCraigCampaignNetworkPolicy(mutation.campaignId, mutation.release,
      mutation.networkPolicy.udpDestinationPorts);
    if (mutation.campaignId !== entry.name
      || mutation.projectName !== craigProjectName(mutation.campaignId, mutation.release)
      || digestCanonical(mutation.networkPolicy) !== digestCanonical(expectedNetworkPolicy)) {
      throw new Error("Craig retention mutation custody belongs to a foreign campaign root");
    }
    if (!hasFailure && hasRecovery) {
      throw new Error("Craig retention root contains recovery evidence without a failure receipt");
    }
    if (!hasFailure || !hasRecovery) { unrecovered += 1; continue; }
    const [failure, recovery] = await Promise.all([
      readStablePrivateJson(failurePath), readStablePrivateJson(recoveryPath),
    ]);
    const verifiedFailure = verifyCraigFailedStackReceipt(failure, mutation);
    if (verifiedFailure.campaignRoot !== join(campaignRoot, entry.name)) {
      throw new Error("Craig retained failure receipt belongs to a foreign campaign root");
    }
    verifyCraigFailedStackRecoveryReceipt(recovery, failure, mutation);
  }
  if (unrecovered >= MAX_UNRECOVERED_CRAIG_STACKS) {
    throw new Error(`Craig fresh admission blocked by ${unrecovered} unrecovered failed stacks; run recovery first`);
  }
}

export async function recoverCraigFailedCampaignStack(inputValue: unknown, mutationValue: unknown,
  failureValue: unknown, commands: Executor = new LocalDockerCommandExecutor(),
  now: () => number = Date.now): Promise<CraigFailedStackRecoveryReceiptV1> {
  const input = craigCampaignStackInputSchema.parse(inputValue);
  const planned = planCraigDisposableCampaignStack(input);
  const failure = verifyCraigFailedStackReceipt(failureValue, mutationValue);
  const campaignPath = join(input.campaignRoot, input.campaignId);
  if (failure.campaignId !== input.campaignId || failure.campaignRoot !== campaignPath
    || failure.planSha256 !== planned.planSha256 || failure.projectName !== planned.projectName
    || JSON.stringify(failure.release) !== JSON.stringify(input.release)) {
    throw new Error("Craig recovery input does not match the exact retained failure plan/release/root");
  }
  const leasePresent = await verifyAndRemoveRetainedLease(campaignPath, failure.campaignLeaseSha256,
    failure.hostedPlanSha256, input.campaignId, false);
  const environment = Object.freeze({ ...trustedDockerEnvironment(),
    ...craigCredentialEnvironment(input, planned.projectName) });
  const compose = ["compose", "--project-name", planned.projectName, "--file", "-"] as const;
  const execute = (args: readonly string[]) => commands.execute({ args, environment,
    executable: "/usr/bin/docker", standardInput: input.composeCanonical, timeoutMilliseconds: 60_000,
    workingDirectory: "/" });
  const renderedResult = await execute([...compose, "config", "--format", "json"]);
  requireSuccess(renderedResult, "Craig recovery rendered Compose configuration");
  validateRenderedCraigCompose(renderedResult.stdout, input, planned.projectName,
    `${planned.projectName}_${input.database.volume}`);
  const volumeName = `${planned.projectName}_${input.database.volume}`;
  const custody = await inspectCraigRecoveryResourceCustody({ compose, execute, input,
    projectName: planned.projectName, volumeName });
  const botPresent = custody.containers.some(({ service }) => service === input.service);
  if (botPresent) {
    requireSuccess(await execute([...compose, "stop", "--timeout", "30", input.service]),
      "Craig failed-stack bot stop");
    const stopped = await execute([...compose, "ps", "--quiet", input.service]);
    requireSuccess(stopped, "Craig failed-stack stopped-bot proof");
    if (stopped.stdout.trim() !== "") { throw new Error("Craig failed-stack bot may still run"); }
  }
  await removeCraigCampaignFirewall(input, (request) => commands.execute(request), { botStopped: true });
  if (custody.containers.length > 0 || custody.networkId !== null || custody.volumePresent) {
    requireSuccess(await execute([...compose, "down", "--volumes", "--remove-orphans", "--timeout", "30"]),
      "Craig failed-stack Compose cleanup");
  }
  const containerIds = custody.containers.map(({ id }) => id).toSorted();
  await proveRecoveryResourcesAbsent(execute, { compose, ids: containerIds,
    anonymousVolumeNames: custody.anonymousVolumeNames,
    networkId: custody.networkId, networkName: input.networkPolicy.name, projectName: planned.projectName,
    volumeName });
  if (leasePresent) {
    await verifyAndRemoveRetainedLease(campaignPath, failure.campaignLeaseSha256,
      failure.hostedPlanSha256, input.campaignId, true);
  }
  const absenceProof = { absentAnonymousVolumeNames: custody.anonymousVolumeNames,
    absentContainerIds: containerIds, absentNetworkId: custody.networkId,
    absentNetworkName: input.networkPolicy.name, absentVolumeName: volumeName,
    campaignId: input.campaignId, kind: "craig-recovery-absence-proof" as const,
    planSha256: planned.planSha256, projectName: planned.projectName, release: input.release,
    schemaVersion: 1 as const };
  const content = { absenceProof, campaignId: input.campaignId, campaignLeaseRemoved: true as const,
    completedAt: new Date(now()).toISOString(), failureReceiptSha256: failure.receiptSha256,
    hostedPlanSha256: failure.hostedPlanSha256, kind: "craig-failed-stack-recovery" as const,
    mutationReceiptSha256: failure.mutationReceiptSha256, planSha256: planned.planSha256,
    projectName: planned.projectName, release: input.release, schemaVersion: 1 as const };
  return verifyCraigFailedStackRecoveryReceipt({ ...content, receiptSha256: digestCanonical(content) },
    failureValue, mutationValue);
}


async function proveRecoveryResourcesAbsent(execute: (args: readonly string[]) => Promise<CraigCampaignStackCommandResult>,
  input: Readonly<{ anonymousVolumeNames: readonly string[]; compose: readonly string[];
    ids: readonly string[]; networkId: string | null;
    networkName: string; projectName: string; volumeName: string }>): Promise<void> {
  const project = await execute([...input.compose, "ps", "--all", "--quiet"]);
  requireSuccess(project, "Craig recovery post-down Compose absence proof");
  if (project.stdout.trim() !== "") { throw new Error("Craig recovery left Compose containers"); }
  for (const id of input.ids) { if (!isAbsent(await execute(["container", "inspect", id]), "container")) {
    throw new Error("Craig recovery left an owned container"); } }
  for (const identity of [input.networkName, ...(input.networkId === null ? [] : [input.networkId])]) {
    if (!isAbsent(await execute(["network", "inspect", identity]), "network")) {
      throw new Error("Craig recovery left its exact network");
    }
  }
  if (!isAbsent(await execute(["volume", "inspect", input.volumeName]), "volume")) {
    throw new Error("Craig recovery left its exact volume");
  }
  for (const name of input.anonymousVolumeNames) {
    if (!isAbsent(await execute(["volume", "inspect", name]), "volume")) {
      throw new Error("Craig recovery left an exact image-declared anonymous volume");
    }
  }
  for (const type of ["network", "volume"] as const) {
    const labeled = await execute([type, "ls", "--quiet", "--filter",
      `label=com.docker.compose.project=${input.projectName}`]);
    requireSuccess(labeled, `Craig recovery labeled ${type} absence proof`);
    if (labeled.stdout.trim() !== "") { throw new Error(`Craig recovery left a labeled ${type}`); }
  }
}

async function verifyAndRemoveRetainedLease(campaignRoot: string, expectedSha256: string,
  expectedPlanSha256: string, campaignId: string, remove: boolean): Promise<boolean> {
  const path = join(campaignRoot, "barriers", "campaign.lease");
  let status;
  try { status = await lstat(path); } catch (error) {
    if (errorCode(error) === "ENOENT" && !remove) { return false; }
    throw error;
  }
  if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1) {
    throw new Error("Craig recovery lease custody is unsafe");
  }
  const bytes = await readFile(path, "utf8");
  const parsed = z.object({ campaignId: z.literal(campaignId), campaignRoot: z.literal(campaignRoot),
    planSha256: z.literal(expectedPlanSha256) }).strict().parse(JSON.parse(bytes));
  void parsed;
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("Craig recovery lease digest is not the retained failure lease");
  }
  if (remove) {
    await unlink(path);
    if (await exists(path)) { throw new Error("Craig recovery lease remains after unlink"); }
  }
  return true;
}

function isAbsent(result: CraigCampaignStackCommandResult, kind: "container" | "network" | "volume"): boolean {
  if (result.exitCode !== 1) { return false; }
  return (kind === "container" ? /no such (?:object|container)/iu
    : kind === "network" ? /(?:no such network|network\s+\S+\s+not found)/iu : /no such volume/iu)
    .test(result.stderr);
}

function requireSuccess(result: CraigCampaignStackCommandResult, label: string): void {
  if (result.exitCode !== 0) { throw new Error(`${label} failed closed (exit ${result.exitCode})`); }
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) { if (errorCode(error) === "ENOENT") { return false; } throw error; }
}
function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}
export function parseCraigRecoveryArguments(arguments_: readonly string[]) {
  const values = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (values.length !== 4 || values.some((value) => !value.startsWith("/"))) {
    throw new Error("Usage: recover:craig-stack <stack-input.json> <mutation.json> <failure.json> <recovery.json>");
  }
  const [inputPath, mutationPath, failurePath, recoveryPath] = values as [string, string, string, string];
  const control = dirname(inputPath);
  if (basename(inputPath) !== "craig-stack-input.json"
    || [mutationPath, failurePath, recoveryPath].some((path) => dirname(path) !== control)) {
    throw new Error("Craig recovery inputs and receipt must use one exact retained control directory");
  }
  return { failurePath, inputPath, mutationPath, recoveryPath };
}

async function main(): Promise<void> {
  const paths = parseCraigRecoveryArguments(process.argv.slice(2));
  const [input, mutation, failure] = await Promise.all([readStablePrivateJson(paths.inputPath),
    readStablePrivateJson(paths.mutationPath), readStablePrivateJson(paths.failurePath)]);
  if (await exists(paths.recoveryPath)) {
    verifyCraigFailedStackRecoveryReceipt(await readStablePrivateJson(paths.recoveryPath), failure, mutation);
    const retainedInput = craigCampaignStackInputSchema.parse(input);
    if (await exists(join(retainedInput.campaignRoot, retainedInput.campaignId, "barriers", "campaign.lease"))) {
      throw new Error("Craig recovery receipt exists while its retained campaign lease is present");
    }
    return;
  }
  const receipt = await recoverCraigFailedCampaignStack(input, mutation, failure);
  await writeCreateOnlyPrivateJson(paths.recoveryPath, receipt);
  process.stdout.write(`${JSON.stringify({ campaignId: receipt.campaignId, kind: receipt.kind,
    receiptSha256: receipt.receiptSha256, status: "recovered" })}\n`);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/recover-craig-failed-campaign-stack.js") === true) {
  void main().catch((error: unknown) => {
    process.stderr.write(`Craig failed-stack recovery failed: ${error instanceof Error ? error.message : "unknown"}\n`);
    process.exitCode = 1;
  });
}
