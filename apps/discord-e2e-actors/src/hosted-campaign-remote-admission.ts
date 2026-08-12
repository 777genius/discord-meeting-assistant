import { createHash } from "node:crypto";

import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const instantSchema = z.iso.datetime({ offset: true });

const deploymentSafetyReferenceSchema = z.object({
  kind: z.literal("hosted-deployment-safety"),
  receiptSha256: sha256Schema,
  schemaVersion: z.literal(1),
}).strict();
const discordIdentityReferenceSchema = z.object({
  kind: z.literal("hosted-discord-identity-receipt"), receiptSha256: sha256Schema, schemaVersion: z.literal(1),
}).strict();
const voicetextCanaryReferenceSchema = z.object({
  kind: z.literal("hosted-voicetext-semantic-canary-receipt"), receiptSha256: sha256Schema,
  schemaVersion: z.literal(1),
}).strict();
const clockPreflightReferenceSchema = z.object({
  kind: z.literal("hosted-clock-preflight-receipt"), proofId: sha256Schema, schemaVersion: z.literal(2),
}).strict();

export const hostedRemoteReadinessV1Schema = z.object({
  campaignId: z.string().min(1),
  clockPreflight: clockPreflightReferenceSchema,
  deploymentSafety: deploymentSafetyReferenceSchema,
  discordIdentity: discordIdentityReferenceSchema,
  expiresAt: instantSchema,
  kind: z.literal("hosted-remote-readiness"),
  persistence: z.literal("create-only"),
  planSha256: sha256Schema,
  probedAt: instantSchema,
  receiptSha256: sha256Schema,
  schemaVersion: z.literal(1),
  voicetextCanary: voicetextCanaryReferenceSchema,
}).strict();

export type HostedRemoteReadinessV1 = Readonly<z.infer<typeof hostedRemoteReadinessV1Schema>>;

export type HostedCampaignRemoteAdmissionProbeRequest = Readonly<{
  campaignId: string;
  planSha256: string;
}>;

/** Consumer-owned application boundary. Concrete SSH/provider concerns stay outside admission. */
export interface HostedCampaignRemoteAdmissionProbe {
  inspect(request: HostedCampaignRemoteAdmissionProbeRequest): Promise<unknown>;
}

export type HostedRemoteAdmissionEvaluation = Readonly<{
  missingSections: readonly HostedRemoteReadinessSection[];
  readiness?: HostedRemoteReadinessV1;
}>;

export type HostedRemoteReadinessSection =
  | "clockPreflight"
  | "deploymentSafety"
  | "discordIdentity"
  | "voicetextCanary";

const readinessSections = [
  "deploymentSafety",
  "discordIdentity",
  "voicetextCanary",
  "clockPreflight",
] as const satisfies readonly HostedRemoteReadinessSection[];

export async function evaluateHostedRemoteAdmission(
  probe: HostedCampaignRemoteAdmissionProbe | undefined,
  expected: HostedCampaignRemoteAdmissionProbeRequest,
  nowEpochMs: number,
): Promise<HostedRemoteAdmissionEvaluation> {
  if (probe === undefined) {
    return Object.freeze({ missingSections: readinessSections });
  }
  if (!Number.isSafeInteger(nowEpochMs)) {
    throw new Error("Hosted remote admission requires a safe evaluation time");
  }
  const readiness = verifyHostedRemoteReadinessV1(await probe.inspect(expected));
  if (readiness.campaignId !== expected.campaignId || readiness.planSha256 !== expected.planSha256) {
    throw new Error("Hosted remote readiness does not match the exact campaign and plan");
  }
  const probedAt = Date.parse(readiness.probedAt);
  const expiresAt = Date.parse(readiness.expiresAt);
  if (probedAt > nowEpochMs || expiresAt <= nowEpochMs || expiresAt <= probedAt) {
    throw new Error("Hosted remote readiness is stale, expired, or from the future");
  }
  return Object.freeze({ missingSections: Object.freeze([]), readiness });
}

export function verifyHostedRemoteReadinessV1(value: unknown): HostedRemoteReadinessV1 {
  const receipt = hostedRemoteReadinessV1Schema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Hosted remote readiness digest is invalid");
  }
  return Object.freeze(receipt);
}

/** Test/adaptor helper. Admission accepts the result only through its injected trusted probe port. */
export function createHostedRemoteReadinessV1(
  content: Omit<HostedRemoteReadinessV1, "receiptSha256">,
): HostedRemoteReadinessV1 {
  return verifyHostedRemoteReadinessV1({ ...content, receiptSha256: digestCanonical(content) });
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(canonicalize); }
  if (typeof value !== "object" || value === null) { return value; }
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}
