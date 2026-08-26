import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { assertUnsymlinkedParents } from "./craig-campaign-stack-local-adapters.js";
import { validateRenderedCraigCompose } from "./craig-campaign-compose-validation.js";
import { validateSourceCraigCompose } from "./craig-campaign-source-compose-validation.js";
import { digestCraigCampaignStackCanonical as digestCanonical } from "./craig-campaign-stack-digest.js";
import { craigSha256Schema } from "./craig-campaign-stack-schemas.js";
import type {
  CraigCampaignStackCommandResult,
  CraigCampaignStackInput,
} from "./craig-disposable-campaign-stack.js";
import type { HostedCampaignLeaseHandle } from "./hosted-campaign-coordinator.js";

export type PinnedFileIdentityV1 = Readonly<{ device: number; inode: number; sha256: string }>;
type Execute = (args: readonly string[]) => Promise<CraigCampaignStackCommandResult>;
type RetainedContainer = Readonly<{ anonymousVolumeNames: readonly string[]; id: string; service: string }>;
const dockerLabelsSchema = z.record(z.string(), z.string());
const containerInspectionSchema = z.array(z.object({
  Config: z.object({ Env: z.array(z.string()), Image: z.string(), Labels: dockerLabelsSchema }).loose(),
  Id: craigSha256Schema, Image: z.string(), Name: z.string(),
  Mounts: z.array(z.object({ Destination: z.string(), Driver: z.string(), Name: z.string(),
    Type: z.string() }).loose()),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({
    IPAddress: z.string(), NetworkID: z.string(),
  }).loose()) }).loose(),
}).loose()).length(1);
const networkInspectionSchema = z.array(z.object({
  Driver: z.string(), Id: craigSha256Schema, Internal: z.boolean(),
  IPAM: z.object({ Config: z.array(z.object({ Subnet: z.string().optional() }).loose()) }).loose(),
  Labels: dockerLabelsSchema, Name: z.string(), Options: z.record(z.string(), z.string()).nullable(),
}).loose()).length(1);
const volumeInspectionSchema = z.array(z.object({
  Driver: z.string(), Labels: dockerLabelsSchema.nullable(), Name: z.string(),
}).loose()).length(1);
const imageInspectionSchema = z.array(z.object({
  Config: z.object({ Volumes: z.record(z.string(), z.unknown()).nullable().optional() }).loose(),
  Id: z.string(), RepoDigests: z.array(z.string()),
}).loose()).length(1);

export interface CraigRecoveryResourceCustody {
  readonly anonymousVolumeNames: readonly string[];
  readonly containers: readonly RetainedContainer[];
  readonly networkId: string | null;
  readonly volumePresent: boolean;
}

export async function inspectCraigRecoveryResourceCustody(value: Readonly<{
  compose: readonly string[]; execute: Execute; input: CraigCampaignStackInput;
  projectName: string; volumeName: string;
}>): Promise<CraigRecoveryResourceCustody> {
  const imageVolumes = await inspectRecoveryImages(value.execute, value.input);
  const networkId = await inspectOwnedNetwork(value.execute, value.input, value.projectName);
  const containers = await inspectOwnedContainers({ ...value, imageVolumes, networkId });
  const volumePresent = await inspectOwnedVolume(value.execute, value.volumeName, value.projectName,
    value.input.database.volume);
  const anonymousNames = [...new Set(containers.flatMap(({ anonymousVolumeNames }) =>
    anonymousVolumeNames))].toSorted();
  if (anonymousNames.length > 3) {
    throw new Error("Craig recovery anonymous volume set exceeds the closed stack bound");
  }
  for (const name of anonymousNames) { await inspectOwnedAnonymousVolume(value.execute, name); }
  await assertExactProjectResourceSets({ containers, execute: value.execute, networkId,
    projectName: value.projectName, volumeName: value.volumeName, volumePresent });
  return Object.freeze({ anonymousVolumeNames: anonymousNames, containers, networkId, volumePresent });
}

