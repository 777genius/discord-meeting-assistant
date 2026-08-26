import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedCampaignReleaseReferenceV1Schema } from
  "./hosted-campaign-release-reference.js";

const identifierSchema = z.string().trim().min(1).max(256);
const snowflakeSchema = z.string().regex(/^\d{17,20}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const timestampSchema = z.iso.datetime();
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const opaqueSchema = z.string().trim().min(1).max(256).refine(
  (value) => !/\p{Cc}/u.test(value),
  "Opaque retrieval values cannot contain control characters",
);
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const weightMicrosSchema = z.number().int().min(100_000).max(10_000_000);
const relativeIntervalSchema = z.object({
  endMs: safeInteger,
  startMs: safeInteger,
}).strict().refine(({ endMs, startMs }) => startMs <= endMs);
const timeIntervalSchema = z.object({
  endAt: timestampSchema,
  startAt: timestampSchema,
}).strict().refine(({ endAt, startAt }) => Date.parse(startAt) <= Date.parse(endAt));
const sortedOpaqueArray = z.array(opaqueSchema).max(100).refine(sortedUniqueUtf8);
const weightedKeysSchema = z.array(z.object({
  key: opaqueSchema,
  weightMicros: weightMicrosSchema,
}).strict()).max(100).refine((values) => sortedUniqueUtf8(values.map(({ key }) => key)));

export const historicalReplyServiceInstanceV1Schema = z.object({
  composeConfigHash: sha256Schema,
  composeProject: z.literal("discord-meeting-assistant"),
  composeService: z.literal("meeting-platform"),
  containerId: z.string().regex(/^[a-f\d]{64}$/u),
  hostProcessId: z.number().int().positive(),
  imageId: z.string().regex(/^sha256:[a-f\d]{64}$/u),
  repositoryDigest: z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u),
  sourceRevision: sourceRevisionSchema,
  startedAt: timestampSchema,
}).strict();

export const historicalReplyRetrievalV2RequestSchema = z.object({
  binding: z.object({
    capabilityFingerprint: sha256Schema,
    contractVersion: z.literal("context-retrieval.v2"),
    indexProfileDigest: sha256Schema,
    profileId: opaqueSchema,
    rankingPolicy: z.literal("weighted_rrf_canonical_preferences.v1"),
    requiredProviderLanes: z.array(opaqueSchema).min(1).max(4).refine(sortedUniqueUtf8),
    serviceRevision: opaqueSchema,
  }).strict(),
  budgets: z.object({
    candidateLimit: z.number().int().min(1).max(1_000),
    deadlineMs: z.number().int().min(1).max(2_000),
    evidenceByteLimit: z.number().int().min(1).max(24_000),
    neighborRadius: z.literal(0),
    responseByteLimit: z.number().int().min(16_384).max(1_048_576),
    resultLimit: z.number().int().min(1).max(50),
  }).strict(),
  filters: z.object({
    actorKeys: sortedOpaqueArray,
    category: opaqueSchema.nullable(),
    documentKeys: sortedOpaqueArray,
    excludedSourceKeys: sortedOpaqueArray,
    kinds: sortedOpaqueArray,
    relativeTimeInterval: relativeIntervalSchema.nullable(),
    sourceGenerations: z.array(z.object({
      projectionGeneration: opaqueSchema,
      sourceKey: opaqueSchema,
    }).strict()).min(1).max(100).refine((values) =>
      sortedUniqueUtf8(values.map(({ sourceKey }) => sourceKey))),
    tagsAll: sortedOpaqueArray,
    tagsAny: sortedOpaqueArray,
    tagsNone: sortedOpaqueArray,
    timeInterval: timeIntervalSchema.nullable(),
  }).strict(),
  queries: z.array(z.object({
    query: z.string().trim().min(1).max(512).refine((query) =>
      new TextEncoder().encode(query).byteLength <= 512 &&
      query.replace(/\s+/gu, " ") === query),
    queryId: opaqueSchema.max(64),
    weightMicros: weightMicrosSchema.optional(),
  }).strict()).min(1).max(6).refine((values) =>
    sortedUniqueUtf8(values.map(({ queryId }) => queryId))),
  schemaVersion: z.literal(2),
  scope: z.object({
    memoryScopeId: opaqueSchema,
    spaceId: opaqueSchema,
    threadId: opaqueSchema.nullable().optional(),
  }).strict(),
  softPreferences: z.object({
    actorPreferences: weightedKeysSchema,
    relativeTimeInterval: relativeIntervalSchema.nullable(),
    sourcePreferences: weightedKeysSchema,
    timeInterval: timeIntervalSchema.nullable(),
    timeWeightMicros: weightMicrosSchema.nullable(),
  }).strict(),
}).strict().superRefine((request, context) => {
  if (request.budgets.resultLimit > request.budgets.candidateLimit) {
    context.addIssue({ code: "custom", message: "result limit exceeds candidate limit" });
  }
  const sourceKeys = request.filters.sourceGenerations.map(({ sourceKey }) => sourceKey);
  if (sourceKeys.some((key) => request.filters.excludedSourceKeys.includes(key)) ||
    request.filters.tagsAll.some((tag) => request.filters.tagsNone.includes(tag))) {
    context.addIssue({ code: "custom", message: "retrieval filter identities overlap" });
  }
  if (request.filters.timeInterval !== null &&
    request.filters.relativeTimeInterval !== null) {
    context.addIssue({ code: "custom", message: "hard filters mix time coordinates" });
  }
  const preferenceCoordinates = Number(request.softPreferences.timeInterval !== null) +
    Number(request.softPreferences.relativeTimeInterval !== null);
  if (preferenceCoordinates > 1 ||
    (preferenceCoordinates === 0) !== (request.softPreferences.timeWeightMicros === null)) {
    context.addIssue({ code: "custom", message: "soft time preference binding is incomplete" });
  }
});

