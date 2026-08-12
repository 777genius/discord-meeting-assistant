import { createHash } from "node:crypto";

import { z } from "zod";

import {
  hostedClockPreflightReceiptV2Schema,
  type HostedClockPreflightReceiptV2,
} from "./hosted-clock-proof-v2.js";
import {
  verifyHostedDeploymentSafetyReceiptV1,
  type HostedDeploymentSafetyReceiptV1,
} from "./hosted-deployment-safety-receipt.js";
import {
  digestDiscordIdentityReceiptContentV1,
  discordIdentityReceiptV1Schema,
  evaluateDiscordIdentityReceiptV1,
  type DiscordIdentityReceiptExpectationV1,
  type DiscordIdentityReceiptV1,
} from "./hosted-discord-identity-receipt.js";
import {
  digestVoicetextSemanticCanaryReceiptContentV1,
  evaluateVoicetextSemanticCanaryReceiptV1,
  type VoicetextSemanticCanaryExpectationV1,
  type VoicetextSemanticCanaryReceiptV1,
  voicetextSemanticCanaryReceiptV1Schema,
} from "./hosted-voicetext-semantic-canary-receipt.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const instantSchema = z.iso.datetime({ offset: true });
const maximumReadinessAgeMs = 60_000;
const maximumReceiptTtlMs = 60_000;
const maximumFutureSkewMs = 2_000;

const deploymentSafetyReferenceSchema = z.object({
  kind: z.literal("hosted-deployment-safety"), receiptSha256: sha256Schema, schemaVersion: z.literal(1),
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
  campaignId: z.string().min(1), clockPreflight: clockPreflightReferenceSchema,
  deploymentSafety: deploymentSafetyReferenceSchema, discordIdentity: discordIdentityReferenceSchema,
  expiresAt: instantSchema, kind: z.literal("hosted-remote-readiness"), persistence: z.literal("create-only"),
  planSha256: sha256Schema, probedAt: instantSchema, receiptSha256: sha256Schema,
  schemaVersion: z.literal(1), voicetextCanary: voicetextCanaryReferenceSchema,
}).strict();

export type HostedRemoteReadinessV1 = Readonly<z.infer<typeof hostedRemoteReadinessV1Schema>>;

export type HostedCampaignRemoteAdmissionProbeRequest = Readonly<{
  campaignId: string;
  meetingPlatformRevision: string;
  planSha256: string;
}>;

export interface HostedRemoteAdmissionEvidenceV1 {
  readonly clockPreflight: unknown;
  readonly deploymentSafety: unknown;
  readonly discordIdentity: unknown;
  readonly kind: "hosted-remote-admission-evidence";
  readonly schemaVersion: 1;
  readonly voicetextCanary: unknown;
}

/** Consumer-owned application boundary. Concrete SSH/provider concerns stay outside admission. */
export interface HostedCampaignRemoteAdmissionProbe {
  inspect(request: HostedCampaignRemoteAdmissionProbeRequest): Promise<unknown>;
}

export interface HostedRemoteAdmissionEvidenceSource {
  collectClockPreflight(): Promise<unknown>;
  collectDeploymentSafety(): Promise<unknown>;
  collectDiscordIdentity(): Promise<unknown>;
  collectVoicetextCanary(): Promise<unknown>;
}

export interface TypedHostedRemoteAdmissionProbeOptions {
  readonly discordIdentityExpectation: Omit<DiscordIdentityReceiptExpectationV1, "nowEpochMs">;
  readonly expectedDeploymentFingerprint: string;
  readonly expectedDeploymentSafetyExpectationSha256: string;
  readonly now: () => number;
  readonly source: HostedRemoteAdmissionEvidenceSource;
  readonly voicetextExpectation: Omit<VoicetextSemanticCanaryExpectationV1, "nowEpochMs">;
}

/**
 * Composition adapter over typed collectors. File paths and remote runners belong to those
 * collectors; this adapter never treats an operator-authored capability document as proof.
 */
export class TypedHostedRemoteAdmissionProbe implements HostedCampaignRemoteAdmissionProbe {
  readonly #options: TypedHostedRemoteAdmissionProbeOptions;

  public constructor(options: TypedHostedRemoteAdmissionProbeOptions) {
    this.#options = options;
  }

