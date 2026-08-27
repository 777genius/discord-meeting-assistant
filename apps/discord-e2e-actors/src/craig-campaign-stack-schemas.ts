import { normalize } from "node:path";
import { z } from "zod";
import { hostedCampaignReleaseReferenceV1Schema } from "./hosted-campaign-release-reference.js";
import { craigCampaignNetworkPolicySchema } from "./craig-campaign-network-plan.js";

export const craigIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
export const craigComposeCoordinateSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u);
export const craigSha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
export const craigContainerIdSchema = z.string().regex(/^[a-f\d]{64}$/u);
export const craigImageIdSchema = z.string().regex(/^sha256:[a-f\d]{64}$/u);
export const craigRepositoryDigestSchema = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
export const craigSourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
export const craigAbsolutePathSchema = z.string().refine((value) =>
  value.startsWith("/") && normalize(value) === value && value !== "/" && !value.includes("\0"));

export const craigCampaignStackInputSchema = z.object({
  campaignId: craigIdentifierSchema, campaignRoot: craigAbsolutePathSchema,
  composeCanonical: z.string().min(1).max(1024 * 1024), composeCanonicalSha256: craigSha256Schema,
  composeFile: craigAbsolutePathSchema, credentialFile: craigAbsolutePathSchema,
  database: z.object({
    imageIdentity: z.object({ imageId: craigImageIdSchema,
      repositoryDigest: craigRepositoryDigestSchema }).strict(),
    migrations: z.array(z.object({ checksum: craigSha256Schema,
      version: craigIdentifierSchema }).strict()).min(1).max(512),
    migrationTable: craigComposeCoordinateSchema, name: craigComposeCoordinateSchema,
    password: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u), schema: craigComposeCoordinateSchema,
    service: craigComposeCoordinateSchema, user: craigComposeCoordinateSchema,
    volume: craigComposeCoordinateSchema,
  }).strict(),
  migrationService: craigComposeCoordinateSchema,
  migrationImageIdentity: z.object({ imageId: craigImageIdSchema,
    repositoryDigest: craigRepositoryDigestSchema }).strict(),
  networkPolicy: craigCampaignNetworkPolicySchema,
  readinessTimeoutSeconds: z.number().int().positive().max(300), release: hostedCampaignReleaseReferenceV1Schema,
  service: craigComposeCoordinateSchema,
  serviceIdentity: z.object({
    applicationId: z.string().regex(/^\d{17,20}$/u), imageId: craigImageIdSchema,
    repositoryDigest: craigRepositoryDigestSchema, sourceRevision: craigSourceRevisionSchema,
    protocol: z.discriminatedUnion("kind", [
      z.object({ command: z.tuple([z.literal("/app/bin/craig-control"), z.literal("readiness"),
        z.literal("--format=json")]), expectedResponseSha256: craigSha256Schema,
      kind: z.literal("craig-application"), name: z.literal("craig-control-readiness"),
      version: z.literal("v1") }).strict(),
      z.object({ command: z.array(z.string().min(1).max(512)).min(1).max(16),
        expectedResponseSha256: craigSha256Schema, kind: z.literal("test-port-substitute"),
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
        version: craigIdentifierSchema }).strict(),
    ]),
  }).strict(),
}).strict();

export type CraigCampaignStackInput = z.input<typeof craigCampaignStackInputSchema>;
