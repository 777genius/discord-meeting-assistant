import { z } from "zod";

import { hostedCampaignReleaseReferenceV1Schema } from
  "./hosted-campaign-release-reference.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const snowflake = z.string().regex(/^\d{17,20}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const timestamp = z.iso.datetime();

export const PRIVATE_CAMPAIGN_SCENARIOS = Object.freeze([
  "supported-summary-ru-canonical-alias",
  "supported-transcript-en-no-name",
  "supported-transcript-mixed",
  "unsupported-grounded-abstention",
  "stale-replaced-projection",
  "deleted-projection",
  "deleted-question",
  "authorization-loss-after-admission",
  "discord-permission-loss-after-admission",
  "duplicate-gateway-question-event",
  "crash-before-provider-send",
  "crash-after-provider-response",
  "crash-after-discord-create",
  "ambiguous-provider-outcome",
] as const);

const scenarioName = z.enum(PRIVATE_CAMPAIGN_SCENARIOS);
const admittedScenarios = new Set<(typeof PRIVATE_CAMPAIGN_SCENARIOS)[number]>([
  "supported-summary-ru-canonical-alias",
  "supported-transcript-en-no-name",
  "supported-transcript-mixed",
  "unsupported-grounded-abstention",
  "duplicate-gateway-question-event",
  "crash-before-provider-send",
  "crash-after-provider-response",
  "crash-after-discord-create",
  "ambiguous-provider-outcome",
]);
const supportedScenarios = new Set<(typeof PRIVATE_CAMPAIGN_SCENARIOS)[number]>([
  "supported-summary-ru-canonical-alias",
  "supported-transcript-en-no-name",
  "supported-transcript-mixed",
]);
const zeroEffectScenarios = new Set<(typeof PRIVATE_CAMPAIGN_SCENARIOS)[number]>([
  "stale-replaced-projection",
  "deleted-projection",
  "deleted-question",
  "authorization-loss-after-admission",
  "discord-permission-loss-after-admission",
]);

const identitySchema = z.object({
  actorId: snowflake,
  effectId: identifier,
  generation: z.number().int().positive(),
  questionId: snowflake,
  runId: identifier,
  scenarioId: identifier,
}).strict();

const durableReceiptSchema = z.object({
  answerMessageId: snowflake.nullable(),
  attemptId: identifier,
  effectId: identifier,
  effectState: z.enum(["absent", "delivered", "outcome_unknown", "retracted"]),
  externalReceipt: snowflake.nullable(),
  generation: z.number().int().positive(),
  jobId: identifier,
  observedAt: timestamp,
  providerRequestCount: z.number().int().min(0).max(1),
  providerResponseCount: z.number().int().min(0).max(1),
  publicationCreateCount: z.number().int().min(0).max(1),
  reconciliationCount: z.number().int().min(0).max(16),
}).strict();