async function inspectOwnedContainers(value: Readonly<{
  compose: readonly string[]; execute: Execute; imageVolumes: ReadonlyMap<string, ReadonlySet<string>>;
  input: CraigCampaignStackInput; networkId: string | null; projectName: string; volumeName: string;
}>): Promise<RetainedContainer[]> {
  const listed = await value.execute([...value.compose, "ps", "--all", "--quiet"]);
  requireSuccess(listed, "Craig failed-stack container enumeration");
  const ids = listed.stdout.trim() === "" ? [] : listed.stdout.trim().split(/\s+/u);
  if (new Set(ids).size !== ids.length || ids.length > 3) {
    throw new Error("Craig recovery container set is duplicate or exceeds the exact stack services");
  }
  const observed: RetainedContainer[] = [];
  for (const id of ids) { observed.push(await inspectOwnedContainer(value, id, observed)); }
  return observed.toSorted((left, right) => left.id.localeCompare(right.id));
}

async function inspectOwnedContainer(value: Readonly<{
  execute: Execute; imageVolumes: ReadonlyMap<string, ReadonlySet<string>>; input: CraigCampaignStackInput;
  networkId: string | null; projectName: string; volumeName: string;
}>, id: string, observed: readonly RetainedContainer[]): Promise<RetainedContainer> {
  craigSha256Schema.parse(id);
  const inspected = await value.execute(["container", "inspect", id]);
  requireSuccess(inspected, "Craig failed-stack container ownership inspection");
  const container = containerInspectionSchema.parse(parseJson(inspected.stdout,
    "Craig failed-stack container ownership inspection"))[0]!;
  const service = container.Config.Labels["com.docker.compose.service"] ?? "";
  const identity = expectedServiceIdentity(value.input, service);
  assertContainerIdentity({ container, id, identity, input: value.input, observed,
    projectName: value.projectName, service });
  assertContainerNetwork(container, service, value.input, value.networkId);
  const anonymousVolumeNames = assertContainerVolumes(container, service, value.input,
    value.volumeName, value.imageVolumes.get(service));
  return Object.freeze({ anonymousVolumeNames, id, service });
}

function expectedServiceIdentity(input: CraigCampaignStackInput, service: string) {
  if (service === input.service) { return input.serviceIdentity; }
  if (service === input.database.service) { return input.database.imageIdentity; }
  if (service === input.migrationService) { return input.migrationImageIdentity; }
  return;
}

function assertContainerIdentity(value: Readonly<{
  container: z.infer<typeof containerInspectionSchema>[number]; id: string;
  identity: { imageId: string; repositoryDigest: string } | undefined; input: CraigCampaignStackInput;
  observed: readonly RetainedContainer[]; projectName: string; service: string;
}>): void {
  const { container, service } = value;
  const labels = container.Config.Labels;
  const expectedName = service === value.input.migrationService
    ? new RegExp(`^/${escapeRegex(value.projectName)}-${escapeRegex(service)}-run-[a-z0-9]+$`, "u")
    : new RegExp(`^/${escapeRegex(value.projectName)}-${escapeRegex(service)}-1$`, "u");
  if (container.Id !== value.id || value.identity === undefined
    || value.observed.some((item) => item.service === service)
    || labels["com.docker.compose.project"] !== value.projectName
    || labels["com.docker.compose.oneoff"] !== (service === value.input.migrationService ? "True" : "False")
    || labels["com.docker.compose.container-number"] !== "1"
    || labels["com.docker.compose.image"] !== value.identity.imageId
    || labels["com.docker.compose.project.config_files"] !== "-"
    || labels["com.docker.compose.project.working_dir"] !== "/"
    || container.Image !== value.identity.imageId || container.Config.Image !== value.identity.repositoryDigest
    || !expectedName.test(container.Name)) {
    throw new Error("Craig recovery refuses a container outside exact project/service/image/name custody");
  }
  assertContainerEnvironment(container.Config.Env, service, value.input);
}

