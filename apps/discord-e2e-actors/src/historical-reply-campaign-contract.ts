import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedCampaignReleaseReferenceV1Schema } from "./hosted-campaign-release-reference.js";
import {
  historicalReplyPostRestartMutationAdmissionV1Schema,
  historicalReplyRetrievalV2BindingSchema,
  historicalReplyServiceInstanceV1Schema,
} from "./historical-reply-mutation-admission.js";
import { recordingReadyProducerEvidenceV1Schema } from "./recording-ready-producer-evidence.js";
import { historicalReplyProducerBindingsMatch } from "./historical-reply-producer-bindings.js";
import { governedCampaignObservationPolicyV1Schema,
  governedPrivateCampaignObservationV1Schema } from
  "./governed-private-campaign-observation-contract.js";

export {
  createHistoricalReplyPostRestartMutationAdmissionV1,
  historicalReplyPostRestartMutationAdmissionV1Schema,
} from "./historical-reply-mutation-admission.js";

const identifierSchema = z.string().trim().min(1).max(256);
const snowflakeSchema = z.string().regex(/^\d{17,20}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const timestampSchema = z.iso.datetime();

export const HISTORICAL_REPLY_UNSUPPORTED_RESPONSE_V1 =
  "There is not enough confirmed meeting evidence to answer that.";

const historicalAuthorityTurnSchema = z.object({
  endMs: z.number().int().nonnegative(),
  speakerId: identifierSchema,
  startMs: z.number().int().nonnegative(),
  textSha256: sha256Schema,
  turnId: identifierSchema,
}).strict().refine(({ endMs, startMs }) => endMs > startMs, {
  message: "Authoritative turn must end after it starts",
});

const canonicalAuthoritySchema = z.object({
  generation: z.number().int().positive(),
  historicalReleaseId: identifierSchema,
  meetingId: identifierSchema,
  runId: identifierSchema,
  transcriptId: identifierSchema,
  transcriptVersion: z.number().int().positive(),
  turns: z.array(historicalAuthorityTurnSchema).min(1).max(32),
}).strict().refine(
  ({ turns }) => new Set(turns.map(({ turnId }) => turnId)).size === turns.length,
  { message: "Authoritative historical citation turns must be unique", path: ["turns"] },
);

const targetProjectionBaseSchema = z.object({
  channelId: snowflakeSchema,
  meetingId: identifierSchema,
  messageId: snowflakeSchema,
  parentChannelId: snowflakeSchema,
  runId: identifierSchema,
  transcriptId: identifierSchema,
});

const targetProjectionSchema = z.discriminatedUnion("kind", [
  targetProjectionBaseSchema.extend({
    kind: z.literal("final-summary"),
    summaryId: identifierSchema,
  }).strict(),
  targetProjectionBaseSchema.extend({
    kind: z.literal("live-transcript"),
  }).strict(),
]);

export const trustedLifecycleActorSchema = z.object({
  actorId: identifierSchema,
  kind: z.enum(["automation", "human", "unknown"]),
}).strict();
export const trustedLifecycleProvenanceSchema = z.object({
  actorObservationState: z.literal("consistent"),
  actorSemanticsVersion: z.literal(1),
  actors: z.array(trustedLifecycleActorSchema).min(1).max(1_000),
  lifecycleGeneration: z.number().int().min(3),
  producerCapabilityId: z.literal("meeting.lifecycle.sealed-actor-roster.v1"),
  producerRevision: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u),
  rosterState: z.literal("sealed"),
}).strict();

