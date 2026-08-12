import { createHash } from "node:crypto";

import { z } from "zod";

import {
  assertConversationVoiceCampaignTarget,
  conversationVoiceCampaignRoles,
} from "./conversation-voice-campaign-contract.js";

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const campaignTargetSchema = z.object({
  craigBotId: identifierSchema,
  guildId: identifierSchema,
  observerApplicationId: identifierSchema,
  voiceChannelId: identifierSchema,
}).strict();
const campaignPreflightSchema = z.object({
  captures: z.array(z.object({
    resolvedAttemptId: identifierSchema,
    resolvedTurnId: identifierSchema,
    expectedDuration: z.object({
      maximumMilliseconds: z.number().int().positive(),
      minimumMilliseconds: z.number().int().positive(),
    }).strict(),
    ordinal: z.number().int().positive(),
    outputPath: identifierSchema,
    purpose: z.enum(["addressed-answer", "farewell", "greeting"]),
    role: identifierSchema,
  }).strict()).length(conversationVoiceCampaignRoles.length),
  kind: z.literal("conversation-voice-campaign-preflight"),
  status: z.literal("validated"),
}).strict();

export const conversationVoiceCampaignProofV1Schema = z.object({
  observerReadyReceipt: z.object({
    authenticatedObserverBotId: identifierSchema,
    observedAt: z.iso.datetime(),
    planDigestSha256: sha256Schema,
    runId: identifierSchema,
    schemaVersion: z.literal(1),
    target: campaignTargetSchema,
  }).strict(),
  plan: campaignPreflightSchema,
  planDigestSha256: sha256Schema,
  schemaVersion: z.literal(1),
}).strict();

export type ConversationVoiceCampaignProofV1 = z.infer<
  typeof conversationVoiceCampaignProofV1Schema
>;

export function conversationVoiceCampaignPlanDigest(
  plan: ConversationVoiceCampaignProofV1["plan"],
): string {
  return createHash("sha256").update(canonicalJson(plan), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).toSorted().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function conversationVoiceCampaignProofIssue(
  proof: Readonly<ConversationVoiceCampaignProofV1>,
  runId: string,
  voice: readonly RetainedVoiceCapture[],
): string | undefined {
  const digest = conversationVoiceCampaignPlanDigest(proof.plan);
  if (proof.planDigestSha256 !== digest || proof.observerReadyReceipt.planDigestSha256 !== digest) {
    return "retained plan and observer-ready receipt must share the computed plan digest";
  }
  if (proof.observerReadyReceipt.runId !== runId) {
    return "observer-ready receipt must reference the retained actor run";
  }
  const target = proof.observerReadyReceipt.target;
  try {
    assertConversationVoiceCampaignTarget(target);
  } catch {
    return "observer-ready receipt must use the pinned private-test target";
  }
  if (proof.observerReadyReceipt.authenticatedObserverBotId !== target.observerApplicationId) {
    return "observer-ready receipt must bind the authenticated observer bot";
  }
  const planIssue = campaignPlanIssue(proof.plan);
  if (planIssue !== undefined) {
    return planIssue;
  }
  return campaignCaptureBindingIssue(proof.plan, voice);
}

interface RetainedVoiceCapture {
  readonly capture: {
    readonly expectedDuration: {
      readonly maximumMilliseconds: number;
      readonly minimumMilliseconds: number;
    };
  };
  readonly correlation: {
    readonly attemptId: string;
    readonly purpose: "addressed-answer" | "farewell" | "greeting";
    readonly turnId: string;
  };
}

function campaignPlanIssue(plan: ConversationVoiceCampaignProofV1["plan"]): string | undefined {
  for (const [index, role] of conversationVoiceCampaignRoles.entries()) {
    const capture = plan.captures[index];
    if (capture?.ordinal !== index + 1 || capture.role !== role.role ||
      capture.purpose !== role.purpose ||
      (role.turnId !== undefined && capture.resolvedTurnId !== role.turnId)) {
      return `retained plan capture ${index + 1} must match ${role.role}`;
    }
    if (capture.expectedDuration.minimumMilliseconds >
      capture.expectedDuration.maximumMilliseconds) {
      return `retained plan capture ${index + 1} has an invalid duration range`;
    }
  }
  return undefined;
}

function campaignCaptureBindingIssue(
  plan: ConversationVoiceCampaignProofV1["plan"],
  voice: readonly RetainedVoiceCapture[],
): string | undefined {
  if (voice.length !== plan.captures.length) {
    return "retained plan must positionally bind every conversation voice capture";
  }
  for (const [index, plannedCapture] of plan.captures.entries()) {
    const retainedCapture = voice[index]!;
    if (
      plannedCapture.resolvedAttemptId !== retainedCapture.correlation.attemptId ||
      plannedCapture.resolvedTurnId !== retainedCapture.correlation.turnId ||
      plannedCapture.purpose !== retainedCapture.correlation.purpose ||
      plannedCapture.expectedDuration.minimumMilliseconds !==
        retainedCapture.capture.expectedDuration.minimumMilliseconds ||
      plannedCapture.expectedDuration.maximumMilliseconds !==
        retainedCapture.capture.expectedDuration.maximumMilliseconds
    ) {
      return `retained plan capture ${index + 1} must positionally bind its conversation voice capture`;
    }
  }
  return undefined;
}