  public async inspect(request: HostedCampaignRemoteAdmissionProbeRequest): Promise<HostedRemoteAdmissionEvidenceV1> {
    const nowEpochMs = this.#options.now();
    const [deploymentValue, identityValue, canaryValue, clockValue] = await Promise.all([
      this.#options.source.collectDeploymentSafety(), this.#options.source.collectDiscordIdentity(),
      this.#options.source.collectVoicetextCanary(), this.#options.source.collectClockPreflight(),
    ]);
    const deployment = verifyHostedDeploymentSafetyReceiptV1(deploymentValue);
    if (deployment.campaignId !== request.campaignId
      || deployment.deploymentFingerprint !== this.#options.expectedDeploymentFingerprint
      || deployment.expectationSha256 !== this.#options.expectedDeploymentSafetyExpectationSha256) {
      throw new Error("Hosted deployment safety receipt does not match the pinned deployment");
    }
    evaluateDiscordIdentityReceiptV1(identityValue, {
      ...this.#options.discordIdentityExpectation, nowEpochMs,
    });
    evaluateVoicetextSemanticCanaryReceiptV1(canaryValue, {
      ...this.#options.voicetextExpectation, nowEpochMs,
    });
    hostedClockPreflightReceiptV2Schema.parse(clockValue);
    return Object.freeze({
      clockPreflight: clockValue, deploymentSafety: deploymentValue, discordIdentity: identityValue,
      kind: "hosted-remote-admission-evidence" as const, schemaVersion: 1 as const,
      voicetextCanary: canaryValue,
    });
  }
}

export type HostedRemoteAdmissionEvaluation = Readonly<{
  missingSections: readonly HostedRemoteReadinessSection[];
  readiness?: HostedRemoteReadinessV1;
}>;

export type HostedRemoteReadinessSection = "clockPreflight" | "deploymentSafety" |
"discordIdentity" | "voicetextCanary";

const readinessSections = [
  "deploymentSafety", "discordIdentity", "voicetextCanary", "clockPreflight",
] as const satisfies readonly HostedRemoteReadinessSection[];

export async function evaluateHostedRemoteAdmission(
  probe: HostedCampaignRemoteAdmissionProbe | undefined,
  expected: HostedCampaignRemoteAdmissionProbeRequest,
  nowEpochMs: number,
): Promise<HostedRemoteAdmissionEvaluation> {
  if (probe === undefined) { return Object.freeze({ missingSections: readinessSections }); }
  if (!Number.isSafeInteger(nowEpochMs)) {
    throw new Error("Hosted remote admission requires a safe evaluation time");
  }
  const evidence = parseEvidence(await probe.inspect(expected));
  const deployment = verifyHostedDeploymentSafetyReceiptV1(evidence.deploymentSafety);
  const identity = verifyIdentity(evidence.discordIdentity);
  const canary = verifyCanary(evidence.voicetextCanary);
  const clock = hostedClockPreflightReceiptV2Schema.parse(evidence.clockPreflight);
  assertEvidenceBindings({ canary, clock, deployment, identity }, expected);
  const timestamps = assertEvidenceLifetimes({ canary, clock, deployment, identity }, nowEpochMs);
  const content = {
    campaignId: expected.campaignId,
    clockPreflight: { kind: clock.kind, proofId: clock.proofId, schemaVersion: clock.schemaVersion },
    deploymentSafety: reference(deployment), discordIdentity: reference(identity),
    expiresAt: new Date(Math.min(clock.validUntilEpochMs, identity.expiresAtEpochMs, canary.expiresAtEpochMs)).toISOString(),
    kind: "hosted-remote-readiness" as const, persistence: "create-only" as const,
    planSha256: expected.planSha256, probedAt: new Date(Math.max(...timestamps)).toISOString(),
    schemaVersion: 1 as const, voicetextCanary: reference(canary),
  };
  const readiness = verifyHostedRemoteReadinessV1({ ...content, receiptSha256: digestCanonical(content) });
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

/** Test helper only. Production admission creates readiness from validated full receipts. */
export function createHostedRemoteReadinessV1(
  content: Omit<HostedRemoteReadinessV1, "receiptSha256">,
): HostedRemoteReadinessV1 {
  return verifyHostedRemoteReadinessV1({ ...content, receiptSha256: digestCanonical(content) });
}

function parseEvidence(value: unknown): HostedRemoteAdmissionEvidenceV1 {
  const schema = z.object({
    clockPreflight: z.unknown(), deploymentSafety: z.unknown(), discordIdentity: z.unknown(),
    kind: z.literal("hosted-remote-admission-evidence"), schemaVersion: z.literal(1),
    voicetextCanary: z.unknown(),
  }).strict();
  return schema.parse(value);
}

function verifyIdentity(value: unknown): DiscordIdentityReceiptV1 {
  const receipt = discordIdentityReceiptV1Schema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestDiscordIdentityReceiptContentV1(content) !== receiptSha256) {
    throw new Error("Discord identity receipt digest is invalid");
  }
  return receipt;
}

