/* Admission intentionally centralizes local validation and trusted remote receipt binding. */
import { resolve } from "node:path";

import { z } from "zod";

import {
  buildResolvedHostedCampaignPlanV1,
  hostedCampaignDefinitionV1Schema,
  hostedCampaignRuntimeBindingsV1Schema,
} from "./hosted-campaign-plan-builder.js";
import { parseHostedCampaignPlan } from "./hosted-campaign-run-config.js";
import {
  digestCanonical,
  inspectHostedCampaignLocalAdmission,
  isSafeAbsolutePath,
  remoteCapabilitySchema,
  remoteEvidenceSchema,
  secretAccounts,
  sha256Schema,
} from "./hosted-campaign-local-admission.js";
import {
  evaluateHostedRemoteAdmission,
  type HostedCampaignRemoteAdmissionProbe,
  type HostedRemoteReadinessSection,
  hostedRemoteReadinessV1Schema,
  type HostedRemoteReadinessV1,
  verifyHostedRemoteReadinessV1,
} from "./hosted-campaign-remote-admission.js";
import { hostedClockPreflightReceiptV2Schema, type HostedClockPreflightReceiptV2 } from "./hosted-clock-proof-v2.js";

export type HostedCampaignAdmissionReceiptV1 = Readonly<{
  artifactRoot: string;
  bindingsSha256: string;
  campaignId: string;
  definitionSha256: string;
  fixtureDigests: Readonly<Record<string, string>>;
  generatedAt: string;
  kind: "hosted-campaign-admission";
  clockPreflightProof?: HostedClockPreflightReceiptV2 | undefined;
  minimumFreeBytes: number;
  missingCapabilities: readonly HostedRemoteReadinessSection[];
  planSha256: string;
  receiptSha256: string;
  remoteEvidence: readonly Readonly<{
    capability: z.infer<typeof remoteCapabilitySchema>;
    containerGreetingHandshakeRoot?: string;
    greetingHandshakeRoot?: string;
    hostOwnerUid?: number;
    observerParticipantId?: string;
    platformContainerUid?: number;
    path: string;
    sha256: string;
  }>[];
  remoteReadiness?: HostedRemoteReadinessV1 | undefined;
  revisions: Readonly<Record<"craig" | "meetingPlatform" | "pipecat" | "subscriptionRuntime", string>>;
  schemaVersion: 1;
  secretAccountsValidated: typeof secretAccounts;
  status: "admitted" | "blocked";
}>;

export interface HostedCampaignAdmissionRequest {
  readonly bindings: unknown;
  readonly definition: unknown;
  readonly minimumFreeBytes: number;
  readonly plan: unknown;
  readonly remoteAdmissionProbe?: HostedCampaignRemoteAdmissionProbe;
  readonly remoteEvidence?: unknown;
}