const questionScenarioSchema = z.object({
  abstained: z.boolean(),
  admitted: z.boolean(),
  citations: z.array(identifier).max(32),
  duplicateIngressCount: z.number().int().min(0).max(2),
  identity: identitySchema,
  locale: z.enum(["en", "mixed", "ru"]),
  participantReference: z.enum(["canonical-real-name-alias", "none"]),
  policyFence: z.object({
    authorizationEpochAtAdmission: z.number().int().positive(),
    authorizationEpochAtEffect: z.number().int().positive(),
    discordPermissionEpochAtAdmission: z.number().int().positive(),
    discordPermissionEpochAtEffect: z.number().int().positive(),
  }).strict(),
  projection: z.enum(["final-summary", "transcript-projection"]),
  projectionIdentity: z.object({
    admittedGeneration: z.number().int().positive(),
    messageId: snowflake,
    observedGeneration: z.number().int().positive(),
    stateAtEffect: z.enum(["current", "deleted", "replaced"]),
  }).strict(),
  questionStateAtEffect: z.enum(["current", "deleted"]),
  receipt: durableReceiptSchema,
  recovery: z.object({
    crashedWorkerId: identifier,
    injectionId: identifier,
    replacementWorkerId: identifier,
    stage: z.enum([
      "after-discord-create-before-completion", "after-provider-response-before-reservation",
      "before-provider-send", "provider-outcome-unknown",
    ]),
  }).strict().nullable(),
  rejectionReason: z.enum([
    "authorization_lost", "discord_permission_lost", "projection_deleted",
    "projection_replaced", "question_deleted",
  ]).nullable(),
  scenario: scenarioName,
  sourceGeneration: z.number().int().positive(),
  transcriptTurnIds: z.array(identifier).max(32),
}).strict()
// oxlint-disable-next-line complexity
.superRefine((result, context) => {
  const expectedAdmitted = admittedScenarios.has(result.scenario);
  const expectedCreates = expectedAdmitted ? 1 : 0;
  const receipt = result.receipt;
  if (result.identity.scenarioId !== result.scenario || result.admitted !== expectedAdmitted ||
    result.identity.effectId !== receipt.effectId ||
    result.identity.generation !== receipt.generation ||
    result.sourceGeneration !== result.identity.generation ||
    receipt.publicationCreateCount !== expectedCreates ||
    (expectedCreates === 1) !== (receipt.answerMessageId !== null) ||
    receipt.answerMessageId !== receipt.externalReceipt) {
    context.addIssue({ code: "custom", message: "Question scenario identity or exactly-once effect is inconsistent" });
  }
  if (supportedScenarios.has(result.scenario) &&
    (result.abstained || result.citations.length === 0 || result.transcriptTurnIds.length === 0)) {
    context.addIssue({ code: "custom", message: "Supported scenario requires authoritative transcript citations" });
  }
  if (result.scenario === "unsupported-grounded-abstention" &&
    (!result.abstained || result.citations.length !== 0 || result.transcriptTurnIds.length !== 0)) {
    context.addIssue({ code: "custom", message: "Unsupported scenario requires a citation-free grounded abstention" });
  }
  if (zeroEffectScenarios.has(result.scenario) &&
    (result.rejectionReason === null || receipt.effectState !== "absent" ||
      receipt.providerRequestCount !== 0)) {
    context.addIssue({ code: "custom", message: "Withdrawn authority must reject before provider and publication" });
  }
  if (result.scenario === "duplicate-gateway-question-event" && result.duplicateIngressCount !== 2) {
    context.addIssue({ code: "custom", message: "Duplicate gateway scenario must retain both ingress deliveries" });
  }
  const expectedRecoveryStage = result.scenario === "crash-before-provider-send"
    ? "before-provider-send"
    : result.scenario === "crash-after-provider-response"
      ? "after-provider-response-before-reservation"
      : result.scenario === "crash-after-discord-create"
        ? "after-discord-create-before-completion"
        : result.scenario === "ambiguous-provider-outcome" ? "provider-outcome-unknown" : null;
  if ((expectedRecoveryStage === null) !== (result.recovery === null) ||
    (result.recovery !== null && (result.recovery.stage !== expectedRecoveryStage ||
      result.recovery.crashedWorkerId === result.recovery.replacementWorkerId ||
      result.recovery.injectionId !== `${result.scenario}:${result.identity.questionId}`))) {
    context.addIssue({ code: "custom", message: "Recovery scenario lacks its deterministic stage and worker fence" });
  }
  if (result.scenario === "stale-replaced-projection" &&
    (result.projectionIdentity.stateAtEffect !== "replaced" ||
      result.projectionIdentity.observedGeneration <= result.projectionIdentity.admittedGeneration)) {
    context.addIssue({ code: "custom", message: "Replaced projection must retain a newer observed generation" });
  }
  if (result.scenario === "deleted-projection" && result.projectionIdentity.stateAtEffect !== "deleted") {
    context.addIssue({ code: "custom", message: "Deleted projection scenario must retain deletion" });
  }
  if (result.scenario === "deleted-question" && result.questionStateAtEffect !== "deleted") {
    context.addIssue({ code: "custom", message: "Deleted question scenario must retain deletion" });
  }
  if (result.scenario === "authorization-loss-after-admission" &&
    result.policyFence.authorizationEpochAtEffect <= result.policyFence.authorizationEpochAtAdmission) {
    context.addIssue({ code: "custom", message: "Authorization loss must cross a newer policy epoch" });
  }
  if (result.scenario === "discord-permission-loss-after-admission" &&
    result.policyFence.discordPermissionEpochAtEffect <=
      result.policyFence.discordPermissionEpochAtAdmission) {
    context.addIssue({ code: "custom", message: "Discord permission loss must cross a newer permission epoch" });
  }
  if (!zeroEffectScenarios.has(result.scenario) &&
    (result.projectionIdentity.stateAtEffect !== "current" ||
      result.projectionIdentity.observedGeneration !== result.projectionIdentity.admittedGeneration ||
      result.questionStateAtEffect !== "current" ||
      result.policyFence.authorizationEpochAtEffect !==
        result.policyFence.authorizationEpochAtAdmission ||
      result.policyFence.discordPermissionEpochAtEffect !==
        result.policyFence.discordPermissionEpochAtAdmission)) {
    context.addIssue({ code: "custom", message: "Admitted scenario crossed a projection or policy fence" });
  }
  if (result.scenario === "crash-before-provider-send" &&
    (receipt.providerRequestCount !== 1 || receipt.providerResponseCount !== 1 ||
      receipt.reconciliationCount < 1)) {
    context.addIssue({ code: "custom", message: "Pre-provider crash must recover the stable attempt exactly once" });
  }
  if (result.scenario === "crash-after-provider-response" &&
    (receipt.providerRequestCount !== 1 || receipt.providerResponseCount !== 1 ||
      receipt.reconciliationCount < 1)) {
    context.addIssue({ code: "custom", message: "Post-provider crash must reuse the durable provider response" });
  }
  if (result.scenario === "crash-after-discord-create" &&
    (receipt.effectState !== "delivered" || receipt.reconciliationCount < 1)) {
    context.addIssue({ code: "custom", message: "Post-create crash must reconcile the existing Discord receipt" });
  }
  if (result.scenario === "ambiguous-provider-outcome" &&
    (receipt.providerRequestCount !== 1 || receipt.reconciliationCount < 1 ||
      receipt.effectState !== "delivered")) {
    context.addIssue({ code: "custom", message: "Ambiguous provider outcome must reconcile without a blind repeat" });
  }
});

