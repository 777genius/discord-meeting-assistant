import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

import {
  MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS,
  MAXIMUM_CONVERSATION_VOICE_PCM_BYTES,
  PCM_S16LE_STEREO_BYTES_PER_MILLISECOND,
} from "./conversation-voice-observer.js";
import {
  assertConversationVoiceCampaignPlan,
  assertConversationVoiceCampaignTarget,
} from
  "./conversation-voice-campaign-contract.js";

const snowflakeSchema = z.string().regex(/^\d{17,20}$/u, "Expected a Discord snowflake");
const correlationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const secretAccountSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/u);
const absoluteOutputPathSchema = z.string()
  .min(1)
  .refine(
    (value) => isAbsolute(value) && normalize(value) !== "/",
    "Expected an absolute output file path",
  )
  .transform(normalize);
const absoluteDirectorySchema = z.string().min(1).refine(isAbsolute, "Expected an absolute directory path");
const maximumReadyTimeoutMilliseconds = 120_000;
const additionalCaptureSchema = z.object({
  attemptId: correlationIdSchema,
  outputPath: absoluteOutputPathSchema,
  purpose: z.enum(["addressed-answer", "farewell", "greeting"]),
  turnId: correlationIdSchema.optional(),
  turnIdFile: absoluteOutputPathSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.turnId === undefined) === (value.turnIdFile === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Expected exactly one of turnId or turnIdFile",
      path: ["turnId"],
    });
  }
});
const additionalCapturesJsonSchema = z.string().max(32_768).transform((value, context) => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue({ code: "custom", message: "Expected valid JSON capture sequence" });
    return z.NEVER;
  }
}).pipe(z.array(additionalCaptureSchema).max(15));

const environmentSchema = z.object({
  DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID: correlationIdSchema,
  DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: additionalCapturesJsonSchema.optional(),
  DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS: z.coerce.number()
    .int()
    .min(1_000)
    .max(MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS)
    .default(MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS),
  DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID: snowflakeSchema,
  DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: z.coerce.number()
    .int()
    .min(20)
    .max(MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS),
  DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_TOLERANCE_MS: z.coerce.number()
    .int()
    .min(0)
    .max(5_000)
    .default(500),
  DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID: snowflakeSchema,
  DISCORD_E2E_CONVERSATION_VOICE_KEYCHAIN_SERVICE: z.string()
    .trim()
    .min(1)
    .default("discord-voice-bot-e2e"),
  DISCORD_E2E_CONVERSATION_VOICE_MAX_PCM_BYTES: z.coerce.number()
    .int()
    .min(4)
    .max(MAXIMUM_CONVERSATION_VOICE_PCM_BYTES)
    .refine((value) => value % 4 === 0, "Expected a complete PCM frame bound")
    .default(MAXIMUM_CONVERSATION_VOICE_PCM_BYTES),
  DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_ACCOUNT: secretAccountSchema.default("conversation-observer"),
  DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID: snowflakeSchema,
  DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: absoluteOutputPathSchema,
  DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD: z.literal("private-test-guild"),
  DISCORD_E2E_CONVERSATION_VOICE_PURPOSE: z.enum(["addressed-answer", "farewell", "greeting"]),
  DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS: z.coerce.number()
    .int()
    .min(1_000)
    .max(maximumReadyTimeoutMilliseconds)
    .optional(),
  DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID: correlationIdSchema.optional(),
  DISCORD_E2E_CONVERSATION_VOICE_RUN_ID: correlationIdSchema,
  DISCORD_E2E_CONVERSATION_VOICE_SECRET_DIRECTORY: absoluteDirectorySchema.optional(),
  DISCORD_E2E_CONVERSATION_VOICE_TURN_ID: correlationIdSchema,
  DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID: snowflakeSchema,
}).superRefine((value, context) => {
  const expectedMaximumDurationMilliseconds = value.DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS +
    value.DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_TOLERANCE_MS;
  if (expectedMaximumDurationMilliseconds > MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS) {
    context.addIssue({
      code: "custom",
      message: "Expected duration plus tolerance must not exceed the sixty-second PCM capture bound",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_TOLERANCE_MS"],
    });
  }
  if (value.DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS <
    value.DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS) {
    context.addIssue({
      code: "custom",
      message: "Capture timeout must allow the expected PCM duration",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS"],
    });
  }
  if (value.DISCORD_E2E_CONVERSATION_VOICE_MAX_PCM_BYTES <
    expectedMaximumDurationMilliseconds * PCM_S16LE_STEREO_BYTES_PER_MILLISECOND) {
    context.addIssue({
      code: "custom",
      message: "PCM byte bound must cover the full expected duration range",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_MAX_PCM_BYTES"],
    });
  }
  if (value.DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID ===
    value.DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID) {
    context.addIssue({
      code: "custom",
      message: "Observer and Craig bot IDs must be distinct",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID"],
    });
  }
  const captureKeys = [
    {
      attemptId: value.DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID,
      outputPath: value.DISCORD_E2E_CONVERSATION_VOICE_OUTPUT,
    },
    ...(value.DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON ?? []),
  ];
  if (new Set(captureKeys.map(({ attemptId }) => attemptId)).size !== captureKeys.length) {
    context.addIssue({
      code: "custom",
      message: "Conversation voice capture attempt IDs must be unique",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON"],
    });
  }
  if (new Set(captureKeys.map(({ outputPath }) => outputPath)).size !== captureKeys.length) {
    context.addIssue({
      code: "custom",
      message: "Conversation voice capture output paths must be unique",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON"],
    });
  }
  const turnIdFiles = (value.DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON ?? [])
    .flatMap((capture) => capture.turnIdFile === undefined ? [] : [capture.turnIdFile]);
  if (new Set(turnIdFiles).size !== turnIdFiles.length) {
    context.addIssue({
      code: "custom",
      message: "Conversation voice capture turn ID file paths must be unique",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON"],
    });
  }
  const evidenceOutputPaths = new Set(captureKeys.map(({ outputPath }) => outputPath));
  if (turnIdFiles.some((path) => evidenceOutputPaths.has(path))) {
    context.addIssue({
      code: "custom",
      message: "Conversation voice turn ID files must be distinct from evidence output paths",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON"],
    });
  }
});