export async function inspectHostedCampaignAdmission(
  request: HostedCampaignAdmissionRequest,
  now: () => number = Date.now,
): Promise<HostedCampaignAdmissionReceiptV1> {
  const definition = hostedCampaignDefinitionV1Schema.parse(request.definition);
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(request.bindings);
  const plan = parseHostedCampaignPlan(request.plan);
  const compiledPlan = buildResolvedHostedCampaignPlanV1(definition, bindings);
  if (digestCanonical(plan) !== digestCanonical(compiledPlan)) {
    throw new Error("Hosted admission plan does not match the definition and bindings");
  }
  if (!Number.isSafeInteger(request.minimumFreeBytes) || request.minimumFreeBytes < 1) {
    throw new Error("Hosted admission minimum free bytes must be a positive safe integer");
  }
  const { artifactRoot, fixtureDigests, remoteEvidence } = await inspectHostedCampaignLocalAdmission({
    definition, minimumFreeBytes: request.minimumFreeBytes, plan,
    ...(request.remoteEvidence === undefined ? {} : { remoteEvidence: request.remoteEvidence }),
  });
  // Operator-authored files above are retained declarations only and can never authorize a run.
  // Only the injected consumer-owned probe is a trust boundary.
  const remoteAdmission = await evaluateRemote(request, definition.campaignId, plan, now);
  const generatedAtEpochMs = resolveAdmissionTime(remoteAdmission.readiness, now);
  const missingCapabilities = remoteAdmission.missingSections;
  const content = {
    artifactRoot,
    bindingsSha256: digestCanonical(bindings),
    campaignId: definition.campaignId,
    definitionSha256: digestCanonical(definition),
    fixtureDigests: Object.freeze(fixtureDigests),
    generatedAt: new Date(generatedAtEpochMs).toISOString(),
    kind: "hosted-campaign-admission" as const,
    ...(remoteAdmission.clockPreflightProof === undefined ? {} : {
      clockPreflightProof: remoteAdmission.clockPreflightProof,
    }),
    minimumFreeBytes: request.minimumFreeBytes,
    missingCapabilities: Object.freeze(missingCapabilities),
    planSha256: digestCanonical(plan),
    remoteEvidence: Object.freeze(remoteEvidence),
    ...(remoteAdmission.readiness === undefined ? {} : { remoteReadiness: remoteAdmission.readiness }),
    revisions: Object.freeze({ ...definition.revisions }),
    schemaVersion: 1 as const,
    secretAccountsValidated: secretAccounts,
    status: missingCapabilities.length === 0 ? "admitted" as const : "blocked" as const,
  };
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

export function verifyHostedCampaignAdmissionReceipt(value: unknown): HostedCampaignAdmissionReceiptV1 {
  const receiptSchema = z.object({
    artifactRoot: z.string().refine(isSafeAbsolutePath), campaignId: z.string().min(1),
    bindingsSha256: sha256Schema, definitionSha256: sha256Schema,
    fixtureDigests: z.record(z.string(), sha256Schema), generatedAt: z.iso.datetime(),
    kind: z.literal("hosted-campaign-admission"), minimumFreeBytes: z.number().int().positive(),
    clockPreflightProof: hostedClockPreflightReceiptV2Schema.optional(),
    missingCapabilities: z.array(z.enum(["deploymentSafety", "discordIdentity", "voicetextCanary", "clockPreflight"])),
    planSha256: sha256Schema, receiptSha256: sha256Schema,
    remoteEvidence: remoteEvidenceSchema.shape.capabilities,
    remoteReadiness: hostedRemoteReadinessV1Schema.optional(),
    revisions: z.object({ craig: z.string(), meetingPlatform: z.string(), pipecat: z.string(), subscriptionRuntime: z.string() }).strict(),
    schemaVersion: z.literal(1), secretAccountsValidated: z.array(z.enum(secretAccounts)).length(secretAccounts.length),
    status: z.enum(["admitted", "blocked"]),
  }).strict();
  const receipt = receiptSchema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Hosted campaign admission receipt digest is invalid");
  }
  const expectedStatus = receipt.missingCapabilities.length === 0 ? "admitted" : "blocked";
  if (receipt.status !== expectedStatus) {
    throw new Error("Hosted campaign admission status is inconsistent");
  }
  if (receipt.secretAccountsValidated.some((account, index) => account !== secretAccounts[index])) {
    throw new Error("Hosted campaign admission secret account set is invalid");
  }
  const uniqueMissing = new Set(receipt.missingCapabilities);
  if (uniqueMissing.size !== receipt.missingCapabilities.length) {
    throw new Error("Hosted campaign admission missing readiness sections are invalid");
  }
  if (receipt.status === "admitted" && receipt.remoteReadiness === undefined) {
    throw new Error("Hosted campaign admission has no trusted remote readiness");
  }
  if (receipt.status === "admitted" && receipt.clockPreflightProof === undefined) {
    throw new Error("Hosted campaign admission has no trusted clock preflight proof");
  }
  if (receipt.clockPreflightProof !== undefined && receipt.remoteReadiness?.clockPreflight.proofId
    !== receipt.clockPreflightProof.proofId) {
    throw new Error("Hosted campaign clock preflight proof does not match remote readiness");
  }
  if (receipt.remoteReadiness !== undefined) {
    verifyHostedRemoteReadinessV1(receipt.remoteReadiness);
  }
  return Object.freeze({
    ...receipt,
    ...(receipt.remoteReadiness === undefined ? {} : { remoteReadiness: receipt.remoteReadiness }),
    secretAccountsValidated: secretAccounts,
  });
}