const historicalReplyDurableRehydrationBaseV1Schema = z.object({
  appliedIndexGeneration: identifierSchema,
  appliedIndexProfileId: z.string().trim().min(1).max(1_000),
  appliedReleaseRef: identifierSchema,
  canonicalTurnIds: z.array(identifierSchema).min(1).max(256),
  desiredSourceGeneration: z.number().int().positive(),
  documentMappings: z.array(z.object({
    canonicalTurnIds: z.array(identifierSchema).min(1).max(256),
    documentExternalId: identifierSchema,
    plannedIndexGeneration: identifierSchema,
    plannedProfileId: z.string().trim().min(1).max(1_000),
    remoteDocumentId: identifierSchema,
  }).strict()).min(1).max(256),
  infinityDocumentCount: z.number().int().positive(),
  observedAt: timestampSchema,
  historicalReleaseId: identifierSchema,
  plannedDocumentCount: z.number().int().positive(),
  plannedGeneration: identifierSchema,
  plannedProfileIds: z.array(z.string().trim().min(1).max(1_000)).length(1),
  plannedRoomId: identifierSchema,
  plannedScopeId: identifierSchema,
  profileRebuildRequested: z.literal(false),
  retrievalPath: z.literal("infinity_locator_v2"),
  roomId: identifierSchema,
  scopeId: identifierSchema,
  serviceContainerId: z.string().regex(/^[a-f\d]{64}$/u),
  sourceMeetingId: identifierSchema,
  state: z.literal("applied"),
  transcriptId: identifierSchema,
  transcriptVersion: z.number().int().positive(),
  trustedLifecycle: trustedLifecycleProvenanceSchema,
}).strict();

export const historicalReplyRehydrationProbeOutputV1Schema =
  historicalReplyDurableRehydrationBaseV1Schema.omit({ serviceContainerId: true });

export const historicalReplyDurableRehydrationV1Schema =
  historicalReplyDurableRehydrationBaseV1Schema.superRefine((readiness, context) => {
  const mappings = readiness.documentMappings;
  if (readiness.infinityDocumentCount !== mappings.length ||
    readiness.plannedDocumentCount !== mappings.length ||
    readiness.appliedIndexGeneration !== readiness.plannedGeneration ||
    readiness.appliedIndexProfileId !== readiness.plannedProfileIds[0] ||
    readiness.scopeId !== readiness.plannedScopeId ||
    readiness.roomId !== readiness.plannedRoomId ||
    mappings.some((mapping) =>
      mapping.plannedIndexGeneration !== readiness.appliedIndexGeneration ||
      mapping.plannedProfileId !== readiness.appliedIndexProfileId) ||
    new Set(readiness.canonicalTurnIds).size !== readiness.canonicalTurnIds.length ||
    new Set(readiness.trustedLifecycle.actors.map(({ actorId }) => actorId)).size !==
      readiness.trustedLifecycle.actors.length) {
    context.addIssue({ code: "custom", message: "Applied V2 readiness is internally inconsistent" });
  }
  });

const historicalReplyQuestionSchema = z.object({
  expectedLocale: z.literal("ru"),
  expectedClaims: z.array(z.object({
    citationTurnIds: z.array(identifierSchema).min(1).max(16),
    requiredTerms: z.array(identifierSchema).min(1).max(16),
    text: z.string().trim().min(1).max(2_000),
  }).strict()).min(1).max(16),
  expectedAnswerTerms: z.array(identifierSchema).min(1).max(16),
  expectedCitationTurnIds: z.array(identifierSchema).min(1).max(16),
  text: z.string().trim().min(1).max(1_000),
}).strict();

const unsupportedReplyQuestionSchema = z.object({
  expectedLocale: z.literal("en"),
  expectedResponse: z.literal(HISTORICAL_REPLY_UNSUPPORTED_RESPONSE_V1),
  text: z.string().trim().min(1).max(1_000),
}).strict();