function assertContainerNetwork(container: z.infer<typeof containerInspectionSchema>[number], service: string,
  input: CraigCampaignStackInput, networkId: string | null): void {
  if (service !== input.service && service !== input.database.service) { return; }
  const attachment = container.NetworkSettings.Networks[input.networkPolicy.name];
  const expectedIpv4 = service === input.service ? input.networkPolicy.botIpv4 : input.networkPolicy.databaseIpv4;
  if (networkId === null || attachment?.IPAddress !== expectedIpv4 || attachment.NetworkID !== networkId) {
    throw new Error("Craig recovery container has foreign network attachment custody");
  }
}

function assertContainerVolumes(container: z.infer<typeof containerInspectionSchema>[number], service: string,
  input: CraigCampaignStackInput, volumeName: string,
  expectedDestinations: ReadonlySet<string> | undefined): readonly string[] {
  const volumeMounts = container.Mounts.filter(({ Type }) => Type === "volume");
  if (expectedDestinations === undefined || container.Mounts.length !== volumeMounts.length
    || volumeMounts.length !== expectedDestinations.size
    || volumeMounts.some(({ Destination, Driver }) => Driver !== "local"
      || !expectedDestinations.has(Destination))) {
    throw new Error("Craig recovery container volume mounts do not match its pinned image custody");
  }
  const anonymousNames = volumeMounts.filter(({ Name }) => Name !== volumeName).map(({ Name }) => {
    craigSha256Schema.parse(Name); return Name;
  }).toSorted();
  const wrongDatabaseMount = service === input.database.service
    && (volumeMounts.length !== 1 || volumeMounts[0]?.Name !== volumeName
      || volumeMounts[0].Destination !== "/var/lib/postgresql/data");
  if (wrongDatabaseMount
    || service !== input.database.service && volumeMounts.some(({ Name }) => Name === volumeName)) {
    throw new Error("Craig recovery container selected a foreign named or anonymous volume");
  }
  return anonymousNames;
}

function assertContainerEnvironment(environmentEntries: readonly string[], service: string,
  input: CraigCampaignStackInput): void {
  const environment = Object.fromEntries(environmentEntries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1) { throw new Error("Craig recovery container environment is malformed"); }
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
  const databaseUrl = `postgresql://${input.database.user}:${input.database.password}`
    + `@${input.database.service}:5432/${input.database.name}`;
  const expected = service === input.service ? {
    DATABASE_URL: databaseUrl, DISCORD_APPLICATION_ID: input.serviceIdentity.applicationId,
    E2E_CAMPAIGN_ID: input.campaignId, E2E_SOURCE_REVISION: input.serviceIdentity.sourceRevision,
  } : service === input.database.service ? {
    POSTGRES_DB: input.database.name, POSTGRES_PASSWORD: input.database.password,
    POSTGRES_USER: input.database.user,
  } : { DATABASE_URL: databaseUrl };
  if (Object.entries(expected).some(([key, expectedValue]) => environment[key] !== expectedValue)) {
    throw new Error("Craig recovery container environment does not match exact retained plan custody");
  }
}

async function inspectOwnedNetwork(execute: Execute, input: CraigCampaignStackInput,
  projectName: string): Promise<string | null> {
  const name = input.networkPolicy.name;
  const result = await execute(["network", "inspect", name]);
  if (isAbsent(result, "network")) { return null; }
  requireSuccess(result, "Craig failed-stack network ownership inspection");
  const network = networkInspectionSchema.parse(parseJson(result.stdout,
    "Craig failed-stack network ownership inspection"))[0]!;
  if (network.Labels["com.docker.compose.project"] !== projectName
    || network.Labels["com.docker.compose.network"] !== name || network.Name !== name
    || network.Driver !== "bridge" || network.Internal
    || JSON.stringify(network.Options) !== JSON.stringify({
      "com.docker.network.bridge.name": input.networkPolicy.bridgeInterface,
    }) || network.IPAM.Config.length !== 1 || network.IPAM.Config[0]?.Subnet !== input.networkPolicy.subnet) {
    throw new Error("Craig recovery refuses a network outside exact project/bridge/driver/subnet custody");
  }
  return network.Id;
}

