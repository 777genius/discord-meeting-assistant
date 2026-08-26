import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runHostedCampaign, type HostedCampaignLeaseHandle, type HostedCampaignPorts } from
  "./hosted-campaign-coordinator.js";
import { assertExecutableEnvironmentPaths, parseHostedCampaignArguments, parseHostedCampaignPlan } from
  "./hosted-campaign-run-config.js";
import { HostedCampaignArtifactStore } from "./hosted-campaign-artifact-store.js";
import { assertAdmissionAuditMatchesInvocation, assertHostedCampaignPlanMatchesDefinitionAndBindings } from
  "./hosted-campaign-admission.js";
import { hostedClockPreflightReceiptV2Schema, type HostedClockPreflightReceiptV2 } from
  "./hosted-clock-proof-v2.js";
import { writeCreateOnlyClockPreflightProof } from "./hosted-clock-preflight-proof-store.js";
import { HostedCampaignProcessAdapter, type HostedCampaignTrustedRuntimeEnvironment,
  validateHostedCampaignTrustedRuntimeEnvironment } from "./hosted-campaign-process-adapter.js";
import { createHostedCampaignProductionComposition } from "./hosted-campaign-production-composition.js";
import { createHostedCampaignProductionPolicy } from "./hosted-campaign-production-policy.js";
import { collectFiniteArtifactManifest, verifyFiniteArtifactManifest } from "./finite-artifact-manifest.js";
import { readStablePrivateJson } from "./compile-hosted-campaign-plan.js";
import { createHostedCampaignPassReceiptV2, createCampaignLeaseCleanupReceipt, createCampaignLeaseReceipt,
  createCraigStackTeardownReceipt, verifyHostedCampaignPassReceiptV2, type HostedCampaignPassReceiptV2,
  type HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-pass-receipt.js";
import { FileCraigCampaignCredentialStore, provisionCraigDisposableCampaignStack,
  teardownSuccessfulCraigCampaignStack, verifyCraigCampaignStackReceiptV2, type CraigCampaignStackInput,
  type CraigCampaignStackMutationStartV1, type CraigCampaignStackReceiptV2 } from
  "./craig-disposable-campaign-stack.js";
import { LocalDockerCommandExecutor, writeCreateOnlyPrivateJson } from
  "./craig-campaign-stack-local-adapters.js";
import { digestCanonical } from "./hosted-campaign-local-admission.js";
import { assertCraigStackInputMatchesCompiledTrustRoot } from "./hosted-campaign-release-binding.js";
import { assertHostedCampaignReceiptAbsent, writeCreateOnlyHostedCampaignReceipt } from
  "./hosted-campaign-pass-store.js";
export { assertHostedCampaignReceiptAbsent, writeCreateOnlyHostedCampaignReceipt } from
  "./hosted-campaign-pass-store.js";

export interface HostedCampaignCliDependencies {
  readonly assertAdmissionAudit: typeof assertAdmissionAuditMatchesInvocation;
  readonly assertReceiptAbsent: (path: string) => Promise<void>;
  readonly authorizeFreshAdmission: (
    invocation: HostedCampaignFreshAuthorizationInvocation,
  ) => Promise<{
    readonly assertReadyForFirstChild: () => void;
    readonly clockPreflightProof: HostedClockPreflightReceiptV2;
  }>;
  readonly createPorts: (input: ReturnType<typeof parseHostedCampaignPlan>) => Promise<HostedCampaignPorts>;
  readonly now: () => number;
  readonly readAdmission: (path: string) => Promise<unknown>;
  readonly readBindings: (path: string) => Promise<unknown>;
  readonly readDefinition: (path: string) => Promise<unknown>;
  readonly readPlan: (path: string) => Promise<unknown>;
  readonly releaseReference?: HostedCampaignReleaseReferenceV1;
  readonly provisionCraigStack?: (lease: HostedCampaignLeaseHandle, onMutationStarted: () => void) =>
    Promise<CraigCampaignStackReceiptV2>;
  readonly retainCampaignLeaseReceipt?: (receipt: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly retainCampaignLeaseCleanupReceipt?: (receipt: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly retainCraigStackReceipt?: (receipt: CraigCampaignStackReceiptV2) => Promise<void>;
  readonly rereadCraigStackReceipt?: (expected: CraigCampaignStackReceiptV2) => Promise<CraigCampaignStackReceiptV2>;
  readonly retainCraigTeardownReceipt?: (receipt: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly teardownCraigStack?: (receipt: CraigCampaignStackReceiptV2, lease: HostedCampaignLeaseHandle) => Promise<void>;
  readonly writeReceipt: (path: string, receipt: HostedCampaignPassReceiptV2) => Promise<void>;
  readonly writeClockPreflightProof: typeof writeCreateOnlyClockPreflightProof;
}

type HostedCampaignControlPaths = Readonly<{
  admissionPath: string;
  bindingsPath: string;
  definitionPath: string;
  planPath: string;
  releaseBindingPath?: string;
  craigStackInputPath?: string;
}>;

interface HostedCampaignFreshAuthorizationInvocation
{
  readonly bindings: unknown;
  readonly craigStack?: CraigCampaignStackReceiptV2;
  readonly deadlineEpochMs: number;
  readonly definition: unknown;
  readonly minimumHeadroomMs: 5_000;
  readonly plan: unknown;
  readonly signal: AbortSignal;
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
): Promise<HostedCampaignPassReceiptV2> {
  const config = parseHostedCampaignArguments(arguments_);
  await dependencies.assertReceiptAbsent(config.receiptPath);
  const suppliedPlan = parseHostedCampaignPlan(await dependencies.readPlan(config.planPath));
  const nowEpochMs = dependencies.now();
  const [admission, definition, bindings] = await Promise.all([
    dependencies.readAdmission(config.admissionPath),
    dependencies.readDefinition(config.definitionPath),
    dependencies.readBindings(config.bindingsPath),
  ]);
  const input = assertHostedCampaignPlanMatchesDefinitionAndBindings(definition, bindings, suppliedPlan);
  assertExecutableEnvironmentPaths(input.children);
  const invocation = {
    bindings, definition, maximumAgeMs: 15 * 60_000, nowEpochMs, plan: input, receipt: admission,
  };
  const verifiedAdmission = dependencies.assertAdmissionAudit(invocation);
  const clockPreflightPath = resolveClockPreflightPath(input);
  const deadlineEpochMilliseconds = nowEpochMs + config.timeoutMilliseconds;
  if (!Number.isSafeInteger(deadlineEpochMilliseconds)) {
    throw new Error("Hosted campaign deadline is unsafe");
  }
  const ports = await dependencies.createPorts(input);
  let craigStack: CraigCampaignStackReceiptV2 | undefined; let craigMutationStarted = false;
  let finalReceipt: HostedCampaignPassReceiptV2 | undefined;
  let retainedLeaseReceipt: Readonly<{ receiptSha256: string }> | undefined;
  let retainedTeardownReceipt: Readonly<{ receiptSha256: string }> | undefined;
  await runHostedCampaign(input, ports, { deadlineEpochMilliseconds, signal }, {
    authorizeAfterLease: async (lease) => {
      craigStack = await dependencies.provisionCraigStack?.(lease, () => { craigMutationStarted = true; });
      if (craigStack !== undefined && craigStack.projectName !== input.target.craigProject) {
        throw new Error("Provisioned Craig project does not match the compiled hosted campaign plan");
      }
      const fresh = await dependencies.authorizeFreshAdmission({
        bindings, deadlineEpochMs: deadlineEpochMilliseconds, definition,
        minimumHeadroomMs: 5_000, plan: input,
        ...(craigStack === undefined ? {} : { craigStack }),
        signal,
      });
      // Fresh admission includes the remote Craig official-bot identity proof.
      // Publish the create-only stack receipt only after that proof succeeds.
      if (craigStack !== undefined) { await dependencies.retainCraigStackReceipt?.(craigStack); }
      const freshClockProof = hostedClockPreflightReceiptV2Schema.parse(fresh.clockPreflightProof);
      await dependencies.writeClockPreflightProof(clockPreflightPath, freshClockProof);
      return Object.freeze({
        assertReadyForFirstChild: () => {
          if (deadlineEpochMilliseconds - dependencies.now() < 5_000) {
            throw new Error("Hosted campaign deadline lacks launch headroom");
          }
          fresh.assertReadyForFirstChild();
          if (freshClockProof.proofId === verifiedAdmission.clockPreflightProof?.proofId) {
            throw new Error("Hosted campaign launch requires a newly sampled clock preflight proof");
          }
          if (deadlineEpochMilliseconds - dependencies.now() < 5_000) {
            throw new Error("Hosted campaign deadline lacks launch headroom after final authorization fence");
          }
        },
      });
    },
    finalizeUnderLease: async (execution, lease) => {
      if (dependencies.releaseReference === undefined || craigStack === undefined) {
        throw new Error("Hosted campaign pass requires the exact release and retained Craig stack receipt");
      }
      if (craigStack.campaignLease.device !== lease.device || craigStack.campaignLease.inode !== lease.inode
        || craigStack.campaignLease.sha256 !== lease.leaseSha256
        || craigStack.hostedPlanSha256 !== lease.planSha256) {
        throw new Error("Craig stack receipt no longer matches the held campaign lease");
      }
      const artifactRoot = dirname(resolveHostedCampaignBarrierRoot(input));
      retainedLeaseReceipt = createCampaignLeaseReceipt(lease);
      await dependencies.retainCampaignLeaseReceipt?.(retainedLeaseReceipt);
      const artifacts = await collectFiniteArtifactManifest(artifactRoot);
      const candidate = createHostedCampaignPassReceiptV2(execution, {
        admissionReceiptSha256: verifiedAdmission.receiptSha256,
        artifacts,
        bindingsSha256: verifiedAdmission.bindingsSha256,
        campaignLease: { campaignRoot: lease.campaignRoot, device: lease.device, inode: lease.inode,
          leaseSha256: lease.leaseSha256, planSha256: lease.planSha256,
          receiptSha256: retainedLeaseReceipt.receiptSha256 },
        craigStack: { projectName: craigStack.projectName, receiptSha256: craigStack.receiptSha256 },
        definitionSha256: verifiedAdmission.definitionSha256,
        plan: input,
        release: dependencies.releaseReference,
        revisions: verifiedAdmission.revisions,
      });
      await dependencies.writeReceipt(config.receiptPath, candidate);
      const retained = verifyHostedCampaignPassReceiptV2(
        await dependencies.readPlan(config.receiptPath), {
          admissionReceiptSha256: verifiedAdmission.receiptSha256,
          artifacts, bindingsSha256: verifiedAdmission.bindingsSha256,
          campaignLease: candidate.campaignLease,
          craigStack: candidate.craigStack, definitionSha256: verifiedAdmission.definitionSha256,
          plan: input, release: dependencies.releaseReference, revisions: verifiedAdmission.revisions,
        },
      );
      await verifyFiniteArtifactManifest(artifactRoot, retained.artifacts);
      finalReceipt = retained;
      const teardownStack = await dependencies.rereadCraigStackReceipt?.(craigStack) ?? craigStack;
      if (teardownStack.receiptSha256 !== craigStack.receiptSha256
        || JSON.stringify(teardownStack) !== JSON.stringify(craigStack)) {
        throw new Error("Reread Craig stack receipt changed before teardown");
      }
      await dependencies.teardownCraigStack?.(teardownStack, lease);
      retainedTeardownReceipt = createCraigStackTeardownReceipt({
        completedAt: new Date(dependencies.now()).toISOString(), lease,
        leaseReceiptSha256: retainedLeaseReceipt.receiptSha256,
        passReceiptSha256: retained.receiptSha256, projectName: craigStack.projectName,
        stackReceiptSha256: craigStack.receiptSha256 });
      await dependencies.retainCraigTeardownReceipt?.(retainedTeardownReceipt);
    },
    finalizeAfterLeaseCleanup: async (cleanup, lease) => {
      if (finalReceipt === undefined || craigStack === undefined || retainedLeaseReceipt === undefined
        || retainedTeardownReceipt === undefined) {
        throw new Error("Hosted campaign lease cleanup is missing retained success receipts");
      }
      if (dependencies.retainCampaignLeaseCleanupReceipt === undefined) {
        throw new Error("Hosted campaign success requires a create-only lease cleanup receipt store");
      }
      await dependencies.retainCampaignLeaseCleanupReceipt(createCampaignLeaseCleanupReceipt({ cleanup, lease,
        leaseReceiptSha256: retainedLeaseReceipt.receiptSha256,
        passReceiptSha256: finalReceipt.receiptSha256, projectName: craigStack.projectName,
        stackReceiptSha256: craigStack.receiptSha256,
        teardownReceiptSha256: retainedTeardownReceipt.receiptSha256 }));
    },
    retainLeaseOnFailure: () => craigMutationStarted || craigStack !== undefined,
  });
  if (finalReceipt === undefined) { throw new Error("Hosted campaign pass finalization did not commit"); }
  return finalReceipt;
}

function resolveClockPreflightPath(plan: ReturnType<typeof parseHostedCampaignPlan>): string {
  const paths = new Set(plan.children.flatMap(({ environment }) => {
    const path = environment.DISCORD_E2E_SLA_CLOCK_PREFLIGHT_INPUT;
    return path === undefined ? [] : [path];
  }));
  if (paths.size !== 1) {
    throw new Error("Hosted campaign children require one exact clock preflight proof path");
  }
  return [...paths][0]!;
}

export async function readPrivateHostedCampaignPlan(path: string): Promise<unknown> {
  return readStablePrivateJson(path);
}

export function resolveHostedCampaignBarrierRoot(
  plan: ReturnType<typeof parseHostedCampaignPlan>,
): string {
  const outputPaths = plan.children.flatMap(({ produces }) => produces.map(({ outputPath }) => outputPath));
  if (outputPaths.length === 0) {
    throw new Error("Hosted campaign plan has no action artifact paths");
  }
  const barrierRoot = dirname(outputPaths[0]!);
  const campaignIds = new Set(plan.runs.map(({ campaignId }) => campaignId));
  if (campaignIds.size !== 1 || basename(dirname(barrierRoot)) !== plan.runs[0]?.campaignId
    || basename(barrierRoot) !== "barriers" || outputPaths.some((path) => dirname(path) !== barrierRoot)) {
    throw new Error("Hosted campaign action artifacts must share one exact barriers root");
  }
  return barrierRoot;
}

export async function createProductionHostedCampaignPorts(
  plan: ReturnType<typeof parseHostedCampaignPlan>,
  controlPaths: HostedCampaignControlPaths,
  trustedRuntimeEnvironment: HostedCampaignTrustedRuntimeEnvironment,
): Promise<HostedCampaignPorts> {
  const campaignId = plan.runs[0]!.campaignId;
  const artifactRoot = resolveHostedCampaignBarrierRoot(plan);
  const store = new HostedCampaignArtifactStore(artifactRoot, campaignId, digestCanonical(plan));
  await store.initializeFreshCampaignLayout([
    controlPaths.admissionPath,
    controlPaths.bindingsPath,
    controlPaths.definitionPath,
    controlPaths.planPath,
    ...(controlPaths.releaseBindingPath === undefined ? [] : [controlPaths.releaseBindingPath]),
    ...(controlPaths.craigStackInputPath === undefined ? [] : [controlPaths.craigStackInputPath]),
  ]);
  return new HostedCampaignProcessAdapter({
    admissionPath: controlPaths.admissionPath,
    artifactStore: store,
    distRoot: dirname(fileURLToPath(import.meta.url)),
    planPath: controlPaths.planPath,
    craigProject: plan.target.craigProject,
    ...(controlPaths.releaseBindingPath === undefined
      ? {}
      : { releaseBindingPath: controlPaths.releaseBindingPath }),
    trustedRuntimeEnvironment,
  });
}

export function loadHostedCampaignTrustedRuntimeEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): HostedCampaignTrustedRuntimeEnvironment {
  const optional = (name: "LANG" | "LC_ALL" | "SSH_AUTH_SOCK"): Record<string, string> => {
    const value = environment[name];
    return value === undefined ? {} : { [name]: value };
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
  const forwardSignal = (signal: "SIGINT" | "SIGTERM"): void => {
    controller.abort(new HostedCampaignInterruptedError(signal));
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  try {
    await runProductionHostedCampaignCli(process.argv.slice(2), process.env, controller.signal);
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
}

export async function runProductionHostedCampaignCli(
  arguments_: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal,
): Promise<HostedCampaignPassReceiptV2> {
  const config = parseHostedCampaignArguments(arguments_);
  await assertHostedCampaignReceiptAbsent(config.receiptPath);
  const releaseBinding = config.releaseBindingPath === undefined
    ? undefined
    : await readStablePrivateJson(config.releaseBindingPath);
  const production = createHostedCampaignProductionComposition(
    createHostedCampaignProductionPolicy(releaseBinding),
  );
  const releaseReference = production.assertReadyForRun();
  const craigStackInputPath = environment.DISCORD_E2E_CRAIG_STACK_INPUT;
  if (craigStackInputPath === undefined || !craigStackInputPath.startsWith("/")) {
    throw new Error("Hosted campaign requires DISCORD_E2E_CRAIG_STACK_INPUT as an absolute private JSON path");
  }
  const craigStackInput = await readStablePrivateJson(craigStackInputPath) as CraigCampaignStackInput;
  if (craigStackInputPath !== join(dirname(craigStackInput.credentialFile), "craig-stack-input.json")) {
    throw new Error("Craig stack input must be the canonical retained campaign control file");
  }
  if (craigStackInput.serviceIdentity.protocol.kind !== "craig-application") {
    throw new Error("Production hosted campaign requires the real Craig application protocol contract");
  }
  assertCraigStackInputMatchesCompiledTrustRoot(craigStackInput, releaseReference);
  const commandExecutor = new LocalDockerCommandExecutor();
  return runHostedCampaignCli(arguments_, {
    assertReceiptAbsent: assertHostedCampaignReceiptAbsent,
    assertAdmissionAudit: assertAdmissionAuditMatchesInvocation,
    authorizeFreshAdmission: (request) => production.authorizeFreshAdmission(request),
    createPorts: async (plan) => createProductionHostedCampaignPorts(
      plan,
      { ...config, craigStackInputPath },
      loadHostedCampaignTrustedRuntimeEnvironment(environment),
    ),
    now: Date.now,
    readAdmission: readPrivateHostedCampaignPlan,
    readBindings: readPrivateHostedCampaignPlan,
    readDefinition: readPrivateHostedCampaignPlan,
    readPlan: readPrivateHostedCampaignPlan,
    releaseReference,
    provisionCraigStack: (lease, onMutationStarted) => provisionCraigDisposableCampaignStack(craigStackInput, {
      commands: commandExecutor,
      credentials: new FileCraigCampaignCredentialStore(),
      mutationJournal: {
        markStarted: async (mutation: CraigCampaignStackMutationStartV1) => {
          const content = { ...mutation, startedAt: new Date(Date.now()).toISOString() };
          await writeCreateOnlyPrivateJson(
            join(dirname(craigStackInput.credentialFile), "craig-stack-mutation-start.json"),
            { ...content, receiptSha256: digestCanonical(content) },
          );
          onMutationStarted();
        },
      },
    }, lease),
    retainCampaignLeaseReceipt: (receipt) => writeCreateOnlyPrivateJson(
      join(dirname(craigStackInput.credentialFile), "campaign-lease-receipt.json"), receipt,
    ),
    retainCampaignLeaseCleanupReceipt: (receipt) => writeCreateOnlyPrivateJson(
      join(dirname(craigStackInput.credentialFile), "campaign-lease-cleanup.json"), receipt,
    ),
    retainCraigStackReceipt: (receipt) => writeCreateOnlyPrivateJson(
      join(dirname(receipt.credentialFile), "craig-stack-receipt.json"), receipt,
    ),
    rereadCraigStackReceipt: async (expected) => verifyCraigCampaignStackReceiptV2(
      await readStablePrivateJson(join(dirname(craigStackInput.credentialFile), "craig-stack-receipt.json")),
      { campaignId: expected.campaignId, campaignRoot: expected.campaignRoot,
        hostedPlanSha256: expected.hostedPlanSha256, maximumAgeMs: 24 * 60 * 60_000,
        nowEpochMs: Date.now(), projectName: expected.projectName, release: expected.release },
    ),
    retainCraigTeardownReceipt: (receipt) => writeCreateOnlyPrivateJson(
      join(dirname(craigStackInput.credentialFile), "craig-stack-teardown.json"), receipt,
    ),
    teardownCraigStack: (receipt, lease) => teardownSuccessfulCraigCampaignStack(
      receipt, craigStackInput, lease, { commands: commandExecutor },
    ),
    writeReceipt: writeCreateOnlyHostedCampaignReceipt,
    writeClockPreflightProof: writeCreateOnlyClockPreflightProof,
  }, signal);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/run-hosted-campaign.js") === true) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown hosted campaign failure";
    process.stderr.write(`Hosted campaign failed: ${message}\n`);
    process.exitCode = error instanceof HostedCampaignInterruptedError ? error.exitCode : 1;
  });
}