export const historicalReplyCampaignInputV1Schema = z.object({
  campaignId: identifierSchema,
  guildId: snowflakeSchema,
  mutationAdmission: historicalReplyPostRestartMutationAdmissionV1Schema,
  canonicalAuthority: canonicalAuthoritySchema,
  botActorId: identifierSchema,
  intendedActors: z.array(trustedLifecycleActorSchema).min(2).max(1_000),
  observerApplicationId: snowflakeSchema,
  answerQuietWindowMilliseconds: z.number().int().min(1_000).max(30_000),
  observationScope: governedCampaignObservationPolicyV1Schema,
  privateTestGuildConfirmed: z.literal(true),
  questions: z.object({
    supported: historicalReplyQuestionSchema,
    unsupported: unsupportedReplyQuestionSchema,
  }).strict(),
  producerEvidence: recordingReadyProducerEvidenceV1Schema,
  rehydration: historicalReplyDurableRehydrationV1Schema,
  release: hostedCampaignReleaseReferenceV1Schema,
  restart: z.object({
    after: historicalReplyServiceInstanceV1Schema,
    before: historicalReplyServiceInstanceV1Schema,
    readyAt: timestampSchema,
    requestedAt: timestampSchema,
  }).strict(),
  runId: identifierSchema,
  sutApplicationId: snowflakeSchema,
  target: targetProjectionSchema,
  unsupportedTarget: targetProjectionSchema,
// oxlint-disable-next-line complexity
}).strict().superRefine((input, context) => {
  const fail = (message: string, path: readonly PropertyKey[] = []): void => {
    context.addIssue({ code: "custom", message, path: [...path] });
  };
  const beforeStarted = Date.parse(input.restart.before.startedAt);
  const requested = Date.parse(input.restart.requestedAt);
  const afterStarted = Date.parse(input.restart.after.startedAt);
  const rehydrated = Date.parse(input.rehydration.observedAt);
  const ready = Date.parse(input.restart.readyAt);
  const authority = input.canonicalAuthority;
  if (input.observationScope.startedAt !== input.mutationAdmission.issuedAt ||
    input.observationScope.guildId !== input.guildId ||
    !input.observationScope.parentChannelIds.includes(input.target.parentChannelId) ||
    !input.observationScope.parentChannelIds.includes(input.unsupportedTarget.parentChannelId)) {
    fail("Historical targets must belong to the exact canonical governed observation policy");
  }
  if (authority.meetingId !== input.target.meetingId ||
    authority.runId !== input.target.runId ||
    authority.transcriptId !== input.target.transcriptId) {
    fail(
      "Grounding authority must be the same meeting and transcript as the replied-to projection",
    );
  }
  if (input.target.kind === input.unsupportedTarget.kind ||
    input.target.messageId === input.unsupportedTarget.messageId ||
    input.unsupportedTarget.meetingId !== authority.meetingId ||
    input.unsupportedTarget.transcriptId !== authority.transcriptId ||
    input.unsupportedTarget.runId !== authority.runId) {
    fail("Supported and unsupported questions must cover distinct summary and transcript projections");
  }
  if (input.restart.before.containerId === input.restart.after.containerId ||
    input.restart.before.startedAt === input.restart.after.startedAt) {
    fail("Restart proof requires a new service instance");
  }
  if (input.restart.before.imageId !== input.restart.after.imageId ||
    input.restart.before.sourceRevision !== input.restart.after.sourceRevision ||
    input.restart.before.composeConfigHash !== input.restart.after.composeConfigHash ||
    input.restart.before.repositoryDigest !== input.restart.after.repositoryDigest) {
    fail("Restart proof must preserve full immutable Compose and repository provenance");
  }
  if (!(beforeStarted <= requested && requested <= afterStarted &&
    afterStarted <= rehydrated && rehydrated <= ready)) {
    fail("Durable rehydration must settle on the restarted instance before readiness");
  }
  if (input.rehydration.serviceContainerId !== input.restart.after.containerId ||
    input.rehydration.historicalReleaseId !==
      authority.historicalReleaseId) {
    fail("Durable rehydration is bound to another service instance or historical release");
  }
  if (input.rehydration.sourceMeetingId !== authority.meetingId ||
    input.rehydration.transcriptId !== authority.transcriptId ||
    input.rehydration.transcriptVersion !== authority.transcriptVersion ||
    input.rehydration.desiredSourceGeneration !== authority.generation) {
    fail("Durable rehydration is bound to another meeting, transcript, or generation");
  }
  const authorityTurnIds = new Set(authority.turns.map(({ turnId }) => turnId));
  const request = input.mutationAdmission.rollout.retrievalBinding.request;
  if (!historicalReplyProducerBindingsMatch({
    authority, botActorId: input.botActorId, guildId: input.guildId,
    intendedActors: input.intendedActors, producer: input.producerEvidence,
    readiness: input.rehydration.trustedLifecycle,
  }) ||
    request.binding.profileId !== input.rehydration.appliedIndexProfileId ||
    request.scope.memoryScopeId !== input.rehydration.scopeId ||
    request.scope.spaceId !== input.rehydration.roomId ||
    request.filters.sourceGenerations.length !== 1 ||
    request.filters.sourceGenerations.some(({ projectionGeneration, sourceKey }) =>
      projectionGeneration !== input.rehydration.appliedIndexGeneration ||
      sourceKey !== input.rehydration.appliedReleaseRef)) {
    fail("Persisted V2 request and canonical authority must bind the applied trusted source");
  }
  const expected = input.questions.supported.expectedCitationTurnIds;
  if (new Set(expected).size !== expected.length ||
    expected.some((turnId) => !authorityTurnIds.has(turnId))) {
    fail("Supported-answer citations must name unique authoritative historical turns");
  }
  for (const [index, claim] of input.questions.supported.expectedClaims.entries()) {
    if (claim.citationTurnIds.some((turnId) => !authorityTurnIds.has(turnId))) {
      fail("Expected claims must cite authoritative historical turns", [
        "questions", "supported", "expectedClaims", index, "citationTurnIds",
      ]);
    }
  }
  const claimTerms = new Set(input.questions.supported.expectedClaims.flatMap(
    ({ requiredTerms }) => requiredTerms.map((term) => term.toLocaleLowerCase("en-US")),
  ));
  if (input.questions.supported.expectedAnswerTerms.some(
    (term) => !claimTerms.has(term.toLocaleLowerCase("en-US")))) {
    fail("Every expected answer term must be bound to an expected cited claim");
  }
  const admission = input.mutationAdmission;
  if (Date.parse(admission.issuedAt) < Date.parse(input.restart.readyAt) ||
    Date.parse(admission.issuedAt) < Date.parse(input.rehydration.observedAt) ||
    admission.originalCampaign.release.releaseBindingSha256 !==
      input.release.releaseBindingSha256 ||
    JSON.stringify(admission.originalCampaign.release) !== JSON.stringify(input.release) ||
    JSON.stringify(admission.restart.before) !== JSON.stringify(input.restart.before) ||
    JSON.stringify(admission.restart.after) !== JSON.stringify(input.restart.after) ||
    admission.rollout.appliedIndexGeneration !== input.rehydration.appliedIndexGeneration ||
    admission.rollout.appliedIndexProfileId !== input.rehydration.appliedIndexProfileId ||
    admission.rollout.desiredSourceGeneration !== input.rehydration.desiredSourceGeneration ||
    admission.scope.campaignId !== input.campaignId ||
    admission.scope.historicalRunId !== input.runId ||
    admission.scope.targetRunId !== input.target.runId ||
    admission.scope.guildId !== input.guildId ||
    admission.scope.channelId !== input.target.channelId ||
    admission.scope.parentChannelId !== input.target.parentChannelId ||
    admission.scope.messageId !== input.target.messageId ||
    admission.scope.meetingId !== input.target.meetingId ||
    admission.scope.transcriptId !== input.target.transcriptId ||
    admission.scope.unsupportedMessageId !== input.unsupportedTarget.messageId ||
    admission.scope.supportedQuestionSha256 !== sha256(input.questions.supported.text) ||
    admission.scope.unsupportedQuestionSha256 !== sha256(input.questions.unsupported.text)) {
    fail("Post-restart mutation admission is bound to another campaign mutation");
  }
});