export const historicalReplyRetrievalV2BindingSchema = z.object({
  cutoverEpoch: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/u),
  profileFingerprint: sha256Schema,
  request: historicalReplyRetrievalV2RequestSchema,
  retrievalPath: z.literal("infinity_locator_v2"),
}).strict();

const postRestartMutationAdmissionContentV1Schema = z.object({
  admissionId: identifierSchema,
  expiresAt: timestampSchema,
  freshDiscordIdentity: z.object({
    expiresAt: timestampSchema,
    generatedAt: timestampSchema,
    receiptSha256: sha256Schema,
  }).strict(),
  issuedAt: timestampSchema,
  kind: z.literal("historical-reply-post-restart-mutation-admission"),
  originalCampaign: z.object({
    admissionReceiptSha256: sha256Schema,
    planSha256: sha256Schema,
    release: hostedCampaignReleaseReferenceV1Schema,
  }).strict(),
  restart: z.object({
    after: historicalReplyServiceInstanceV1Schema,
    before: historicalReplyServiceInstanceV1Schema,
  }).strict(),
  rollout: z.object({
    appliedIndexGeneration: opaqueSchema,
    appliedIndexProfileId: z.string().trim().min(1).max(1_000),
    desiredSourceGeneration: z.number().int().positive(),
    jobGeneration: z.number().int().positive(),
    policyEpoch: z.number().int().positive(),
    retrievalBinding: historicalReplyRetrievalV2BindingSchema,
    workerProtocolEpoch: z.literal(3),
    workerProtocolGeneration: z.number().int().positive(),
  }).strict(),
  schemaVersion: z.literal(1),
  scope: z.object({
    campaignId: identifierSchema,
    channelId: snowflakeSchema,
    evidenceOutputPathSha256: sha256Schema,
    guildId: snowflakeSchema,
    historicalRunId: identifierSchema,
    meetingId: identifierSchema,
    messageId: snowflakeSchema,
    parentChannelId: snowflakeSchema,
    supportedQuestionSha256: sha256Schema,
    targetRunId: identifierSchema,
    transcriptId: identifierSchema,
    unsupportedMessageId: snowflakeSchema,
    unsupportedQuestionSha256: sha256Schema,
  }).strict(),
}).strict().superRefine((admission, context) => {
  const issuedAt = Date.parse(admission.issuedAt);
  const expiresAt = Date.parse(admission.expiresAt);
  if (admission.restart.before.containerId === admission.restart.after.containerId ||
    issuedAt < Date.parse(admission.restart.after.startedAt) ||
    issuedAt < Date.parse(admission.freshDiscordIdentity.generatedAt) ||
    expiresAt > Date.parse(admission.freshDiscordIdentity.expiresAt) ||
    expiresAt <= issuedAt) {
    context.addIssue({
      code: "custom",
      message: "Post-restart mutation admission has stale or inconsistent provenance",
    });
  }
  if (admission.rollout.jobGeneration !== admission.rollout.workerProtocolGeneration) {
    context.addIssue({
      code: "custom",
      message: "Post-restart mutation admission generations are inconsistent",
    });
  }
});

export const historicalReplyPostRestartMutationAdmissionV1Schema =
  postRestartMutationAdmissionContentV1Schema.safeExtend({
    receiptSha256: sha256Schema,
  }).strict().superRefine((admission, context) => {
    const { receiptSha256, ...content } = admission;
    if (digestPostRestartMutationAdmissionV1(content) !== receiptSha256) {
      context.addIssue({
        code: "custom",
        message: "Post-restart mutation admission digest is invalid",
      });
    }
  });

export type HistoricalReplyPostRestartMutationAdmissionV1 = z.infer<
  typeof historicalReplyPostRestartMutationAdmissionV1Schema
>;

export function createHistoricalReplyPostRestartMutationAdmissionV1(
  content: z.input<typeof postRestartMutationAdmissionContentV1Schema>,
): HistoricalReplyPostRestartMutationAdmissionV1 {
  const parsed = postRestartMutationAdmissionContentV1Schema.parse(content);
  return historicalReplyPostRestartMutationAdmissionV1Schema.parse({
    ...parsed,
    receiptSha256: digestPostRestartMutationAdmissionV1(parsed),
  });
}

function digestPostRestartMutationAdmissionV1(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(canonicalize); }
  if (typeof value !== "object" || value === null) { return value; }
  return Object.fromEntries(Object.entries(value)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}

function sortedUniqueUtf8(values: readonly string[]): boolean {
  const encoder = new TextEncoder();
  const compare = (left: string, right: string): number => {
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const length = Math.min(leftBytes.length, rightBytes.length);
    for (let index = 0; index < length; index += 1) {
      const difference = leftBytes[index]! - rightBytes[index]!;
      if (difference !== 0) { return difference; }
    }
    return leftBytes.length - rightBytes.length;
  };
  return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) < 0);
}