export interface HostedCampaignAdmissionInvocation {
  readonly bindings: unknown;
  readonly definition: unknown;
  readonly maximumAgeMs: number;
  readonly nowEpochMs: number;
  readonly plan: unknown;
  readonly receipt: unknown;
}

export function assertHostedCampaignPlanMatchesDefinitionAndBindings(
  definitionValue: unknown,
  bindingsValue: unknown,
  planValue: unknown,
): ReturnType<typeof parseHostedCampaignPlan> {
  const definition = hostedCampaignDefinitionV1Schema.parse(definitionValue);
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(bindingsValue);
  const plan = parseHostedCampaignPlan(planValue);
  const compiledPlan = buildResolvedHostedCampaignPlanV1(definition, bindings);
  if (digestCanonical(plan) !== digestCanonical(compiledPlan)) {
    throw new Error("Hosted campaign plan does not match the definition and bindings");
  }
  return parseHostedCampaignPlan(compiledPlan);
}

/**
 * Verifies the persisted receipt as immutable audit evidence only. Launch
 * authority is deliberately excluded: the runner must obtain fresh remote
 * authorization after acquiring its campaign lease.
 */
export function assertAdmissionAuditMatchesInvocation(
  invocation: HostedCampaignAdmissionInvocation,
): HostedCampaignAdmissionReceiptV1 {
  return assertAdmissionReceiptBindings(invocation);
}

function assertAdmissionReceiptBindings(
  invocation: HostedCampaignAdmissionInvocation,
): HostedCampaignAdmissionReceiptV1 {
  const receipt = verifyHostedCampaignAdmissionReceipt(invocation.receipt);
  const definition = hostedCampaignDefinitionV1Schema.parse(invocation.definition);
  const bindings = hostedCampaignRuntimeBindingsV1Schema.parse(invocation.bindings);
  const plan = assertHostedCampaignPlanMatchesDefinitionAndBindings(definition, bindings, invocation.plan);
  const generatedAt = Date.parse(receipt.generatedAt);
  if (receipt.status !== "admitted" || receipt.missingCapabilities.length !== 0) {
    throw new Error("Hosted campaign admission is not admitted");
  }
  if (!Number.isSafeInteger(invocation.nowEpochMs) || !Number.isSafeInteger(invocation.maximumAgeMs)
    || invocation.maximumAgeMs < 1 || generatedAt > invocation.nowEpochMs
    || invocation.nowEpochMs - generatedAt > invocation.maximumAgeMs) {
    throw new Error("Hosted campaign admission is stale or from the future");
  }
  const campaignId = plan.runs[0]?.campaignId;
  const artifactRoot = resolve(definition.campaignRoot, definition.campaignId);
  if (receipt.campaignId !== campaignId || receipt.campaignId !== definition.campaignId
    || receipt.artifactRoot !== artifactRoot || receipt.definitionSha256 !== digestCanonical(definition)
    || receipt.bindingsSha256 !== digestCanonical(bindings) || receipt.planSha256 !== digestCanonical(plan)
    || JSON.stringify(receipt.revisions) !== JSON.stringify(definition.revisions)) {
    throw new Error("Hosted campaign admission does not match this invocation");
  }
  return receipt;
}

async function evaluateRemote(
  request: HostedCampaignAdmissionRequest,
  campaignId: string,
  plan: unknown,
  now: () => number,
) {
  return evaluateHostedRemoteAdmission(
    request.remoteAdmissionProbe,
    {
      campaignId, meetingPlatformRevision: hostedCampaignDefinitionV1Schema.parse(request.definition)
        .revisions.meetingPlatform,
      planSha256: digestCanonical(plan),
    },
    now,
  );
}

function resolveAdmissionTime(
  readiness: HostedRemoteReadinessV1 | undefined,
  now: () => number,
): number {
  const generatedAtEpochMs = readiness === undefined ? now() : Date.parse(readiness.probedAt);
  if (!Number.isSafeInteger(generatedAtEpochMs)) {
    throw new Error("Hosted campaign admission clock is invalid");
  }
  return generatedAtEpochMs;
}
