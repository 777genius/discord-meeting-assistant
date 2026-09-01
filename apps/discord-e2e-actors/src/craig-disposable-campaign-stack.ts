import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";
import { hostedCampaignReleaseReferenceV1Schema, type HostedCampaignReleaseReferenceV1 } from
  "./hosted-campaign-release-reference.js";
import { trustedDockerEnvironment } from "./craig-campaign-stack-local-adapters.js";
import { validateCraigRuntime } from "./craig-campaign-runtime-validation.js";
import { digestCraigCampaignStackCanonical as digestCanonical } from "./craig-campaign-stack-digest.js";
import { inspectCraigComposeServiceConfigHashes, validateRenderedCraigCompose } from
  "./craig-campaign-compose-validation.js";
import { validateSourceCraigCompose } from "./craig-campaign-source-compose-validation.js";
import type { HostedCampaignLeaseHandle } from "./hosted-campaign-coordinator.js";
import {
  assertCanonicalUnsymlinkedCampaignPath,
  inspectCanonicalCampaignLease,
  revalidateCraigMutationInputs,
  verifyStableFileIdentity,
  type PinnedFileIdentityV1,
} from "./craig-campaign-stack-custody.js";
import {
  assertCraigResourcesAbsent,
  proveCraigResourcesAbsentAfterDown,
  verifyCraigDatabase,
  verifyCraigMigration,
  verifyCraigPinnedImages,
  type CraigCampaignStackAbsenceProofV1,
} from "./craig-campaign-stack-runtime-proof.js";
import { installCraigCampaignFirewall, proveInstalledCraigCampaignFirewall,
  removeCraigCampaignFirewall } from "./craig-campaign-network-lifecycle.js";
import { craigCredentialContents as credentialContents, craigCredentialEnvironment as credentialEnvironment,
  craigMigrationRunArguments as migrationRunArguments } from "./craig-campaign-stack-credentials.js";
import { craigAbsolutePathSchema as absolutePath, craigCampaignStackInputSchema as inputSchema,
  craigComposeCoordinateSchema as composeCoordinate, craigContainerIdSchema as containerId,
  craigIdentifierSchema as identifier, craigImageIdSchema as imageId,
  craigRepositoryDigestSchema as repositoryDigest, craigSha256Schema as sha256,
  craigSourceRevisionSchema as sourceRevision } from
  "./craig-campaign-stack-schemas.js";
import { craigCampaignComposeProjectSchema, craigCampaignNetworkPolicySchema as networkPolicySchema,
  craigProjectName, deriveCraigCampaignNetworkPolicy } from "./craig-campaign-network-plan.js";
export { FileCraigCampaignCredentialStore } from "./craig-campaign-stack-local-adapters.js";
export { craigProjectName, deriveCraigCampaignNetworkPolicy } from
  "./craig-campaign-network-plan.js";
export type { CraigCampaignStackInput } from "./craig-campaign-stack-schemas.js";
export interface CraigCampaignStackCommandRequest { readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>; readonly executable: string; readonly standardInput?: string;
  readonly timeoutMilliseconds: number; readonly workingDirectory: string }
export interface CraigCampaignStackCommandResult { readonly exitCode: number; readonly stderr: string; readonly stdout: string }
export interface CraigCampaignStackPorts {
  readonly commands: { execute(request: CraigCampaignStackCommandRequest): Promise<CraigCampaignStackCommandResult> };
  readonly credentials: { reserveCreateOnly(input: Readonly<{ campaignId: string; contents: string; path: string;
    projectName: string; release: HostedCampaignReleaseReferenceV1 }>): Promise<CraigCredentialFileIdentityV1> };
  readonly mutationJournal: { markStarted(input: CraigCampaignStackMutationStartV1): Promise<void> };
  readonly now?: () => number;
}
export interface CraigCampaignStackMutationStartV1 {
  readonly campaignId: string; readonly campaignLeaseSha256: string; readonly composeCanonicalSha256: string;
  readonly composeServiceConfigHashes: Readonly<Record<string, string>>; readonly hostedPlanSha256: string;
  readonly kind: "craig-stack-mutation-start"; readonly planSha256: string; readonly networkPolicy: z.infer<typeof networkPolicySchema>;
  readonly projectName: string; readonly release: HostedCampaignReleaseReferenceV1; readonly schemaVersion: 1;
}
export interface CraigCredentialFileIdentityV1 { readonly device: number; readonly gid: number; readonly inode: number;
  readonly linkCount: 1; readonly mode: "0600"; readonly sha256: string; readonly uid: number }
