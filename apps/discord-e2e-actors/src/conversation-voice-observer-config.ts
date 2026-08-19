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
const absoluteDirectorySchema = z.string().min(1)
  .refine(isAbsolute, "Expected an absolute directory path")
  .transform(normalize);
const maximumReadyTimeoutMilliseconds = 120_000;
const expectedDurationSchema = z.object({
  maximumMilliseconds: z.number().int().min(20)
    .max(MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS),
  minimumMilliseconds: z.number().int().min(20)
    .max(MAXIMUM_CONVERSATION_VOICE_CAPTURE_DURATION_MILLISECONDS),
}).strict().refine(
  ({ maximumMilliseconds, minimumMilliseconds }) =>
    minimumMilliseconds <= maximumMilliseconds,
  "Expected duration minimum must not exceed maximum",
);
const literalAdditionalCaptureSchema = z.object({
  attemptId: correlationIdSchema,
  expectedDuration: expectedDurationSchema,
  outputPath: absoluteOutputPathSchema,
  purpose: z.enum(["farewell", "greeting"]),
  turnId: correlationIdSchema,
}).strict();
const addressedAdditionalCaptureSchema = z.object({
  expectedDuration: expectedDurationSchema,
  outputPath: absoluteOutputPathSchema,
  playbackHandshakeRoot: absoluteDirectorySchema,
  purpose: z.literal("addressed-answer"),
}).strict();
const additionalCaptureSchema = z.discriminatedUnion("purpose", [
  addressedAdditionalCaptureSchema,
  literalAdditionalCaptureSchema,
]);
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
  DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT: absoluteOutputPathSchema.optional(),
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
  DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT: absoluteDirectorySchema.optional(),
  DISCORD_E2E_HOSTED_CAMPAIGN_ID: correlationIdSchema.optional(),
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
  DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID: correlationIdSchema.optional(),
  DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_ACCOUNT: secretAccountSchema.default("conversation-observer"),
  DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID: snowflakeSchema,
  DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: absoluteOutputPathSchema,
  DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT: absoluteDirectorySchema.optional(),
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
  DISCORD_E2E_CONVERSATION_VOICE_THINKING_CUE_MAX_DURATION_MS: z.coerce.number()
    .int()
    .min(1_000)
    .max(10_000)
    .default(10_000),
  DISCORD_E2E_CONVERSATION_VOICE_TURN_ID: correlationIdSchema,
  DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID: snowflakeSchema,
}).superRefine((value, context) => {
  const isCampaign = (value.DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON?.length ?? 0) > 0;
  if (isCampaign !== (value.DISCORD_E2E_HOSTED_CAMPAIGN_ID !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "A campaign observer requires exactly one hosted campaign ID",
      path: ["DISCORD_E2E_HOSTED_CAMPAIGN_ID"],
    });
  }
  if (isCampaign !== (value.DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "A campaign observer requires exactly one create-only campaign proof output",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT"],
    });
  }
  if (isCampaign !== (value.DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "A campaign observer requires exactly one greeting handshake root",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT"],
    });
  }
  if (!isCampaign && value.DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID === undefined) {
    context.addIssue({
      code: "custom",
      message: "A standalone conversation voice observer requires an explicit meeting ID",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID"],
    });
  }
}).superRefine((value, context) => {
  if ((value.DISCORD_E2E_CONVERSATION_VOICE_PURPOSE === "addressed-answer") !==
    (value.DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "Primary addressed-answer capture requires exactly one playback handshake root",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT"],
    });
  }
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
  for (const [index, capture] of
    (value.DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON ?? []).entries()) {
    if (value.DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS <
      capture.expectedDuration.minimumMilliseconds) {
      context.addIssue({
        code: "custom",
        message: "Capture timeout must allow every capture's expected PCM duration",
        path: ["DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON", index, "expectedDuration"],
      });
    }
    if (value.DISCORD_E2E_CONVERSATION_VOICE_MAX_PCM_BYTES <
      capture.expectedDuration.maximumMilliseconds * PCM_S16LE_STEREO_BYTES_PER_MILLISECOND) {
      context.addIssue({
        code: "custom",
        message: "PCM byte bound must cover every capture's expected duration range",
        path: ["DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON", index, "expectedDuration"],
      });
    }
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
  const literalAttemptIds = captureKeys.flatMap((capture) =>
    "attemptId" in capture ? [capture.attemptId] : []
  );
  if (new Set(literalAttemptIds).size !== literalAttemptIds.length) {
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
  const playbackHandshakeRoots = [
    ...(value.DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT === undefined
      ? []
      : [value.DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT]),
    ...(value.DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON ?? [])
      .flatMap((capture) =>
        capture.purpose === "addressed-answer" ? [capture.playbackHandshakeRoot] : []
      ),
  ];
  if (new Set(playbackHandshakeRoots).size !== playbackHandshakeRoots.length) {
    context.addIssue({
      code: "custom",
      message: "Conversation answer playback handshake roots must be unique",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON"],
    });
  }
  const evidenceOutputPaths = new Set(captureKeys.map(({ outputPath }) => outputPath));
  if (playbackHandshakeRoots.some((path) => evidenceOutputPaths.has(path))) {
    context.addIssue({
      code: "custom",
      message: "Conversation playback handshake roots must be distinct from evidence output paths",
      path: ["DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON"],
    });
  }
});

export type ConversationVoiceObserverCapture = {
  readonly attemptId: string;
  readonly expectedDuration: {
    readonly maximumMilliseconds: number;
    readonly minimumMilliseconds: number;
  };
  readonly outputPath: string;
  readonly purpose: "farewell" | "greeting";
  readonly turnId: string;
} | {
  readonly expectedDuration: {
    readonly maximumMilliseconds: number;
    readonly minimumMilliseconds: number;
  };
  readonly outputPath: string;
  readonly playbackHandshakeRoot: string;
  readonly purpose: "addressed-answer";
};

export interface ConversationVoiceObserverConfig {
  readonly additionalCaptures: readonly ConversationVoiceObserverCapture[];
  readonly attemptId: string;
  readonly captureTimeoutMilliseconds: number;
  readonly campaignProofOutputPath?: string;
  readonly craigBotId: string;
  readonly expectedDurationMilliseconds: number;
  readonly expectedDurationToleranceMilliseconds: number;
  readonly guildId: string;
  readonly greetingHandshakeRoot?: string;
  readonly hostedCampaignId?: string;
  readonly keychainService: string;
  readonly maxPcmBytes: number;
  readonly meetingId?: string;
  readonly maximumThinkingCueDurationMilliseconds: number;
  readonly observerAccount: string;
  readonly observerApplicationId: string;
  readonly outputPath: string;
  readonly playbackHandshakeRoot?: string;
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
          if (capture.purpose === "addressed-answer") {
            return Object.freeze({
              expectedDuration: Object.freeze({ ...capture.expectedDuration }),
              outputPath: capture.outputPath,
              playbackHandshakeRoot: capture.playbackHandshakeRoot,
              purpose: capture.purpose,
            });
          }
          return Object.freeze({
            attemptId: capture.attemptId,
            expectedDuration: Object.freeze({ ...capture.expectedDuration }),
            outputPath: capture.outputPath,
            purpose: capture.purpose,
            turnId: capture.turnId,
          });
        }),
    ),
    attemptId: parsed.DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID,
    captureTimeoutMilliseconds: parsed.DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS,
    ...(parsed.DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT === undefined
      ? {}
      : { campaignProofOutputPath: parsed.DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT }),
    craigBotId: parsed.DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID,
    expectedDurationMilliseconds: parsed.DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS,
    expectedDurationToleranceMilliseconds:
      parsed.DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_TOLERANCE_MS,
    guildId: parsed.DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID,
    ...(parsed.DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT === undefined
      ? {}
      : { greetingHandshakeRoot: parsed.DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT }),
    ...(parsed.DISCORD_E2E_HOSTED_CAMPAIGN_ID === undefined
      ? {}
      : { hostedCampaignId: parsed.DISCORD_E2E_HOSTED_CAMPAIGN_ID }),
    keychainService: parsed.DISCORD_E2E_CONVERSATION_VOICE_KEYCHAIN_SERVICE,
    maxPcmBytes: parsed.DISCORD_E2E_CONVERSATION_VOICE_MAX_PCM_BYTES,
    ...(parsed.DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID === undefined
      ? {}
      : { meetingId: parsed.DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID }),
    maximumThinkingCueDurationMilliseconds:
      parsed.DISCORD_E2E_CONVERSATION_VOICE_THINKING_CUE_MAX_DURATION_MS,
    observerAccount: parsed.DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_ACCOUNT,
    observerApplicationId: parsed.DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID,
    outputPath: parsed.DISCORD_E2E_CONVERSATION_VOICE_OUTPUT,
    ...(parsed.DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT === undefined
      ? {}
      : { playbackHandshakeRoot: parsed.DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT }),
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
      expectedDuration: {
        maximumMilliseconds:
          config.expectedDurationMilliseconds + config.expectedDurationToleranceMilliseconds,
        minimumMilliseconds: config.expectedDurationMilliseconds,
      },
      outputPath: config.outputPath,
      purpose: config.purpose,
      ...(config.purpose === "addressed-answer"
        ? { playbackHandshakeRoot: config.playbackHandshakeRoot! }
        : { attemptId: config.attemptId, turnId: config.turnId }),
    }, ...config.additionalCaptures]);
  }
  return config;
}
