import { isAlias, isNode, isPair, isScalar, parseAllDocuments, visit } from "yaml";
import { z } from "zod";

import type { CraigCampaignStackInput } from "./craig-disposable-campaign-stack.js";

const image = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const environment = z.record(z.string(), z.string().refine((value) => !value.includes("$"),
  "Compose interpolation is forbidden"));
const healthcheck = z.object({
  disable: z.boolean().optional(), interval: z.string().optional(), retries: z.number().int().nonnegative().optional(),
  start_interval: z.string().optional(), start_period: z.string().optional(),
  test: z.array(z.string().refine((value) => !value.includes("$"))).min(1).max(32).optional(),
  timeout: z.string().optional(),
}).strict();

/**
 * Parses the authoritative source before Compose can perform interpolation,
 * file inclusion, merge expansion, or any other external resolution.
 */
export function validateSourceCraigCompose(source: string, input: CraigCampaignStackInput): void {
  const documents = parseAllDocuments(source, {
    keepSourceTokens: true,
    merge: false,
    schema: "core",
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length !== 1 || documents[0] === undefined) {
    throw new Error("Craig source Compose must contain exactly one YAML document");
  }
  const document = documents[0];
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("Craig source Compose contains unsupported or ambiguous YAML");
  }
  if (source.split(/\r?\n/u).some((line) => line.trimStart().startsWith("%"))) {
    throw new Error("Craig source Compose YAML directives are forbidden");
  }
  visit(document, (_key, node) => {
    if (isAlias(node)) { throw new Error("Craig source Compose YAML aliases are forbidden"); }
    if (isNode(node) && (node.anchor !== undefined || node.tag !== undefined)) {
      throw new Error("Craig source Compose YAML anchors and tags are forbidden");
    }
    if (isPair(node) && isScalar(node.key) && node.key.value === "<<") {
      throw new Error("Craig source Compose YAML merge keys are forbidden");
    }
  });
  const network = input.networkPolicy.name;
  const serviceNetwork = (ipv4: string) => z.object({
    [network]: z.object({ ipv4_address: z.literal(ipv4) }).strict(),
  }).strict();
  const schema = z.object({
    networks: z.object({
      [network]: z.object({
        driver: z.literal("bridge"),
        driver_opts: z.object({ "com.docker.network.bridge.name": z.literal(input.networkPolicy.bridgeInterface) })
          .strict(),
        ipam: z.object({ config: z.tuple([z.object({ subnet: z.literal(input.networkPolicy.subnet) }).strict()]) })
          .strict(),
        name: z.literal(network),
      }).strict(),
    }).strict(),
    services: z.object({
      [input.database.service]: z.object({
        environment: environment.optional(), healthcheck: healthcheck.optional(),
        hostname: z.literal(input.database.service).optional(), image,
        networks: serviceNetwork(input.networkPolicy.databaseIpv4),
        volumes: z.tuple([z.literal(`${input.database.volume}:/var/lib/postgresql/data`)]),
      }).strict(),
      [input.migrationService]: z.object({
        depends_on: z.object({
          [input.database.service]: z.object({ condition: z.literal("service_started"),
            required: z.literal(true), restart: z.literal(true) }).strict(),
        }).strict(),
        environment: environment.optional(), image,
        network_mode: z.literal(`service:${input.database.service}`),
      }).strict(),
      [input.service]: z.object({
        environment: environment.optional(), healthcheck: healthcheck.optional(),
        hostname: z.literal(input.service).optional(), image,
        networks: serviceNetwork(input.networkPolicy.botIpv4),
      }).strict(),
    }).strict(),
    volumes: z.object({ [input.database.volume]: z.null().or(z.object({}).strict()) }).strict(),
  }).strict();
  const parsed = schema.parse(document.toJS({ maxAliasCount: 0 }));
  assertLiteralIdentity(parsed, input);
}

function assertLiteralIdentity(value: Readonly<{ services: Record<string, {
  environment?: Record<string, string> | undefined; image: string;
}> }>, input: CraigCampaignStackInput): void {
  const database = value.services[input.database.service];
  const migration = value.services[input.migrationService];
  const bot = value.services[input.service];
  const databaseUrl = `postgresql://${encodeURIComponent(input.database.user)}:${encodeURIComponent(input.database.password)}`
    + `@${input.database.service}:5432/${encodeURIComponent(input.database.name)}`;
  const expectedDatabaseEnvironment = { POSTGRES_DB: input.database.name, POSTGRES_PASSWORD: input.database.password,
    POSTGRES_USER: input.database.user };
  const expectedBotEnvironment = { DATABASE_URL: databaseUrl,
    DISCORD_APPLICATION_ID: input.serviceIdentity.applicationId, E2E_CAMPAIGN_ID: input.campaignId,
    E2E_SOURCE_REVISION: input.serviceIdentity.sourceRevision };
  if (database?.image !== input.database.imageIdentity.repositoryDigest
    || migration?.image !== input.migrationImageIdentity.repositoryDigest
    || bot?.image !== input.serviceIdentity.repositoryDigest
    || JSON.stringify(database.environment) !== JSON.stringify(expectedDatabaseEnvironment)
    || migration.environment?.DATABASE_URL !== databaseUrl
    || JSON.stringify(bot.environment) !== JSON.stringify(expectedBotEnvironment)) {
    throw new Error("Craig source Compose does not contain the exact literal admitted stack identity");
  }
}