export interface PlannedCraigCampaignStackV1 {
  readonly campaignId: string; readonly campaignRoot: string; readonly composeCanonicalSha256: string;
  readonly composeFile: string; readonly credentialFile: string;
  readonly credentialSecret: Readonly<{ authority: "compiled-release-sha256"; sha256: string }>;
  readonly hostedPlanSha256?: string; readonly kind: "planned-craig-campaign-stack"; readonly planSha256: string;
  readonly networkPolicy: z.infer<typeof networkPolicySchema>;
  readonly projectName: string; readonly release: HostedCampaignReleaseReferenceV1;
  readonly readinessTimeoutSeconds: number;
  readonly schemaVersion: 1;
}
export interface CraigCampaignStackReceiptV2 {
  readonly campaignId: string; readonly campaignLease: Readonly<{ device: number; inode: number; sha256: string }>;
  readonly campaignRoot: string; readonly composeConfigSha256: string; readonly composeFile: string;
  readonly composeFileIdentity: PinnedFileIdentityV1; readonly containerId: string; readonly createdAt: string;
  readonly credentialFile: string; readonly credentialFileIdentity: CraigCredentialFileIdentityV1;
  readonly databaseContainerId: string; readonly database: Readonly<{ migrationTable: string; name: string;
    schema: string; user: string }>; readonly databaseImage: Readonly<{ imageId: string; repositoryDigest: string }>;
  readonly databaseVolume: string; readonly imageId: string; readonly kind: "craig-disposable-campaign-stack";
  readonly planSha256: string; readonly hostedPlanSha256: string; readonly projectName: string; readonly receiptSha256: string;
  readonly release: HostedCampaignReleaseReferenceV1; readonly repositoryDigest: string;
  readonly migrationImage: Readonly<{ imageId: string; repositoryDigest: string }>; readonly migrationSetSha256: string;
  readonly networkPolicy: Readonly<z.infer<typeof networkPolicySchema> & {
    containerId: string; databaseContainerId: string; networkId: string; semanticPolicySha256: string }>;
  readonly protocol: Readonly<{ kind: "craig-application" | "test-port-substitute";
    name: string; responseSha256: string; version: string }>;
  readonly schemaVersion: 2;
  readonly serviceHealth: "healthy";
  readonly sourceRevision: string;
}
export function planCraigDisposableCampaignStack(candidate: unknown): PlannedCraigCampaignStackV1 {
  const input = inputSchema.parse(candidate);
  if (createHash("sha256").update(input.composeCanonical).digest("hex") !== input.composeCanonicalSha256) {
    throw new Error("Craig canonical Compose bytes do not match their admitted digest");
  }
  validateSourceCraigCompose(input.composeCanonical, input);
  const expectedNetworkPolicy = deriveCraigCampaignNetworkPolicy(
    input.campaignId, input.release, input.networkPolicy.udpDestinationPorts,
  );
  if (digestCanonical(input.networkPolicy) !== digestCanonical(expectedNetworkPolicy)) {
    throw new Error("Craig network identity is not the deterministic campaign/release network plan");
  }
  const campaignPath = resolve(input.campaignRoot, input.campaignId);
  if (input.credentialFile !== join(campaignPath, "control", "craig.env")) {
    throw new Error("Craig credential reservation must belong to the canonical campaign control root");
  }
  const content = {
    campaignId: input.campaignId, campaignRoot: input.campaignRoot,
    composeCanonicalSha256: input.composeCanonicalSha256,
    composeFile: input.composeFile,
    credentialFile: input.credentialFile,
    credentialSecret: { authority: "compiled-release-sha256" as const,
      sha256: createHash("sha256").update(input.database.password).digest("hex") },
    database: { imageIdentity: input.database.imageIdentity, migrations: input.database.migrations,
      migrationTable: input.database.migrationTable, name: input.database.name,
      schema: input.database.schema, service: input.database.service, user: input.database.user,
      volume: input.database.volume },
    kind: "planned-craig-campaign-stack" as const,
    migrationImageIdentity: input.migrationImageIdentity,
    migrationService: input.migrationService,
    networkPolicy: input.networkPolicy,
    projectName: craigProjectName(input.campaignId, input.release),
    readinessTimeoutSeconds: input.readinessTimeoutSeconds,
    release: input.release,
    schemaVersion: 1 as const,
    service: input.service,
    serviceIdentity: input.serviceIdentity,
  };
  return Object.freeze({ ...content, planSha256: digestCanonical(content) });
}
export async function provisionCraigDisposableCampaignStack(
  candidate: unknown,
  ports: CraigCampaignStackPorts,
  lease: HostedCampaignLeaseHandle,
  _untrustedInheritedEnvironment?: NodeJS.ProcessEnv,
): Promise<CraigCampaignStackReceiptV2> {
  const input = inputSchema.parse(candidate);
  const plan = planCraigDisposableCampaignStack(input);
  if (createHash("sha256").update(input.composeCanonical).digest("hex") !== input.composeCanonicalSha256) {
    throw new Error("Craig canonical Compose bytes do not match their admitted digest");
  }
  validateSourceCraigCompose(input.composeCanonical, input);
  await assertCanonicalUnsymlinkedCampaignPath(input.campaignRoot, input.campaignId);
  const campaignLease = await inspectCanonicalCampaignLease(input.campaignRoot, input.campaignId, lease);
  const databaseVolume = `${plan.projectName}_${input.database.volume}`;
  const environment = Object.freeze({ ...trustedDockerEnvironment(), ...credentialEnvironment(input, plan.projectName) });
  const composeFileIdentity = Object.freeze({ device: 0, inode: 0, sha256: input.composeCanonicalSha256 });
  const credentialCanonical = credentialContents(input, plan.projectName);
  const compose = [
    "compose", "--project-name", plan.projectName,
    "--file", "-",
  ] as const;
  const execute = (args: readonly string[]) => ports.commands.execute({
    args, environment, executable: "/usr/bin/docker", standardInput: input.composeCanonical,
    timeoutMilliseconds: (input.readinessTimeoutSeconds + 60) * 1_000,
    workingDirectory: "/",
  });
  const revalidate = () => revalidateCraigMutationInputs({
    compose, databaseVolume, execute,
    expectedConfigSha256: composeConfigSha256,
    expectedServiceConfigHashes: composeServiceConfigHashes,
    input, lease, projectName: plan.projectName,
    verifyPinnedImages: () => verifyCraigPinnedImages(execute, input),
  });

  const rendered = await execute([...compose, "config", "--format", "json"]);
  requireSuccess(rendered, "Craig rendered Compose configuration");
  const composeConfig = validateRenderedCraigCompose(rendered.stdout, input, plan.projectName, databaseVolume);
  const composeConfigSha256 = digestCanonical(composeConfig);
  const composeServiceConfigHashes = await inspectCraigComposeServiceConfigHashes(execute, compose, input);
  await verifyCraigPinnedImages(execute, input);
  await ports.mutationJournal.markStarted(Object.freeze({ campaignId: input.campaignId,
    campaignLeaseSha256: campaignLease.sha256, composeCanonicalSha256: input.composeCanonicalSha256,
    composeServiceConfigHashes, hostedPlanSha256: lease.planSha256,
    kind: "craig-stack-mutation-start", planSha256: plan.planSha256,
    networkPolicy: input.networkPolicy, projectName: plan.projectName, release: input.release, schemaVersion: 1 }));
  const credentialFileIdentity = await ports.credentials.reserveCreateOnly({
    campaignId: input.campaignId,
    contents: credentialCanonical,
    path: input.credentialFile,
    projectName: plan.projectName,
    release: input.release,
  });
  await assertCraigResourcesAbsent(execute, compose, composeConfig, plan.projectName);
  await revalidate();

  const wait = ["--wait", "--wait-timeout", String(input.readinessTimeoutSeconds)] as const;
  requireSuccess(await execute([...compose, "up", "--detach", "--no-deps", ...wait, input.database.service]),
    "Craig campaign database readiness gate");
  await verifyCraigDatabase(execute, compose, input);
  await revalidate();
  requireSuccess(await execute([...compose, "run", "--no-deps", "--rm", ...migrationRunArguments(input)]),
    "Craig campaign migration");
  await verifyCraigMigration(execute, compose, input);
  await revalidate();
  const installedNetworkPolicy = await installCraigCampaignFirewall(input, plan.projectName,
    compose, (request) => ports.commands.execute(request), execute);
  await revalidate();
  requireSuccess(await execute([...compose, "up", "--detach", "--no-deps", ...wait, input.service]),
    "Craig campaign service readiness gate");

  const service = await execute([...compose, "ps", "--quiet", input.service]);
  requireSuccess(service, "Craig campaign service identity");
  const id = containerId.parse(service.stdout.trim());
  const inspection = await execute(["inspect", id]);
  requireSuccess(inspection, "Craig campaign runtime inspection");
  validateCraigRuntime(inspection.stdout, input, plan.projectName, id);
  const networkPolicy = await proveInstalledCraigCampaignFirewall({ compose, executeDocker: execute,
    databaseContainerId: installedNetworkPolicy.databaseContainerId,
    executeRequest: (request) => ports.commands.execute(request),
    expectedNetworkId: installedNetworkPolicy.networkId, input, projectName: plan.projectName });
  const protocol = await execute([...compose, "exec", "-T", input.service, ...input.serviceIdentity.protocol.command]);
  requireSuccess(protocol, "Craig application protocol readiness");
  const responseSha256 = createHash("sha256").update(protocol.stdout).digest("hex");
  if (responseSha256 !== input.serviceIdentity.protocol.expectedResponseSha256) {
    throw new Error("Craig application protocol response identity is invalid");
  }

  const content = {
    campaignId: input.campaignId,
    campaignLease,
    campaignRoot: lease.campaignRoot,
    composeConfigSha256,
    composeFile: input.composeFile,
    composeFileIdentity,
    containerId: id,
    createdAt: new Date((ports.now ?? Date.now)()).toISOString(),
    credentialFile: input.credentialFile,
    credentialFileIdentity,
    databaseContainerId: networkPolicy.databaseContainerId,
    database: { migrationTable: input.database.migrationTable, name: input.database.name,
      schema: input.database.schema, user: input.database.user },
    databaseImage: input.database.imageIdentity,
    databaseVolume,
    imageId: input.serviceIdentity.imageId,
    kind: "craig-disposable-campaign-stack" as const,
    planSha256: plan.planSha256,
    hostedPlanSha256: lease.planSha256,
    projectName: plan.projectName,
    release: input.release,
    migrationImage: input.migrationImageIdentity,
    migrationSetSha256: digestCanonical(input.database.migrations),
    networkPolicy: { ...input.networkPolicy, containerId: networkPolicy.containerId,
      databaseContainerId: networkPolicy.databaseContainerId, networkId: networkPolicy.networkId,
      semanticPolicySha256: networkPolicy.semanticPolicySha256 },
    protocol: { kind: input.serviceIdentity.protocol.kind,
      name: input.serviceIdentity.protocol.name, responseSha256,
      version: input.serviceIdentity.protocol.version },
    repositoryDigest: input.serviceIdentity.repositoryDigest,
    schemaVersion: 2 as const,
    serviceHealth: "healthy" as const,
    sourceRevision: input.serviceIdentity.sourceRevision,
  };
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

export async function teardownSuccessfulCraigCampaignStack(
  receiptValue: unknown,
  candidate: unknown,
  lease: HostedCampaignLeaseHandle,
  ports: Pick<CraigCampaignStackPorts, "commands">,
): Promise<CraigCampaignStackAbsenceProofV1> {
  const receipt = verifyCraigCampaignStackReceiptV2(receiptValue);
  const input = inputSchema.parse(candidate);
  validateSourceCraigCompose(input.composeCanonical, input);
  const plan = planCraigDisposableCampaignStack(input);
  const { containerId: _containerId, databaseContainerId: _databaseContainerId, networkId: _networkId,
    semanticPolicySha256: _semanticPolicySha256, ...retainedNetworkPolicy } = receipt.networkPolicy;
  if (receipt.planSha256 !== plan.planSha256 || receipt.projectName !== plan.projectName
    || digestCanonical(retainedNetworkPolicy) !== digestCanonical(input.networkPolicy)) {
    throw new Error("Craig teardown input does not match the retained stack/network plan");
  }
  const compose = ["compose", "--project-name", receipt.projectName,
    "--file", "-"] as const;
  const credentialCanonical = credentialContents(input, receipt.projectName);
  if (createHash("sha256").update(input.composeCanonical).digest("hex") !== receipt.composeFileIdentity.sha256
    || createHash("sha256").update(credentialCanonical).digest("hex") !== receipt.credentialFileIdentity.sha256) {
    throw new Error("Craig teardown immutable Compose/env bytes do not match the retained receipt");
  }
  const execute = (args: readonly string[]) => ports.commands.execute({
    args, environment: Object.freeze({ ...trustedDockerEnvironment(),
      ...credentialEnvironment(input, receipt.projectName) }), executable: "/usr/bin/docker",
    standardInput: input.composeCanonical,
    timeoutMilliseconds: 60_000, workingDirectory: "/",
  });
  await revalidateCraigMutationInputs({ compose, databaseVolume: receipt.databaseVolume, execute,
    expectedConfigSha256: receipt.composeConfigSha256,
    input, lease, projectName: receipt.projectName,
    verifyPinnedImages: () => verifyCraigPinnedImages(execute, input) });
  const stop = await execute([...compose, "stop", "--timeout", "30", input.service]);
  requireSuccess(stop, "Craig service stop before firewall removal");
  const stopped = await execute([...compose, "ps", "--quiet", input.service]);
  requireSuccess(stopped, "Craig stopped service verification");
  if (stopped.stdout.trim() !== "") { throw new Error("Craig service remained runnable before firewall removal"); }
  await removeCraigCampaignFirewall(input, (request) => ports.commands.execute(request), { botStopped: true });
  const result = await execute([...compose, "down", "--volumes", "--remove-orphans", "--timeout", "30"]);
  requireSuccess(result, "Craig successful campaign teardown");
  return proveCraigResourcesAbsentAfterDown(execute, compose, {
    campaignId: receipt.campaignId, containerIds: [receipt.containerId, receipt.databaseContainerId],
    networkId: receipt.networkPolicy.networkId, networkName: receipt.networkPolicy.name,
    planSha256: receipt.planSha256, projectName: receipt.projectName, release: receipt.release,
    volumeName: receipt.databaseVolume,
  });
}

export const craigCampaignStackReceiptV2Schema = z.object({
  campaignId: identifier, campaignLease: z.object({ device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(), sha256 }).strict(),
  campaignRoot: absolutePath,
  composeConfigSha256: sha256, composeFile: absolutePath, containerId,
  composeFileIdentity: z.object({ device: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(), sha256 }).strict(),
  createdAt: z.iso.datetime(), credentialFile: absolutePath,
  credentialFileIdentity: z.object({ device: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
    inode: z.number().int().nonnegative(), linkCount: z.literal(1), mode: z.literal("0600"), sha256,
    uid: z.number().int().nonnegative() }).strict(),
  database: z.object({ migrationTable: composeCoordinate, name: composeCoordinate,
    schema: composeCoordinate, user: composeCoordinate }).strict(),
  databaseContainerId: containerId,
  databaseImage: z.object({ imageId, repositoryDigest }).strict(),
  databaseVolume: composeCoordinate, imageId, kind: z.literal("craig-disposable-campaign-stack"),
  hostedPlanSha256: sha256, migrationImage: z.object({ imageId, repositoryDigest }).strict(),
  migrationSetSha256: sha256, planSha256: sha256, projectName: craigCampaignComposeProjectSchema,
  networkPolicy: networkPolicySchema.extend({ containerId, databaseContainerId: containerId,
    networkId: sha256, semanticPolicySha256: sha256 }).strict(),
  protocol: z.object({ kind: z.enum(["craig-application", "test-port-substitute"]),
    name: identifier, responseSha256: sha256, version: identifier }).strict(), receiptSha256: sha256,
  release: hostedCampaignReleaseReferenceV1Schema, repositoryDigest, schemaVersion: z.literal(2),
  serviceHealth: z.literal("healthy"), sourceRevision,
}).strict();

export function verifyCraigCampaignStackReceiptV2(
  value: unknown,
  expectation?: Readonly<{
    campaignId: string; campaignRoot: string; hostedPlanSha256: string;
    maximumAgeMs: number; nowEpochMs: number; projectName: string;
    release: HostedCampaignReleaseReferenceV1;
  }>,
): CraigCampaignStackReceiptV2 {
  const receipt = craigCampaignStackReceiptV2Schema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Craig stack receipt digest is invalid");
  }
  if (receipt.networkPolicy.containerId !== receipt.containerId
    || receipt.networkPolicy.databaseContainerId !== receipt.databaseContainerId) {
    throw new Error("Craig stack receipt network proof selected a different container");
  }
  if (expectation !== undefined) {
    const createdAt = Date.parse(receipt.createdAt);
    if (!Number.isSafeInteger(expectation.nowEpochMs) || !Number.isSafeInteger(expectation.maximumAgeMs)
      || expectation.maximumAgeMs < 1 || !Number.isSafeInteger(createdAt)
      || createdAt > expectation.nowEpochMs || expectation.nowEpochMs - createdAt > expectation.maximumAgeMs
      || receipt.campaignId !== expectation.campaignId || receipt.campaignRoot !== expectation.campaignRoot
      || receipt.hostedPlanSha256 !== expectation.hostedPlanSha256
      || receipt.projectName !== expectation.projectName
      || JSON.stringify(receipt.release) !== JSON.stringify(expectation.release)) {
      throw new Error("Craig stack receipt is stale, replayed, or mismatched");
    }
  }
  return Object.freeze(receipt);
}