const finalizedTurnSchema = z.object({
  acceptedAt: timestamp,
  availableAt: timestamp,
  generation: z.number().int().positive(),
  identityGeneration: z.number().int().positive(),
  interim: z.literal(false),
  canonicalRowCount: z.literal(1),
  ingressEventCount: z.number().int().min(1).max(2),
  locale: z.enum(["en", "mixed", "ru"]),
  source: z.literal("human-final"),
  speakerId: snowflake,
  supersedesTurnId: identifier.nullable(),
  turnId: identifier,
}).strict().refine((turn) =>
  Date.parse(turn.availableAt) >= Date.parse(turn.acceptedAt) &&
  Date.parse(turn.availableAt) - Date.parse(turn.acceptedAt) <= 5_000 &&
  turn.generation === turn.identityGeneration,
  "Finalized live turn must be generation-bound and available within five seconds",
);

const liveMemorySchema = z.object({
  bargeIn: z.object({
    answerEffectId: identifier,
    cancelledAt: timestamp,
    citedTurnIds: z.array(identifier).min(1).max(32),
    latePlaybackPacketCount: z.literal(0),
    questionId: identifier,
    usedGroundedAnswerUseCase: z.literal(true),
  }).strict(),
  botActorId: snowflake,
  botTurnIdsExcluded: z.array(identifier).min(1).max(32),
  finalHistoricalGeneration: z.object({
    generatedAt: timestamp,
    generation: z.number().int().positive(),
    transcriptId: identifier,
    turnIds: z.array(identifier).min(3).max(256),
  }).strict(),
  finalizedTurns: z.array(finalizedTurnSchema).min(4).max(256),
  interimTurnIdsExcluded: z.array(identifier).min(1).max(32),
  postFinalization: z.object({
    ephemeralGeneration: z.number().int().positive(),
    ephemeralServingCount: z.literal(0),
    reconciledAt: timestamp,
    remoteDocumentCount: z.literal(0),
    state: z.enum(["deleted", "superseded"]),
  }).strict(),
  runId: identifier,
}).strict().superRefine((memory, context) => {
  const turns = memory.finalizedTurns;
  const ids = turns.map(({ turnId }) => turnId);
  const locales = new Set(turns.map(({ locale }) => locale));
  const correction = turns.find(({ supersedesTurnId }) => supersedesTurnId !== null);
  const finalIds = new Set(memory.finalHistoricalGeneration.turnIds);
  if (new Set(ids).size !== ids.length || !locales.has("ru") || !locales.has("en") ||
    !locales.has("mixed") || correction === undefined ||
    !ids.includes(correction.supersedesTurnId!) ||
    memory.bargeIn.citedTurnIds.some((turnId) => !ids.includes(turnId)) ||
    ids.some((turnId) => !finalIds.has(turnId)) ||
    memory.postFinalization.ephemeralGeneration >= memory.finalHistoricalGeneration.generation ||
    Date.parse(memory.postFinalization.reconciledAt) <
      Date.parse(memory.finalHistoricalGeneration.generatedAt)) {
    context.addIssue({ code: "custom", message: "Live-memory lifecycle proof is incomplete or cross-generation" });
  }
});

