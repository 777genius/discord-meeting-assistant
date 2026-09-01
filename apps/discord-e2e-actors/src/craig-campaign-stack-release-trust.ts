import { createHash } from "node:crypto";

import { z } from "zod";

import { digestCraigCampaignStackCanonical } from "./craig-campaign-stack-digest.js";
import type { CraigCampaignStackInput } from "./craig-disposable-campaign-stack.js";
import {
  hostedCampaignReleaseReferenceV1Schema,
  type HostedCampaignReleaseReferenceV1,
} from "./hosted-campaign-release-reference.js";

const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const imageId = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigest = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const sourceRevision = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const imageIdentity = z.object({ imageId, repositoryDigest }).strict();

export const craigCampaignStackTrustSchema = z.object({
  applicationId: z.string().regex(/^\d{17,20}$/u),
  composeCanonical: z.string().min(1).max(1024 * 1024), composeCanonicalSha256: sha256,
  composeFile: z.string().startsWith("/"),
  credentialAuthority: z.literal("compiled-release-sha256"),
  databaseName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  databasePasswordSha256: sha256,
  databaseSchema: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  databaseUser: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  databaseVolume: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  databaseImageIdentity: imageIdentity,
  databaseMigrationTable: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  databaseService: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  migrationImageIdentity: imageIdentity,
  migrations: z.array(z.object({ checksum: sha256,
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u) }).strict()).min(1).max(512),
  migrationService: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u), migrationSetSha256: sha256,
  protocol: z.object({ command: z.tuple([z.literal("/app/bin/craig-control"), z.literal("readiness"),
    z.literal("--format=json")]), expectedResponseSha256: sha256, kind: z.literal("craig-application"),
  name: z.literal("craig-control-readiness"), version: z.literal("v1") }).strict(),
  readinessTimeoutSeconds: z.number().int().positive().max(300),
  service: z.literal("bot"), serviceImageIdentity: imageIdentity, sourceRevision,
}).strict().superRefine((value, context) => {
  if (createHash("sha256").update(value.composeCanonical).digest("hex") !== value.composeCanonicalSha256
    || digestCraigCampaignStackCanonical(value.migrations) !== value.migrationSetSha256) {
    context.addIssue({ code: "custom", message: "Craig stack trust digests must match their canonical bytes" });
  }
});

export function assertCraigCampaignStackInputMatchesTrust(
  candidate: CraigCampaignStackInput,
  expected: z.infer<typeof craigCampaignStackTrustSchema>,
  expectedRelease: HostedCampaignReleaseReferenceV1,
): void {
  const release = hostedCampaignReleaseReferenceV1Schema.parse(expectedRelease);
  const expectedProjectName = deriveProjectName(candidate.campaignId, release);
  const observed = {
    applicationId: candidate.serviceIdentity.applicationId,
    composeCanonical: candidate.composeCanonical, composeCanonicalSha256: candidate.composeCanonicalSha256,
    composeFile: candidate.composeFile, credentialAuthority: "compiled-release-sha256" as const,
    databaseName: candidate.database.name,
    databasePasswordSha256: createHash("sha256").update(candidate.database.password).digest("hex"),
    databaseSchema: candidate.database.schema, databaseUser: candidate.database.user,
    databaseVolume: candidate.database.volume,
    databaseImageIdentity: candidate.database.imageIdentity, databaseService: candidate.database.service,
    databaseMigrationTable: candidate.database.migrationTable,
    migrationImageIdentity: candidate.migrationImageIdentity, migrations: candidate.database.migrations,
    migrationService: candidate.migrationService,
    migrationSetSha256: digestCraigCampaignStackCanonical(candidate.database.migrations),
    protocol: candidate.serviceIdentity.protocol, readinessTimeoutSeconds: candidate.readinessTimeoutSeconds,
    service: candidate.service,
    serviceImageIdentity: { imageId: candidate.serviceIdentity.imageId,
      repositoryDigest: candidate.serviceIdentity.repositoryDigest },
    sourceRevision: candidate.serviceIdentity.sourceRevision,
  };
  const candidateTrustSelection = {
    projectName: deriveProjectName(candidate.campaignId, candidate.release),
    release: candidate.release,
    stack: observed,
  };
  const expectedTrustSelection = { projectName: expectedProjectName, release, stack: expected };
  if (digestCraigCampaignStackCanonical(candidateTrustSelection)
    !== digestCraigCampaignStackCanonical(expectedTrustSelection)) {
    throw new Error("Operator-selected Craig stack does not match the compiled release trust root");
  }
}

function deriveProjectName(campaignId: string, release: HostedCampaignReleaseReferenceV1): string {
  return `craig-e2e-${digestCraigCampaignStackCanonical({ campaignId, release }).slice(0, 20)}`;
}