export async function verifyCraigCampaignStackInputBindings(
  receiptValue: unknown,
  inputValue: unknown,
): Promise<CraigCampaignStackReceiptV2> {
  const receipt = verifyCraigCampaignStackReceiptV2(receiptValue);
  const input = inputSchema.parse(inputValue);
  const plan = planCraigDisposableCampaignStack(input);
  if (receipt.planSha256 !== plan.planSha256 || receipt.campaignId !== input.campaignId
    || receipt.projectName !== plan.projectName || receipt.composeFile !== input.composeFile
    || receipt.credentialFile !== input.credentialFile
    || JSON.stringify(receipt.databaseImage) !== JSON.stringify(input.database.imageIdentity)
    || JSON.stringify(receipt.migrationImage) !== JSON.stringify(input.migrationImageIdentity)
    || receipt.migrationSetSha256 !== digestCanonical(input.database.migrations)
    || digestCanonical({ ...receipt.networkPolicy, containerId: undefined, databaseContainerId: undefined,
      networkId: undefined, semanticPolicySha256: undefined })
      !== digestCanonical(input.networkPolicy)
    || receipt.imageId !== input.serviceIdentity.imageId
    || receipt.repositoryDigest !== input.serviceIdentity.repositoryDigest
    || receipt.sourceRevision !== input.serviceIdentity.sourceRevision
    || receipt.protocol.kind !== input.serviceIdentity.protocol.kind
    || receipt.protocol.name !== input.serviceIdentity.protocol.name
    || receipt.protocol.version !== input.serviceIdentity.protocol.version
    || receipt.protocol.responseSha256 !== input.serviceIdentity.protocol.expectedResponseSha256) {
    throw new Error("Craig stack receipt does not match its complete retained input identity");
  }
  if (createHash("sha256").update(input.composeCanonical).digest("hex") !== receipt.composeFileIdentity.sha256) {
    throw new Error("Retained canonical Compose bytes do not match the stack receipt");
  }
  await verifyStableFileIdentity(input.credentialFile, receipt.credentialFileIdentity);
  return receipt;
}

function requireSuccess(result: CraigCampaignStackCommandResult, label: string): void {
  if (result.exitCode !== 0) { throw new Error(`${label} failed closed (exit ${result.exitCode})`); }
}
