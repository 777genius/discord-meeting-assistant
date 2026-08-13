import { createHash } from "node:crypto";
import { constants, link, mkdir, open, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import {
  assertConversationVoiceCampaignTarget,
  conversationVoiceCampaignPreflight,
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
    capturePlan: z.literal("addressed-answer"),
    intentDigestSha256: sha256Schema,
    intentObservedAt: z.iso.datetime(),
    kind: z.literal("answer"),
    meetingId: identifierSchema,
    planDigestSha256: sha256Schema,
    playbackAttemptId: identifierSchema,
    protocolVersion: z.literal(1),
    readyPublishedAt: z.iso.datetime(),
    runId: identifierSchema,
    target: campaignTargetSchema,
    turnId: identifierSchema,
    type: z.literal("observer-ready"),
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

export function conversationVoiceCampaignObserverReadyReceipt(input: {
  readonly authenticatedObserverBotId: string;
  readonly meetingId: string;
  readonly plan: ConversationVoiceCampaignProofV1["plan"];
  readonly readyPublishedAt: string;
  readonly runId: string;
  readonly target: ConversationVoiceCampaignProofV1["observerReadyReceipt"]["target"];
}): ConversationVoiceCampaignProofV1["observerReadyReceipt"] {
  const answer = input.plan.captures.find(({ purpose }) => purpose === "addressed-answer");
  if (answer === undefined) {
    throw new Error("Campaign plan has no addressed-answer capture");
  }
  const envelope = {
    capturePlan: "addressed-answer" as const,
    kind: "answer" as const,
    meetingId: input.meetingId,
    playbackAttemptId: answer.resolvedAttemptId,
    protocolVersion: 1 as const,
    runId: input.runId,
    turnId: answer.resolvedTurnId,
  };
  return conversationVoiceCampaignProofV1Schema.shape.observerReadyReceipt.parse({
    ...envelope,
    authenticatedObserverBotId: input.authenticatedObserverBotId,
    intentDigestSha256: createHash("sha256").update(JSON.stringify([
      envelope.protocolVersion, envelope.runId, envelope.meetingId, envelope.turnId,
      envelope.playbackAttemptId, envelope.kind, envelope.capturePlan,
    ])).digest("hex"),
    intentObservedAt: input.readyPublishedAt,
    planDigestSha256: conversationVoiceCampaignPlanDigest(input.plan),
    readyPublishedAt: input.readyPublishedAt,
    target: input.target,
    type: "observer-ready",
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

interface CampaignCaptureInput {
  readonly attemptId?: string;
  readonly expectedDuration: { readonly maximumMilliseconds: number; readonly minimumMilliseconds: number };
  readonly outputPath: string;
  readonly playbackHandshakeRoot?: string;
  readonly purpose: "addressed-answer" | "farewell" | "greeting";
  readonly turnId?: string;
}

export function resolveConversationVoiceCampaignPlan(
  captures: readonly CampaignCaptureInput[],
  intent: { readonly playbackAttemptId: string; readonly turnId: string },
): ConversationVoiceCampaignProofV1["plan"] {
  const preflight = conversationVoiceCampaignPreflight(captures);
  return {
    captures: preflight.captures.map((capture, index) => {
      const source = captures[index]!;
      const isHandshake = source.purpose === "addressed-answer";
      return {
        expectedDuration: capture.expectedDuration,
        ordinal: capture.ordinal,
        outputPath: capture.outputPath,
        purpose: capture.purpose,
        resolvedAttemptId: isHandshake ? intent.playbackAttemptId : source.attemptId!,
        resolvedTurnId: isHandshake ? intent.turnId : source.turnId!,
        role: capture.role,
      };
    }),
    kind: preflight.kind,
    status: preflight.status,
  };
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
  const answer = proof.plan.captures.find(({ purpose }) => purpose === "addressed-answer");
  const receipt = proof.observerReadyReceipt;
  if (answer === undefined || receipt.meetingId.length === 0 ||
    receipt.playbackAttemptId !== answer.resolvedAttemptId ||
    receipt.turnId !== answer.resolvedTurnId) {
    return "observer-ready receipt must bind the exact addressed-answer intent";
  }
  const expectedIntentDigest = createHash("sha256").update(JSON.stringify([
    receipt.protocolVersion, receipt.runId, receipt.meetingId, receipt.turnId,
    receipt.playbackAttemptId, receipt.kind, receipt.capturePlan,
  ])).digest("hex");
  if (receipt.intentDigestSha256 !== expectedIntentDigest) {
    return "observer-ready receipt must bind the content-addressed playback intent";
  }
  const intentObservedAt = Date.parse(receipt.intentObservedAt);
  const readyPublishedAt = Date.parse(receipt.readyPublishedAt);
  if (intentObservedAt > readyPublishedAt) {
    return "observer-ready receipt must be published after the intent was observed";
  }
  const planIssue = campaignPlanIssue(proof.plan);
  if (planIssue !== undefined) {
    return planIssue;
  }
  return campaignCaptureBindingIssue(proof.plan, voice, readyPublishedAt);
}

interface RetainedVoiceCapture {
  readonly capture: {
    readonly expectedDuration: {
      readonly maximumMilliseconds: number;
      readonly minimumMilliseconds: number;
    };
    readonly firstPacketAt: { readonly epochMilliseconds: number };
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
  readyPublishedAt: number,
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
  const answerIndex = plan.captures.findIndex(({ purpose }) => purpose === "addressed-answer");
  if (answerIndex < 0 || readyPublishedAt > voice[answerIndex]!.capture.firstPacketAt.epochMilliseconds) {
    return "observer-ready receipt must be published before addressed-answer audio is observed";
  }
  return undefined;
}

export async function writeCreateOnlyConversationVoiceCampaignProof(
  outputPath: string,
  proof: ConversationVoiceCampaignProofV1,
): Promise<void> {
  const encoded = `${JSON.stringify(conversationVoiceCampaignProofV1Schema.parse(proof), undefined, 2)}\n`;
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
    await handle.close();
    await link(temporaryPath, outputPath);
  } finally {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
  }
}