const retainedMessageSchema = z.object({
  authorApplicationId: snowflakeSchema,
  channelId: snowflakeSchema,
  createdAt: timestampSchema,
  description: z.string().trim().min(1).max(2_000),
  messageId: snowflakeSchema,
  replyToMessageId: snowflakeSchema,
}).strict();

export const historicalReplyDurableQuestionOutcomeV1Schema = z.object({
  observedAt: timestampSchema,
  outcome: z.enum(["answered", "insufficient_evidence"]),
  questionId: snowflakeSchema,
  serviceContainerId: z.string().regex(/^[a-f\d]{64}$/u),
  state: z.literal("terminal"),
}).strict();

export const historicalReplyDurableQuestionAdmissionV1Schema = z.object({
  attemptId: identifierSchema,
  effectId: identifierSchema,
  groundingPlanSha256: sha256Schema,
  jobGeneration: z.number().int().positive(),
  jobId: snowflakeSchema,
  observedAt: timestampSchema,
  policyEpoch: z.number().int().positive(),
  questionId: snowflakeSchema,
  retrievalBinding: historicalReplyRetrievalV2BindingSchema,
  serviceContainerId: z.string().regex(/^[a-f\d]{64}$/u),
  state: z.literal("ready"),
  workerProtocolEpoch: z.literal(3),
  workerProtocolGeneration: z.number().int().positive(),
}).strict().refine(
  ({ jobGeneration, workerProtocolGeneration }) =>
    jobGeneration === workerProtocolGeneration,
  "Historical reply worker generation must match the durable job generation",
);