type ConversationVoiceObserverCapture = {
  readonly attemptId: string;
  readonly outputPath: string;
  readonly purpose: "addressed-answer" | "farewell" | "greeting";
  readonly turnId: string;
  readonly turnIdFile?: never;
} | {
  readonly attemptId: string;
  readonly outputPath: string;
  readonly purpose: "addressed-answer" | "farewell" | "greeting";
  readonly turnId?: never;
  readonly turnIdFile: string;
};

export interface ConversationVoiceObserverConfig {
  readonly additionalCaptures: readonly ConversationVoiceObserverCapture[];
  readonly attemptId: string;
  readonly captureTimeoutMilliseconds: number;
  readonly craigBotId: string;
  readonly expectedDurationMilliseconds: number;
  readonly expectedDurationToleranceMilliseconds: number;
  readonly guildId: string;
  readonly keychainService: string;
  readonly maxPcmBytes: number;
  readonly observerAccount: string;
  readonly observerApplicationId: string;
  readonly outputPath: string;
  readonly privateTestGuildConfirmed: true;
  readonly purpose: "addressed-answer" | "farewell" | "greeting";
  readonly readyTimeoutMilliseconds: number;
  readonly recordingId: string | null;
  readonly runId: string;
  readonly secretDirectory: string | undefined;
  readonly turnId: string;
  readonly voiceChannelId: string;
}

export function loadConversationVoiceObserverConfig(
  environment: NodeJS.ProcessEnv,
): ConversationVoiceObserverConfig {
  if (Object.keys(environment).some((key) =>
    key.startsWith("DISCORD_E2E_CONVERSATION_VOICE_") && key.includes("TOKEN")
  )) {
    throw new Error("Conversation voice observer does not accept bot tokens through environment variables");
  }
  const parsed = environmentSchema.parse(environment);
  const config = Object.freeze({
    additionalCaptures: Object.freeze(
      (parsed.DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON ?? [])
        .map((capture): ConversationVoiceObserverCapture => {
          const common = {
            attemptId: capture.attemptId,
            outputPath: capture.outputPath,
            purpose: capture.purpose,
          } as const;
          if (capture.turnId !== undefined) {
            return Object.freeze({ ...common, turnId: capture.turnId });
          }
          if (capture.turnIdFile !== undefined) {
            return Object.freeze({ ...common, turnIdFile: capture.turnIdFile });
          }
          throw new Error("Expected one conversation voice turn ID source");
        }),
    ),
    attemptId: parsed.DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID,
    captureTimeoutMilliseconds: parsed.DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS,
    craigBotId: parsed.DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID,
    expectedDurationMilliseconds: parsed.DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS,
    expectedDurationToleranceMilliseconds:
      parsed.DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_TOLERANCE_MS,
    guildId: parsed.DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID,
    keychainService: parsed.DISCORD_E2E_CONVERSATION_VOICE_KEYCHAIN_SERVICE,
    maxPcmBytes: parsed.DISCORD_E2E_CONVERSATION_VOICE_MAX_PCM_BYTES,
    observerAccount: parsed.DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_ACCOUNT,
    observerApplicationId: parsed.DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID,
    outputPath: parsed.DISCORD_E2E_CONVERSATION_VOICE_OUTPUT,
    privateTestGuildConfirmed: true,
    purpose: parsed.DISCORD_E2E_CONVERSATION_VOICE_PURPOSE,
    readyTimeoutMilliseconds:
      parsed.DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS ??
      parsed.DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS,
    recordingId: parsed.DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID ?? null,
    runId: parsed.DISCORD_E2E_CONVERSATION_VOICE_RUN_ID,
    secretDirectory: parsed.DISCORD_E2E_CONVERSATION_VOICE_SECRET_DIRECTORY,
    turnId: parsed.DISCORD_E2E_CONVERSATION_VOICE_TURN_ID,
    voiceChannelId: parsed.DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID,
  });
  if (config.additionalCaptures.length > 0) {
    assertConversationVoiceCampaignTarget(config);
    assertConversationVoiceCampaignPlan([{
      attemptId: config.attemptId,
      outputPath: config.outputPath,
      purpose: config.purpose,
      turnId: config.turnId,
    }, ...config.additionalCaptures]);
  }
  return config;
}