const simultaneousGreetingSchema = z.object({
  cohortId: identifier,
  dispatches: z.array(z.object({
    actorId: snowflake,
    firstAudioAt: timestamp,
    firstJoinAt: timestamp,
    greetingEffectId: identifier,
    greetingReceiptCount: z.literal(1),
    joinOrdinal: z.number().int().positive(),
  }).strict()).min(2).max(16),
  observationEndedAt: timestamp,
  observationStartedAt: timestamp,
  reconnectGreetingCount: z.literal(0),
  runId: identifier,
}).strict().superRefine((greeting, context) => {
  const actors = greeting.dispatches.map(({ actorId }) => actorId);
  const effects = greeting.dispatches.map(({ greetingEffectId }) => greetingEffectId);
  if (new Set(actors).size !== actors.length || new Set(effects).size !== effects.length ||
    greeting.dispatches.some(({ firstAudioAt, firstJoinAt }) =>
      Date.parse(firstAudioAt) < Date.parse(firstJoinAt) ||
      Date.parse(firstAudioAt) - Date.parse(firstJoinAt) > 1_000) ||
    Date.parse(greeting.observationStartedAt) >
      Math.min(...greeting.dispatches.map(({ firstJoinAt }) => Date.parse(firstJoinAt))) ||
    Date.parse(greeting.observationEndedAt) <=
      Math.max(...greeting.dispatches.map(({ firstAudioAt }) => Date.parse(firstAudioAt)))) {
    context.addIssue({ code: "custom", message: "Simultaneous first-join greeting cohort is not exactly once and immediate" });
  }
});

const governedSurfaceSchema = z.object({
  answerCreateCount: z.number().int().nonnegative(),
  channelId: snowflake,
  guildId: snowflake,
  kind: z.enum(["governed-target", "private-guild-other-channel", "private-guild-thread", "wrong-scope"]),
  parentChannelId: snowflake,
}).strict();

