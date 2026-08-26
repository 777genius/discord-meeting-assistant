import { z } from "zod";

import type { RenderedCraigCompose } from "./craig-campaign-compose-validation.js";
import type {
  CraigCampaignStackCommandResult,
  CraigCampaignStackInput,
} from "./craig-disposable-campaign-stack.js";

type Execute = (args: readonly string[]) => Promise<CraigCampaignStackCommandResult>;
const imageId = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigest = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);

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