export const historicalReplyDurableSettlementV1Schema = z.object({
  attemptId: identifierSchema,
  effectId: identifierSchema,
  externalReceipt: snowflakeSchema,
  groundingPlanSha256: sha256Schema,
  jobId: snowflakeSchema,
  observedAt: timestampSchema,
  serviceContainerId: z.string().regex(/^[a-f\d]{64}$/u),
  serviceHostProcessId: z.number().int().positive(),
}).strict();

export const historicalReplyCrashReceiptV1Schema = z.object({
  campaignId: identifierSchema,
  crashAfterPublicReplyEffect: z.literal(true),
  crashedHostProcessId: z.number().int().positive(),
  crashedWorkerId: identifierSchema,
  effectId: identifierSchema,
  externalReceipt: snowflakeSchema,
  injectionId: identifierSchema,
  schemaVersion: z.literal(1),
  triggeredAt: timestampSchema,
}).strict();

const retainedQuestionSchema = z.object({
  authorApplicationId: snowflakeSchema,
  channelId: snowflakeSchema,
  createdAt: timestampSchema,
  messageId: snowflakeSchema,
  replyToMessageId: snowflakeSchema,
  textSha256: sha256Schema,
}).strict();

const exchangeSchema = z.object({
  answer: retainedMessageSchema,
  citationTurnIds: z.array(identifierSchema).max(32),
  durableAdmission: historicalReplyDurableQuestionAdmissionV1Schema,
  durableOutcome: historicalReplyDurableQuestionOutcomeV1Schema,
  durableSettlement: historicalReplyDurableSettlementV1Schema,
  question: retainedQuestionSchema,
  quietWindow: z.object({
    endedAt: timestampSchema,
    matchingAnswerMessageIds: z.array(snowflakeSchema).length(1),
    startedAt: timestampSchema,
  }).strict(),
}).strict().superRefine((exchange, context) => {
  if (exchange.durableOutcome.questionId !== exchange.question.messageId ||
    exchange.durableAdmission.questionId !== exchange.question.messageId ||
    Date.parse(exchange.durableAdmission.observedAt) > Date.parse(exchange.answer.createdAt) ||
    Date.parse(exchange.durableOutcome.observedAt) < Date.parse(exchange.quietWindow.endedAt)) {
    context.addIssue({
      code: "custom",
      message: "Durable semantic outcome must settle this question after its Discord answer",
    });
  }
  if (exchange.quietWindow.matchingAnswerMessageIds[0] !== exchange.answer.messageId ||
    Date.parse(exchange.quietWindow.startedAt) < Date.parse(exchange.answer.createdAt) ||
    Date.parse(exchange.quietWindow.endedAt) <= Date.parse(exchange.quietWindow.startedAt)) {
    context.addIssue({ code: "custom", message: "Answer quiet-window receipt is invalid" });
  }
});

const retainedTargetObservationSchema = z.object({
  authorApplicationId: snowflakeSchema,
  channelId: snowflakeSchema,
  guildId: snowflakeSchema,
  messageId: snowflakeSchema,
  observedAt: timestampSchema,
  projectionMarker: z.string().regex(/^meeting-projection:[a-f\d]{20}$/u),
  projectionKind: z.enum(["final-summary", "live-transcript"]),
}).strict();

