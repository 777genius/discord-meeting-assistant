import {
  providerConversationAnswerSchema,
  providerIncrementalMeetingSummarySchema,
  providerMeetingSummarySchema,
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimePurpose,
  type JsonObject,
  type SubscriptionRuntimeExecutionProfile,
} from "@discord-meeting/subscription-runtime-adapter";
import { z } from "zod";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const warningSchema = z
  .object({
    code: z.string().trim().min(1).max(128),
    safeMessage: z.string().optional(),
  })
  .loose();
const failureSchema = z
  .object({
    code: z.string(),
    safeMessage: z.string().optional(),
    retryable: z.boolean(),
    reconnectRequired: z.boolean(),
    causeCategory: z.string().optional(),
  })
  .loose();
const telemetrySchema = z
  .object({
    usage: z.unknown().optional(),
    cost: z
      .object({ amount: z.number().nonnegative(), currency: z.literal("USD") })
      .optional(),
  })
  .loose()
  .optional();
const cliResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("completed"),
      outputText: z.string(),
      structuredOutput: jsonObjectSchema,
      telemetry: telemetrySchema,
      warnings: z.array(warningSchema).max(100),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      status: z.literal("failed"),
      failure: failureSchema,
      telemetry: telemetrySchema,
      warnings: z.array(warningSchema).max(100),
    })
    .strict(),
]);

export type ParsedCliResult = z.infer<typeof cliResultSchema>;

export function parseCliResult(value: string): ParsedCliResult | undefined {
  try {
    const parsed = cliResultSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function validateStructuredOutput(
  profile: SubscriptionRuntimeExecutionProfile,
  value: unknown,
): JsonObject | undefined {
  const parsed = profile.purpose === subscriptionRuntimePurpose
    ? providerMeetingSummarySchema.safeParse(value)
    : profile.purpose === subscriptionRuntimeConversationPurpose
      ? providerConversationAnswerSchema.safeParse(value)
      : providerIncrementalMeetingSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
