import { z } from "zod";

import type { CraigCampaignStackInput } from "./craig-disposable-campaign-stack.js";

const environment = z.record(z.string(), z.string());
const healthcheck = z.object({
  disable: z.boolean().optional(),
  interval: z.string().optional(),
  retries: z.number().int().nonnegative().optional(),
  start_interval: z.string().optional(),
  start_period: z.string().optional(),
  test: z.array(z.string()).min(1).max(32).optional(),
  timeout: z.string().optional(),
}).strict();
const inertProcessOverride = {
  command: z.null(),
  entrypoint: z.null(),
} as const;
const image = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);

export type RenderedCraigCompose = Readonly<{
  name: string;
  services: Record<string, RenderedService>;
  volumes: Record<string, { name: string }>;
}>;
type RenderedService = Readonly<{
  command: null;
  depends_on?: Record<string, { condition: "service_started"; required: true; restart: true }>;
  entrypoint: null;
  environment?: Record<string, string>;
  healthcheck?: z.infer<typeof healthcheck>;
  hostname?: string;
  image: string;
  network_mode: string;
  volumes?: readonly Readonly<{ source: string; target: string; type: "volume"; volume: Record<never, never> }>[];
}>;

export function validateRenderedCraigCompose(
  text: string,
  input: CraigCampaignStackInput,
  projectName: string,
  databaseVolume: string,
): RenderedCraigCompose {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Craig rendered Compose configuration is not JSON"); }
  if (new Set([input.database.service, input.migrationService, input.service]).size !== 3) {
    throw new Error("Craig rendered Compose requires three distinct admitted services");
  }
  const databaseService = z.object({
    ...inertProcessOverride,
    environment: environment.optional(),
    healthcheck: healthcheck.optional(),
    hostname: z.literal(input.database.service).optional(),
    image,
    network_mode: z.literal("none"),
    volumes: z.tuple([z.object({
      source: z.literal(input.database.volume),
      target: z.literal("/var/lib/postgresql/data"),
      type: z.literal("volume"),
      volume: z.object({}).strict(),
    }).strict()]),
  }).strict();
  const migrationService = z.object({
    ...inertProcessOverride,
    depends_on: z.object({
      [input.database.service]: z.object({
        condition: z.literal("service_started"), required: z.literal(true), restart: z.literal(true),
      }).strict(),
    }).strict(),
    environment: environment.optional(),
    image,
    network_mode: z.literal(`service:${input.database.service}`),
  }).strict();
  const craigService = z.object({
    ...inertProcessOverride,
    environment: environment.optional(),
    healthcheck: healthcheck.optional(),
    hostname: z.literal(input.service).optional(),
    image,
    network_mode: z.literal("none"),
  }).strict();
  const schema = z.object({
    name: z.literal(projectName),
    services: z.object({
      [input.database.service]: databaseService,
      [input.migrationService]: migrationService,
      [input.service]: craigService,
    }).strict(),
    volumes: z.object({
      [input.database.volume]: z.object({ name: z.literal(databaseVolume) }).strict(),
    }).strict(),
  }).strict();
  const rendered = schema.parse(value) as RenderedCraigCompose;
  validateServices(rendered, input);
  validateDatabase(rendered, input);
  validateCraigIdentity(rendered, input);
  return rendered;
}

function validateServices(rendered: RenderedCraigCompose, input: CraigCampaignStackInput): void {
  if (rendered.services[input.database.service]?.image !== input.database.imageIdentity.repositoryDigest
    || rendered.services[input.migrationService]?.image !== input.migrationImageIdentity.repositoryDigest
    || rendered.services[input.service]?.image !== input.serviceIdentity.repositoryDigest) {
    throw new Error("Craig rendered database/migration/bot images do not match their exact repository digests");
  }
}

function validateDatabase(rendered: RenderedCraigCompose, input: CraigCampaignStackInput): void {
  const database = rendered.services[input.database.service]!;
  const expectedEnvironment = { POSTGRES_DB: input.database.name, POSTGRES_PASSWORD: input.database.password,
    POSTGRES_USER: input.database.user };
  if (JSON.stringify(database.environment) !== JSON.stringify(expectedEnvironment)) {
    throw new Error("Craig rendered PostgreSQL environment does not match the campaign credential");
  }
  const url = `postgresql://${encodeURIComponent(input.database.user)}:${encodeURIComponent(input.database.password)}`
    + `@${input.database.service}:5432/${encodeURIComponent(input.database.name)}`;
  for (const name of [input.migrationService, input.service]) {
    if (rendered.services[name]?.environment?.DATABASE_URL !== url) {
      throw new Error(`Craig rendered ${name} DATABASE_URL does not match the campaign database`);
    }
  }
}

function validateCraigIdentity(rendered: RenderedCraigCompose, input: CraigCampaignStackInput): void {
  if (rendered.services[input.service]?.environment?.E2E_CAMPAIGN_ID !== input.campaignId
    || rendered.services[input.service]?.environment?.E2E_SOURCE_REVISION !== input.serviceIdentity.sourceRevision
    || rendered.services[input.service]?.environment?.DISCORD_APPLICATION_ID !== input.serviceIdentity.applicationId) {
    throw new Error("Craig rendered service campaign/source/bot identity is invalid");
  }
}
