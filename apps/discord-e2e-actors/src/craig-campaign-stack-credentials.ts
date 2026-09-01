import type { CraigCampaignStackInput } from "./craig-campaign-stack-schemas.js";

export function craigCredentialContents(input: CraigCampaignStackInput, projectName: string): string {
  return [...Object.entries(craigCredentialEnvironment(input, projectName))
    .map(([name, value]) => `${name}=${value}`), ""].join("\n");
}

export function craigCredentialEnvironment(input: CraigCampaignStackInput,
  projectName: string): Record<string, string> {
  const url = `postgresql://${encodeURIComponent(input.database.user)}:${encodeURIComponent(input.database.password)}`
    + `@${input.database.service}:5432/${encodeURIComponent(input.database.name)}`;
  return { COMPOSE_PROJECT_NAME: projectName, E2E_CAMPAIGN_ID: input.campaignId,
    E2E_RELEASE_ID: input.release.releaseId, POSTGRES_DB: input.database.name,
    POSTGRES_PASSWORD: input.database.password, POSTGRES_USER: input.database.user, DATABASE_URL: url };
}

export function craigMigrationRunArguments(input: CraigCampaignStackInput): readonly string[] {
  if (input.serviceIdentity.protocol.kind !== "test-port-substitute") { return [input.migrationService]; }
  const databaseUrl = `postgresql://${encodeURIComponent(input.database.user)}:${encodeURIComponent(input.database.password)}`
    + `@localhost:5432/${encodeURIComponent(input.database.name)}`;
  const table = `${input.database.schema}.${input.database.migrationTable}`;
  const statements = [`CREATE TABLE ${table}(version text primary key, checksum text not null)`,
    ...input.database.migrations.map(({ checksum, version }) =>
      `INSERT INTO ${table}(version, checksum) VALUES ('${version}', '${checksum}')`)].join("; ");
  return ["--entrypoint", "psql", input.migrationService, databaseUrl, "--no-psqlrc",
    "--set", "ON_ERROR_STOP=1", "--command", statements];
}