function verifyCanary(value: unknown): VoicetextSemanticCanaryReceiptV1 {
  const receipt = voicetextSemanticCanaryReceiptV1Schema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestVoicetextSemanticCanaryReceiptContentV1(content) !== receiptSha256) {
    throw new Error("Voicetext semantic canary receipt digest is invalid");
  }
  return receipt;
}

function assertEvidenceBindings(
  evidence: Readonly<{ canary: VoicetextSemanticCanaryReceiptV1; clock: HostedClockPreflightReceiptV2;
    deployment: HostedDeploymentSafetyReceiptV1; identity: DiscordIdentityReceiptV1 }>,
  expected: HostedCampaignRemoteAdmissionProbeRequest,
): void {
  const target = HOSTED_CAMPAIGN_TARGET;
  if (evidence.deployment.campaignId !== expected.campaignId
    || evidence.identity.binding.campaignId !== expected.campaignId
    || evidence.canary.binding.campaignId !== expected.campaignId
    || evidence.identity.binding.planSha256 !== expected.planSha256
    || evidence.canary.binding.planSha256 !== expected.planSha256
    || evidence.identity.binding.host !== target.host || evidence.canary.binding.host !== target.host
    || evidence.identity.binding.sourceRevision !== expected.meetingPlatformRevision
    || evidence.canary.binding.sourceRevision !== expected.meetingPlatformRevision
    || JSON.stringify(evidence.identity.target) !== JSON.stringify({
      deploymentScope: target.deploymentScope, environment: target.environment, guildId: target.guildId,
      mutationTarget: target.mutationTarget, publicationChannelId: target.publicationChannelId,
      voiceChannelId: target.voiceChannelId,
    }) || evidence.clock.raw.target.host !== target.host
    || evidence.clock.raw.target.environment !== target.environment || evidence.clock.raw.target.project !== target.project) {
    throw new Error("Hosted remote evidence does not match the exact campaign, plan, target, and deployment");
  }
}

function assertEvidenceLifetimes(
  evidence: Readonly<{ canary: VoicetextSemanticCanaryReceiptV1; clock: HostedClockPreflightReceiptV2;
    deployment: HostedDeploymentSafetyReceiptV1; identity: DiscordIdentityReceiptV1 }>,
  nowEpochMs: number,
): readonly number[] {
  const deploymentAt = Date.parse(evidence.deployment.generatedAt);
  const generated = [deploymentAt, evidence.identity.generatedAtEpochMs,
    evidence.canary.generatedAtEpochMs, evidence.clock.qualifiedAtEpochMs];
  const expirations = [evidence.identity.expiresAtEpochMs, evidence.canary.expiresAtEpochMs,
    evidence.clock.validUntilEpochMs];
  const ttls = [evidence.identity.expiresAtEpochMs - evidence.identity.generatedAtEpochMs,
    evidence.canary.expiresAtEpochMs - evidence.canary.generatedAtEpochMs,
    evidence.clock.validUntilEpochMs - evidence.clock.qualifiedAtEpochMs];
  if (generated.some((time) => !Number.isSafeInteger(time) || time > nowEpochMs + maximumFutureSkewMs
      || nowEpochMs - time > maximumReadinessAgeMs)
    || expirations.some((time) => time <= nowEpochMs)
    || ttls.some((ttl) => ttl < 1 || ttl > maximumReceiptTtlMs)) {
    throw new Error("Hosted remote evidence is stale, expired, too long-lived, or from the future");
  }
  return generated;
}

function reference(receipt: HostedDeploymentSafetyReceiptV1 | DiscordIdentityReceiptV1 |
VoicetextSemanticCanaryReceiptV1) {
  return { kind: receipt.kind, receiptSha256: receipt.receiptSha256, schemaVersion: receipt.schemaVersion };
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(canonicalize); }
  if (typeof value !== "object" || value === null) { return value; }
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}
