import { isAbsolute } from "node:path";

import { z } from "zod";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const snowflakeSchema = z.string().regex(/^\d{17,20}$/u);
const epochMillisecondsSchema = z.number().int().safe().positive();

const observerSubscribedSchema = z.object({
  action: z.object({ kind: z.literal("observer-subscribed") }).strict(),
  evidence: z.object({ authenticatedObserverBotId: snowflakeSchema }).strict(),
}).strict();
const captureRetainedSchema = z.object({
  action: z.object({
    kind: z.literal("capture-retained"),
    ordinal: z.number().int().min(1).max(6),
  }).strict(),
  evidence: z.object({
    ordinal: z.number().int().min(1).max(6),
    outputPath: z.string().refine(isAbsolute),
    retained: z.literal(true),
  }).strict(),
}).strict().refine(
  ({ action, evidence }) => action.ordinal === evidence.ordinal,
  "Capture action and evidence ordinals must match",
);
const reconnectEvidenceSchema = z.object({
  observedAtEpochMilliseconds: epochMillisecondsSchema,
  participantId: snowflakeSchema,
}).strict();
const reconnectLeftSchema = z.object({
  action: z.object({ kind: z.literal("reconnect-left") }).strict(),
  evidence: reconnectEvidenceSchema,
}).strict();
const reconnectReadySchema = z.object({
  action: z.object({ kind: z.literal("reconnect-ready") }).strict(),
  evidence: reconnectEvidenceSchema,
}).strict();
const turnEvidenceSchema = z.object({
  observedAtEpochMilliseconds: epochMillisecondsSchema,
  turnId: identifierSchema,
}).strict();
const answerIntentSchema = z.object({
  action: z.object({ kind: z.literal("answer-intent") }).strict(),
  evidence: turnEvidenceSchema,
}).strict();
const answerObserverReadySchema = z.object({
  action: z.object({ kind: z.literal("answer-observer-ready") }).strict(),
  evidence: turnEvidenceSchema,
}).strict();

export const hostedCampaignProcessEventV1Schema = z.object({
  campaignId: identifierSchema,
  event: z.union([
    observerSubscribedSchema, captureRetainedSchema, reconnectLeftSchema,
    reconnectReadySchema, answerIntentSchema, answerObserverReadySchema,
  ]),
  kind: z.literal("hosted-campaign-barrier"),
  runId: identifierSchema,
  schemaVersion: z.literal(1),
}).strict();

export type HostedCampaignProcessEventV1 = z.infer<
  typeof hostedCampaignProcessEventV1Schema
>;

export const hostedCampaignProcessEventPrefix = "HOSTED_CAMPAIGN_EVENT_V1 " as const;

export function serializeHostedCampaignProcessEvent(
  event: HostedCampaignProcessEventV1,
): string {
  return `${hostedCampaignProcessEventPrefix}${JSON.stringify(
    hostedCampaignProcessEventV1Schema.parse(event),
  )}\n`;
}
