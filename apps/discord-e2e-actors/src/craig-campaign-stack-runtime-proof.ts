import { z } from "zod";

import type { RenderedCraigCompose } from "./craig-campaign-compose-validation.js";
import type {
  CraigCampaignStackCommandResult,
  CraigCampaignStackInput,
} from "./craig-disposable-campaign-stack.js";
import type { HostedCampaignReleaseReferenceV1 } from "./hosted-campaign-release-reference.js";

type Execute = (args: readonly string[]) => Promise<CraigCampaignStackCommandResult>;
const imageId = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigest = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);

export interface CraigCampaignStackAbsenceProofV1 {
  readonly absentContainerIds: readonly [string, string]; readonly absentNetworkId: string;
  readonly absentNetworkName: string; readonly absentVolumeName: string; readonly campaignId: string;
  readonly kind: "craig-stack-absence-proof"; readonly planSha256: string; readonly projectName: string;
  readonly release: HostedCampaignReleaseReferenceV1; readonly schemaVersion: 1;
}

export async function proveCraigResourcesAbsentAfterDown(execute: Execute, compose: readonly string[], input: Readonly<{
  campaignId: string; containerIds: readonly [string, string]; networkId: string; networkName: string;
  planSha256: string; projectName: string; release: HostedCampaignReleaseReferenceV1; volumeName: string;
}>): Promise<CraigCampaignStackAbsenceProofV1> {
  const project = await execute([...compose, "ps", "--all", "--quiet"]);
  requireSuccess(project, "Craig post-down Compose container absence proof");
  if (project.stdout.trim() !== "") { throw new Error("Craig containers remain after Compose down"); }
  for (const containerId of input.containerIds) {
    requireDockerObjectAbsent(await execute(["container", "inspect", containerId]), "container");
  }
  for (const type of ["volume", "network"] as const) {
    const labeled = await execute([type, "ls", "--quiet", "--filter",
      `label=com.docker.compose.project=${input.projectName}`]);
    requireSuccess(labeled, `Craig post-down labeled ${type} absence proof`);
    if (labeled.stdout.trim() !== "") { throw new Error(`Craig labeled ${type} remains after Compose down`); }
  }
  requireDockerObjectAbsent(await execute(["network", "inspect", input.networkId]), "network");
  requireDockerObjectAbsent(await execute(["network", "inspect", input.networkName]), "network");
  requireDockerObjectAbsent(await execute(["volume", "inspect", input.volumeName]), "volume");
  return Object.freeze({ absentContainerIds: input.containerIds, absentNetworkId: input.networkId,
    absentNetworkName: input.networkName, absentVolumeName: input.volumeName, campaignId: input.campaignId,
    kind: "craig-stack-absence-proof", planSha256: input.planSha256, projectName: input.projectName,
    release: input.release, schemaVersion: 1 });
}

function requireDockerObjectAbsent(result: CraigCampaignStackCommandResult,
  kind: "container" | "network" | "volume"): void {
  const absent = kind === "container" ? /no such (?:object|container)/iu
    : kind === "network" ? /(?:no such network|network\s+\S+\s+not found)/iu : /no such volume/iu;
  if (result.exitCode === 0 || result.exitCode !== 1 || !absent.test(result.stderr)) {
    throw new Error(`Craig ${kind} could not be independently proved absent after down`);
  }
}

export async function assertCraigResourcesAbsent(
  execute: Execute,
  compose: readonly string[],
  rendered: RenderedCraigCompose,
  projectName: string,
): Promise<void> {
  const project = await execute([...compose, "ps", "--all", "--quiet"]);
  requireSuccess(project, "Craig Compose project collision inspection");
  if (project.stdout.trim() !== "") {
    throw new Error("Craig campaign Compose project already exists; never reuse a campaign ID");
  }
  for (const type of ["volume", "network"] as const) {
    const result = await execute([type, "ls", "--quiet", "--filter", `label=com.docker.compose.project=${projectName}`]);
    requireSuccess(result, `Craig campaign ${type} collision inspection`);
    if (result.stdout.trim() !== "") {
      throw new Error(`Craig campaign ${type} already exists; stale resources are not reusable`);
    }
  }
  const volumes = Object.values(rendered.volumes).map(({ name }) => name);
  for (const volume of volumes) {
    const result = await execute(["volume", "inspect", volume]);
    if (result.exitCode === 0 || !/no such volume/iu.test(result.stderr)) {
      throw new Error("Craig campaign declared volume already exists or could not be proven absent");
    }
  }
  for (const network of Object.values(rendered.networks).map(({ name }) => name)) {
    const result = await execute(["network", "inspect", network]);
    if (result.exitCode === 0 || !/(?:no such network|network\s+\S+\s+not found)/iu.test(result.stderr)) {
      throw new Error("Craig campaign declared network already exists or could not be proven absent");
    }
  }
}

export async function verifyCraigPinnedImages(execute: Execute, input: CraigCampaignStackInput): Promise<void> {
  const identities = [input.database.imageIdentity, input.migrationImageIdentity, input.serviceIdentity];
  for (const identity of identities) {
    const result = await execute(["image", "inspect", identity.repositoryDigest]);
    requireSuccess(result, "Craig digest-pinned image identity");
    let observed: unknown;
    try { observed = JSON.parse(result.stdout); } catch {
      throw new Error("Craig digest-pinned image inspection is not JSON");
    }
    const parsed = z.array(z.object({ Id: imageId, RepoDigests: z.array(repositoryDigest) }).loose())
      .length(1).parse(observed)[0]!;
    if (parsed.Id !== identity.imageId || !parsed.RepoDigests.includes(identity.repositoryDigest)) {
      throw new Error("Craig digest-pinned image runtime identity is invalid");
    }
  }
}

export async function verifyCraigDatabase(execute: Execute, compose: readonly string[],
  input: CraigCampaignStackInput): Promise<void> {
  const sql = "SELECT current_database(), current_user";
  const result = await execute([...compose, "exec", "-T", input.database.service, "psql", "--no-psqlrc",
    "--tuples-only", "--no-align", "--username", input.database.user, "--dbname", input.database.name,
    "--command", sql]);
  requireSuccess(result, "Craig PostgreSQL identity verification");
  if (result.stdout.trim() !== `${input.database.name}|${input.database.user}`) {
    throw new Error("Craig PostgreSQL connected identity is invalid");
  }
}

export async function verifyCraigMigration(execute: Execute, compose: readonly string[],
  input: CraigCampaignStackInput): Promise<void> {
  const qualified = `"${input.database.schema}"."${input.database.migrationTable}"`;
  const sql = `SELECT version::text || '|' || checksum::text FROM ${qualified} ORDER BY version`;
  const result = await execute([...compose, "exec", "-T", input.database.service, "psql", "--no-psqlrc",
    "--tuples-only", "--no-align", "--username", input.database.user, "--dbname", input.database.name,
    "--command", sql]);
  requireSuccess(result, "Craig PostgreSQL schema/migration verification");
  const expected = input.database.migrations.map(({ version, checksum }) => `${version}|${checksum}`).join("\n");
  if (result.stdout.trim() !== expected) {
    throw new Error("Craig PostgreSQL complete migration version/checksum set is invalid");
  }
}

function requireSuccess(result: CraigCampaignStackCommandResult, label: string): void {
  if (result.exitCode !== 0) { throw new Error(`${label} failed closed (exit ${result.exitCode})`); }
}
