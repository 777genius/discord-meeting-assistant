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
const reconnectSchema = z.object({
  action: z.object({ kind: z.enum(["reconnect-left", "reconnect-ready"]) }).strict(),
  evidence: z.object({
    observedAtEpochMilliseconds: epochMillisecondsSchema,
    participantId: snowflakeSchema,
  }).strict(),
}).strict();
const answerSchema = z.object({
  action: z.object({ kind: z.enum(["answer-intent", "answer-observer-ready"]) }).strict(),
  evidence: z.object({
    observedAtEpochMilliseconds: epochMillisecondsSchema,
    turnId: identifierSchema,
  }).strict(),
}).strict();

export const hostedCampaignProcessEventV1Schema = z.object({
  event: z.union([
    observerSubscribedSchema,
    captureRetainedSchema,
    reconnectSchema,
    answerSchema,
  ]),
  kind: z.literal("hosted-campaign-barrier"),
  runId: identifierSchema,
  schemaVersion: z.literal(1),
}).strict();

export type HostedCampaignProcessEventV1 = z.infer<
  typeof hostedCampaignProcessEventV1Schema
>;

export function serializeHostedCampaignProcessEvent(
  event: HostedCampaignProcessEventV1,
): string {
  return `${JSON.stringify(hostedCampaignProcessEventV1Schema.parse(event))}\n`;
}
