import { createHash } from "node:crypto";

import { z } from "zod";

import { serviceLevelThresholdsSchema } from "./e2e-service-levels.js";

const policyContentSchema = z.object({
  approvedAt: z.iso.datetime(),
  kind: z.literal("hosted-voice-latency-policy"),
  owner: z.literal("conversation"),
  policyId: z.literal("hosted-voice-latency"),
  policyVersion: z.literal(1),
  preparedCueFirstPacketMilliseconds: z.literal(750),
  rationale: z.string().min(20).max(512),
  reviewDueAt: z.iso.datetime(),
  schemaVersion: z.literal(1),
  thresholds: serviceLevelThresholdsSchema,
}).strict();

export const hostedVoiceQualificationPolicyV1Schema = policyContentSchema.extend({
  policySha256: z.string().regex(/^[a-f\d]{64}$/u),
}).strict().superRefine((value, context) => {
  const { policySha256, ...content } = value;
  if (digestCanonical(content) !== policySha256) {
    context.addIssue({ code: "custom", message: "Hosted voice latency policy digest is invalid" });
  }
  if (Date.parse(value.reviewDueAt) <= Date.parse(value.approvedAt)) {
    context.addIssue({ code: "custom", message: "Hosted voice latency policy review must follow approval" });
  }
});

const content = Object.freeze({
  approvedAt: "2026-08-13T00:00:00.000Z",
  kind: "hosted-voice-latency-policy" as const,
  owner: "conversation" as const,
  policyId: "hosted-voice-latency" as const,
  policyVersion: 1 as const,
  preparedCueFirstPacketMilliseconds: 750 as const,
  rationale: "Release qualification limits audible response latency and records the exact reviewed limits with every current campaign run.",
  reviewDueAt: "2027-02-13T00:00:00.000Z",
  schemaVersion: 1 as const,
  thresholds: Object.freeze({
    "join-to-greeting-first-packet": 10_000,
    "question-end-to-answer-first-packet": 4_000,
    "recording-end-to-discord-first-seen": 900_000,
  }),
});

export const HOSTED_VOICE_QUALIFICATION_POLICY_V1 = Object.freeze(
  hostedVoiceQualificationPolicyV1Schema.parse({
    ...content,
    policySha256: digestCanonical(content),
  }),
);

export type HostedVoiceQualificationPolicyV1 = z.infer<
  typeof hostedVoiceQualificationPolicyV1Schema
>;

/** External files may restate, but cannot widen, the reviewed compiled values. */
export function admitHostedVoiceQualificationPolicy(
  thresholds: unknown,
): HostedVoiceQualificationPolicyV1 {
  const parsed = serviceLevelThresholdsSchema.parse(thresholds);
  if (JSON.stringify(parsed) !==
    JSON.stringify(HOSTED_VOICE_QUALIFICATION_POLICY_V1.thresholds)) {
    throw new Error("Hosted service-level thresholds do not match the governed voice policy");
  }
  return HOSTED_VOICE_QUALIFICATION_POLICY_V1;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)]));
}