export const historicalReplyCampaignEvidenceV1Schema = z.object({
  campaign: historicalReplyCampaignInputV1Schema,
  crashReceipts: z.array(historicalReplyCrashReceiptV1Schema).length(1),
  exchanges: z.object({
    supported: exchangeSchema.safeExtend({
      citationTurnIds: z.array(identifierSchema).min(1).max(16),
    }).strict(),
    unsupported: exchangeSchema.safeExtend({
      citationTurnIds: z.array(z.never()).length(0),
    }).strict(),
  }).strict(),
  kind: z.literal("discord-historical-reply-qualification"),
  observerAuthenticatedApplicationId: snowflakeSchema,
  privateScopeAnswers: governedPrivateCampaignObservationV1Schema,
  schemaVersion: z.literal(1),
  target: retainedTargetObservationSchema,
  unsupportedTarget: retainedTargetObservationSchema,
}).strict().superRefine((evidence, context) => {
  for (const [name, exchange] of Object.entries(evidence.exchanges)) {
    const duration = Date.parse(exchange.quietWindow.endedAt) -
      Date.parse(exchange.quietWindow.startedAt);
    if (duration < evidence.campaign.answerQuietWindowMilliseconds ||
      duration > evidence.campaign.answerQuietWindowMilliseconds + 10_000) {
      context.addIssue({
        code: "custom",
        message: "Answer quiet window ended before its retained campaign bound",
        path: ["exchanges", name, "quietWindow"],
      });
    }
  }
});

export const historicalReplyLiveReadinessV1Schema = z.object({
  rehydration: historicalReplyDurableRehydrationV1Schema,
  service: historicalReplyServiceInstanceV1Schema,
}).strict();

export function assertHistoricalReplyReadinessMatchesCampaign(
  campaignValue: unknown,
  readinessValue: unknown,
): void {
  const campaign = historicalReplyCampaignInputV1Schema.parse(campaignValue);
  const readiness = historicalReplyLiveReadinessV1Schema.parse(readinessValue);
  const actorKinds = new Map(readiness.rehydration.trustedLifecycle.actors.map(
    ({ actorId, kind }) => [actorId, kind],
  ));
  if (JSON.stringify(readiness.rehydration) !== JSON.stringify(campaign.rehydration) ||
    JSON.stringify(readiness.service) !== JSON.stringify(campaign.restart.after) ||
    JSON.stringify([...readiness.rehydration.trustedLifecycle.actors].toSorted(
      (left, right) => left.actorId.localeCompare(right.actorId) || left.kind.localeCompare(right.kind),
    )) !== JSON.stringify(campaign.producerEvidence.actors) ||
    readiness.rehydration.trustedLifecycle.producerRevision !==
      campaign.producerEvidence.identityProvenance.producerRevision ||
    actorKinds.get(campaign.botActorId) !== "automation" ||
    campaign.canonicalAuthority.turns.some(({ speakerId }) => actorKinds.get(speakerId) !== "human")) {
    throw new Error("Historical V2 readiness does not bind the applied trusted campaign source");
  }
}

export type HistoricalReplyCampaignInputV1 = z.infer<
  typeof historicalReplyCampaignInputV1Schema
>;
export type HistoricalReplyCampaignEvidenceV1 = z.infer<
  typeof historicalReplyCampaignEvidenceV1Schema
>;
export type HistoricalReplyDurableQuestionOutcomeV1 = z.infer<
  typeof historicalReplyDurableQuestionOutcomeV1Schema
>;
export type HistoricalReplyDurableQuestionAdmissionV1 = z.infer<
  typeof historicalReplyDurableQuestionAdmissionV1Schema
>;
export type HistoricalReplyDurableSettlementV1 = z.infer<
  typeof historicalReplyDurableSettlementV1Schema
>;
export type HistoricalReplyCrashReceiptV1 = z.infer<typeof historicalReplyCrashReceiptV1Schema>;
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