async function inspectOwnedVolume(execute: Execute, name: string, projectName: string,
  volume: string): Promise<boolean> {
  const result = await execute(["volume", "inspect", name]);
  if (isAbsent(result, "volume")) { return false; }
  requireSuccess(result, "Craig failed-stack volume ownership inspection");
  const inspected = volumeInspectionSchema.parse(parseJson(result.stdout,
    "Craig failed-stack volume ownership inspection"))[0]!;
  const labels = inspected.Labels;
  if (inspected.Name !== name || inspected.Driver !== "local"
    || labels === null || labels["com.docker.compose.project"] !== projectName
    || labels["com.docker.compose.volume"] !== volume) {
    throw new Error("Craig recovery refuses a volume outside exact project/name/driver/label custody");
  }
  return true;
}

async function inspectOwnedAnonymousVolume(execute: Execute, name: string): Promise<void> {
  const result = await execute(["volume", "inspect", name]);
  requireSuccess(result, "Craig failed-stack anonymous volume custody inspection");
  const inspected = volumeInspectionSchema.parse(parseJson(result.stdout,
    "Craig failed-stack anonymous volume custody inspection"))[0]!;
  if (inspected.Name !== name || inspected.Driver !== "local"
    || JSON.stringify(inspected.Labels) !== JSON.stringify({ "com.docker.volume.anonymous": "" })) {
    throw new Error("Craig recovery refuses a foreign anonymous volume driver/name/label custody");
  }
}

async function inspectRecoveryImages(execute: Execute,
  input: CraigCampaignStackInput): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const services = [
    [input.service, input.serviceIdentity], [input.database.service, input.database.imageIdentity],
    [input.migrationService, input.migrationImageIdentity],
  ] as const;
  const volumes = new Map<string, ReadonlySet<string>>();
  for (const [service, identity] of services) {
    const result = await execute(["image", "inspect", identity.repositoryDigest]);
    requireSuccess(result, "Craig recovery pinned image custody inspection");
    const image = imageInspectionSchema.parse(parseJson(result.stdout,
      "Craig recovery pinned image custody inspection"))[0]!;
    if (image.Id !== identity.imageId || !image.RepoDigests.includes(identity.repositoryDigest)) {
      throw new Error("Craig recovery refuses a foreign repository digest or image ID");
    }
    volumes.set(service, new Set(Object.keys(image.Config.Volumes ?? {})));
  }
  return volumes;
}

async function assertExactProjectResourceSets(value: Readonly<{
  containers: readonly RetainedContainer[]; execute: Execute; networkId: string | null;
  projectName: string; volumeName: string; volumePresent: boolean;
}>): Promise<void> {
  const expected = { container: value.containers.map(({ id }) => id).toSorted(),
    network: value.networkId === null ? [] : [value.networkId],
    volume: value.volumePresent ? [value.volumeName] : [] } as const;
  for (const kind of ["container", "network", "volume"] as const) {
    const listed = await value.execute([kind, "ls", ...(kind === "container" ? ["--all", "--no-trunc"]
      : kind === "network" ? ["--no-trunc"] : []), "--quiet",
      "--filter", `label=com.docker.compose.project=${value.projectName}`]);
    requireSuccess(listed, `Craig failed-stack labeled ${kind} custody enumeration`);
    const observed = listed.stdout.trim() === "" ? [] : listed.stdout.trim().split(/\s+/u).toSorted();
    if (JSON.stringify(observed) !== JSON.stringify(expected[kind])) {
      throw new Error(`Craig recovery refuses a foreign or incomplete project-labeled ${kind} set`);
    }
  }
}

function isAbsent(result: CraigCampaignStackCommandResult, kind: "network" | "volume"): boolean {
  if (result.exitCode !== 1) { return false; }
  return (kind === "network" ? /(?:no such network|network\s+\S+\s+not found)/iu : /no such volume/iu)
    .test(result.stderr);
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not JSON`); }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

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
