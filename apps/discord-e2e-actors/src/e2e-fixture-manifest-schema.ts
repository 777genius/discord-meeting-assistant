import { z } from "zod";

const identifierSchema = z.string().trim().min(1);
const nonNegativeMillisecondsSchema = z.number().int().nonnegative();
const nonNegativeSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a nonnegative safe integer",
);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);

export const scenarioKindSchema = z.enum(["overlap", "sequential", "reconnect"]);

const fixtureSchema = z.object({
  actorName: identifierSchema, audioPath: identifierSchema,
  audioSha256: sha256Schema, durationMs: z.number().int().positive(),
  fixtureId: identifierSchema, speechStartOffsetMs: nonNegativeSafeIntegerSchema.default(0),
  greetingLocale: z.enum(["en", "ru"]).optional(),
  greetingNameStatus: z.enum(["known", "unknown"]).optional(),
  greetingSpokenToken: identifierSchema.optional(), requiredTerms: z.array(identifierSchema).min(1),
  sourcePath: identifierSchema, sourceSha256: sha256Schema,
  sourceText: identifierSchema, speakerId: identifierSchema,
}).refine(
  ({ durationMs, speechStartOffsetMs }) => speechStartOffsetMs < durationMs,
  { message: "speechStartOffsetMs must be less than durationMs", path: ["speechStartOffsetMs"] },
);

const scenarioSchema = z.object({
  expectOverlap: z.boolean(),
  kind: scenarioKindSchema,
  playbackCountByFixture: z.record(identifierSchema, z.number().int().positive()),
  requireReconnect: z.boolean(),
  speakerBDelayMs: nonNegativeMillisecondsSchema,
});

export const fixtureManifestV1Schema = z.object({
  allowedBotSpeakerIds: z.array(identifierSchema).refine(
    (speakerIds) => new Set(speakerIds).size === speakerIds.length,
    "Allowed bot speaker IDs must be unique",
  ).default([]),
  conversationVoiceExpectation: z.object({
    botSpeakerId: identifierSchema.optional(), guildId: identifierSchema,
    observerApplicationId: identifierSchema,
    observerGreetingLocale: z.enum(["en", "ru"]).optional(),
    voiceChannelId: identifierSchema,
  }).strict().optional(),
  farewellCapturePcmSha256: z.object({ en: sha256Schema, ru: sha256Schema }).strict().optional(),
  farewellExactPhrases: z.object({
    en: z.array(identifierSchema).min(1), ru: z.array(identifierSchema).min(1),
  }).strict().optional(),
  farewellLocaleTerms: z.object({
    en: z.array(identifierSchema).min(1), ru: z.array(identifierSchema).min(1),
  }).strict().optional(),
  greetingLocaleTerms: z.object({
    en: z.array(identifierSchema).min(1), ru: z.array(identifierSchema).min(1),
  }).strict().optional(),
  supplementalVoiceExpectation: z.object({
    answerNonce: identifierSchema,
    applicationId: identifierSchema,
    durationMs: z.number().int().positive().max(60_000),
    farewellLocale: z.enum(["en", "ru"]),
    fixtureSha256: sha256Schema, greetingLocale: z.enum(["en", "ru"]),
    requiredFarewellTerms: z.array(identifierSchema).min(1),
    requiredQuestionTerms: z.array(identifierSchema).min(1),
  }).strict().refine(
    ({ answerNonce, requiredQuestionTerms }) => requiredQuestionTerms.includes(answerNonce),
    {
      message: "The deterministic answer nonce must also be pinned in the question terms",
      path: ["requiredQuestionTerms"],
    },
  ).optional(),
  fixtureSetId: identifierSchema,
  fixtures: z.array(fixtureSchema).min(2),
  locale: identifierSchema,
  summaryExpectations: z.object({
    actionItems: z.array(z.object({
      deadline: identifierSchema.nullable(),
      ownerSpeakerId: identifierSchema,
      requiredTerms: z.array(identifierSchema).min(1),
    })).min(1),
    decisionTerms: z.array(identifierSchema).min(1),
    topicTerms: z.array(identifierSchema).min(1),
  }),
  scenarios: z.array(scenarioSchema).min(1),
  schemaVersion: z.literal(1),
  thresholds: z.object({
    maxCharacterErrorRate: z.number().min(0).max(1),
    maxWordErrorRate: z.number().min(0).max(1),
    timestampToleranceMs: nonNegativeMillisecondsSchema,
  }),
});