export const privateCampaignCoverageQualificationV1Schema = z.object({
  campaignId: identifier,
  governedSurfaces: z.array(governedSurfaceSchema).min(4).max(256),
  evidenceSources: z.object({
    discordObservationSha256: sha256,
    durableStateSha256: sha256,
    gatewayEventSha256: sha256,
    liveMemoryStateSha256: sha256,
    providerAttemptSha256: sha256,
  }).strict(),
  kind: z.literal("discord-private-campaign-coverage-qualification"),
  meetingId: identifier,
  liveMemory: liveMemorySchema,
  observerActorId: snowflake,
  privateTestGuildId: snowflake,
  qualification: z.object({
    externalProvidersExecuted: z.literal(true),
    officialBotApplicationsOnly: z.literal(true),
    productionEvidence: z.literal(true),
    providerFreeStructural: z.literal(false),
    publicOrUserGuild: z.literal(false),
  }).strict(),
  release: hostedCampaignReleaseReferenceV1Schema,
  questionScenarios: z.array(questionScenarioSchema).length(PRIVATE_CAMPAIGN_SCENARIOS.length),
  schemaVersion: z.literal(1),
  simultaneousGreetings: simultaneousGreetingSchema,
  surfaceInventory: z.object({
    activeThreadsComplete: z.literal(true),
    allPrivateTestGuildChannelsEnumerated: z.literal(true),
    archivedThreadsComplete: z.literal(true),
    endedAt: timestamp,
    startedAt: timestamp,
  }).strict().refine(({ endedAt, startedAt }) => Date.parse(endedAt) > Date.parse(startedAt)),
  sutActorId: snowflake,
}).strict().superRefine((proof, context) => {
  const names = proof.questionScenarios.map(({ scenario }) => scenario);
  if (JSON.stringify(names) !== JSON.stringify(PRIVATE_CAMPAIGN_SCENARIOS) ||
    new Set(proof.questionScenarios.map(({ identity }) => identity.questionId)).size !== names.length ||
    new Set(proof.questionScenarios.map(({ identity }) => identity.effectId)).size !== names.length ||
    proof.questionScenarios.some(({ identity }) =>
      identity.actorId !== proof.observerActorId || identity.runId !== proof.liveMemory.runId) ||
    proof.liveMemory.runId !== proof.simultaneousGreetings.runId) {
    context.addIssue({ code: "custom", message: "Coverage scenarios must be complete, ordered, unique, and run-bound" });
  }
  if (!proof.liveMemory.finalizedTurns.some(({ ingressEventCount }) => ingressEventCount === 2)) {
    context.addIssue({ code: "custom", message: "Live memory must prove duplicate finalized-turn idempotency" });
  }
  const answerCreates = proof.questionScenarios.reduce(
    (count, scenario) => count + scenario.receipt.publicationCreateCount, 0,
  );
  const surfaceCreates = proof.governedSurfaces.reduce(
    (count, surface) => count + surface.answerCreateCount, 0,
  );
  if (surfaceCreates !== answerCreates ||
    proof.governedSurfaces.filter(({ kind }) => kind === "governed-target").length !== 1 ||
    proof.governedSurfaces.some(({ kind, answerCreateCount }) =>
      kind !== "governed-target" && answerCreateCount !== 0)) {
    context.addIssue({ code: "custom", message: "Every admitted answer must be in the one governed target and every other private surface must be silent" });
  }
});

export type PrivateCampaignCoverageQualificationV1 = z.infer<
  typeof privateCampaignCoverageQualificationV1Schema
>;

export interface PrivateCampaignCoverageObservationPort {
  observe(): Promise<unknown>;
}

export async function observePrivateCampaignCoverage(
  port: PrivateCampaignCoverageObservationPort,
): Promise<PrivateCampaignCoverageQualificationV1> {
  return privateCampaignCoverageQualificationV1Schema.parse(await port.observe());
}
