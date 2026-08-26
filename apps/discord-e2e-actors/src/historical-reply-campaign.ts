import { createHash } from "node:crypto";

import {
  historicalReplyCampaignEvidenceV1Schema,
  historicalReplyCampaignInputV1Schema,
  HISTORICAL_REPLY_UNSUPPORTED_RESPONSE_V1,
  type HistoricalReplyDurableQuestionOutcomeV1,
  type HistoricalReplyDurableQuestionAdmissionV1,
  type HistoricalReplyDurableSettlementV1,
  type HistoricalReplyCrashReceiptV1,
  type HistoricalReplyCampaignEvidenceV1,
  type HistoricalReplyCampaignInputV1,
} from "./historical-reply-campaign-contract.js";
import { createObservedMeetingProjectionMarkers } from
  "./live-discord-projection-marker-contract.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";
import type { GovernedCampaignObservation, GovernedCampaignObservationInput } from
  "./governed-private-campaign-observation.js";

export interface HistoricalReplyTargetObservation {
  readonly authorApplicationId: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly messageId: string;
  readonly observedAt: string;
  readonly projectionMarker: string;
  readonly projectionKind: HistoricalReplyCampaignInputV1["target"]["kind"];
}

export interface HistoricalReplyQuestionReceipt {
  readonly authorApplicationId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly messageId: string;
  readonly replyToMessageId: string;
}

export interface HistoricalReplyAnswerObservation {
  readonly authorApplicationId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly description: string;
  readonly messageId: string;
  readonly replyToMessageId: string;
}

export interface HistoricalReplyAnswerReceipt {
  readonly answer: HistoricalReplyAnswerObservation;
  readonly quietWindow: {
    readonly endedAt: string;
    readonly matchingAnswerMessageIds: readonly string[];
    readonly startedAt: string;
  };
}

export interface HistoricalReplyCampaignPort {
  assertRuntimeReady(): Promise<void>;
  authenticatedApplicationId(): string;
  inspectTarget(input: HistoricalReplyCampaignInputV1["target"]):
    Promise<HistoricalReplyTargetObservation>;
  sendQuestion(input: {
    readonly channelId: string;
    readonly replyToMessageId: string;
    readonly text: string;
  }): Promise<HistoricalReplyQuestionReceipt>;
  awaitAnswer(input: {
    readonly afterMessageId: string;
    readonly channelId: string;
    readonly replyToQuestionMessageId: string;
    readonly sutApplicationId: string;
  }): Promise<HistoricalReplyAnswerReceipt>;
  observeDurableOutcome(questionId: string): Promise<HistoricalReplyDurableQuestionOutcomeV1>;
  observeDurableAdmission(questionId: string): Promise<HistoricalReplyDurableQuestionAdmissionV1>;
  observeDurableSettlement(questionId: string): Promise<HistoricalReplyDurableSettlementV1>;
  observeCrashReceipts(): Promise<readonly HistoricalReplyCrashReceiptV1[]>;
  observePrivateScopeAnswers(input: GovernedCampaignObservationInput):
    Promise<GovernedCampaignObservation>;
}

export interface HistoricalReplyAnswerClaim {
  readonly citationTurnIds: readonly string[];
  readonly text: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertHistoricalPostRestartMutationAdmission(input: {
  readonly admissionReceiptSha256: string;
  readonly campaign: HistoricalReplyCampaignInputV1;
  readonly consumedAdmissionIds?: Set<string>;
  readonly evidenceOutputPathSha256: string;
  readonly nowEpochMs: number;
  readonly planSha256: string;
}): void {
  const campaign = historicalReplyCampaignInputV1Schema.parse(input.campaign);
  const retained = campaign.mutationAdmission;
  if (!Number.isSafeInteger(input.nowEpochMs) ||
    input.nowEpochMs < Date.parse(retained.issuedAt) ||
    input.nowEpochMs >= Date.parse(retained.expiresAt) ||
    retained.originalCampaign.admissionReceiptSha256 !== input.admissionReceiptSha256 ||
    retained.originalCampaign.planSha256 !== input.planSha256 ||
    retained.scope.evidenceOutputPathSha256 !== input.evidenceOutputPathSha256 ||
    JSON.stringify(retained.originalCampaign.release) !== JSON.stringify(campaign.release)) {
    throw new Error("Post-restart mutation admission is stale or bound to other campaign evidence");
  }
  if (input.consumedAdmissionIds?.has(retained.admissionId) === true) {
    throw new Error("Post-restart mutation admission was replayed");
  }
  input.consumedAdmissionIds?.add(retained.admissionId);
}

export function parseDiscordAnswerClaimEnvelope(
  description: string,
): readonly HistoricalReplyAnswerClaim[] {
  if (description.length < 1 || description.length > 2_000 || description.includes("\r")) {
    throw new Error("Historical answer is outside the bounded Discord claim envelope");
  }
  const blocks = description.split("\n\n");
  if (blocks.length < 1 || blocks.length > 16) {
    throw new Error("Historical answer has an invalid number of claim blocks");
  }
  const citation = /^S\d+\s*·\s*(?:\d+:)?\d{1,2}:\d{2}\s*·\s*(.+)$/u;
  return Object.freeze(blocks.map((block) => {
    const lines = block.split("\n");
    if (lines.length !== 2 || lines[0] === undefined || lines[0].trim().length === 0 ||
      lines[1] === undefined || !lines[1].startsWith("-# ")) {
      throw new Error("Every historical answer claim must have one citation line");
    }
    const citations = lines[1].slice(3).split("; ");
    if (citations.length < 1 || citations.length > 16) {
      throw new Error("Historical answer claim has an invalid citation count");
    }
    const citationTurnIds = citations.map((rendered) => {
      const turnId = citation.exec(rendered)?.[1]?.trim();
      if (turnId === undefined || turnId.length === 0) {
        throw new Error("Historical answer claim has a malformed authoritative-turn citation");
      }
      return unescapeDiscordMarkdown(turnId);
    });
    if (new Set(citationTurnIds).size !== citationTurnIds.length) {
      throw new Error("Historical answer claim repeats an authoritative-turn citation");
    }
    return Object.freeze({
      citationTurnIds: Object.freeze(citationTurnIds),
      text: unescapeDiscordMarkdown(lines[0]),
    });
  }));
}

export function citationTurnIdsFromDiscordAnswer(description: string): readonly string[] {
  if (!description.split("\n").some((line) => line.startsWith("-# "))) {
    return Object.freeze([]);
  }
  return Object.freeze(parseDiscordAnswerClaimEnvelope(description).flatMap(
    ({ citationTurnIds }) => citationTurnIds,
  ));
}

// oxlint-disable-next-line complexity
export async function runHistoricalReplyCampaign(
  inputValue: unknown,
  port: HistoricalReplyCampaignPort,
  now: () => number = Date.now,
): Promise<HistoricalReplyCampaignEvidenceV1> {
  const campaign = historicalReplyCampaignInputV1Schema.parse(inputValue);
  if (campaign.guildId !== HOSTED_CAMPAIGN_TARGET.guildId ||
    campaign.observerApplicationId !== HOSTED_CAMPAIGN_TARGET.observerApplicationId ||
    campaign.sutApplicationId !== HOSTED_CAMPAIGN_TARGET.sutApplicationId ||
    campaign.target.parentChannelId !== HOSTED_CAMPAIGN_TARGET.publicationChannelId) {
    throw new Error("Historical reply is outside the compiled reviewed private Discord target");
  }
  if (now() < Date.parse(campaign.restart.readyAt)) {
    throw new Error("Historical reply campaign cannot start before durable rehydration readiness");
  }
  if (now() >= Date.parse(campaign.mutationAdmission.expiresAt)) {
    throw new Error("Historical reply mutation admission expired before Discord access");
  }
  const observerAuthenticatedApplicationId = port.authenticatedApplicationId();
  if (observerAuthenticatedApplicationId !== campaign.observerApplicationId) {
    throw new Error("Historical reply campaign authenticated the wrong official observer");
  }
  const target = await port.inspectTarget(campaign.target);
  assertTarget(campaign, campaign.target, target);
  const unsupportedTarget = await port.inspectTarget(campaign.unsupportedTarget);
  assertTarget(campaign, campaign.unsupportedTarget, unsupportedTarget);

  const supported = await exchange(
    campaign,
    port,
    campaign.questions.supported.text,
    campaign.target,
    now,
  );
  const expectedCitations = campaign.questions.supported.expectedCitationTurnIds;
  if (!sameStrings(supported.citationTurnIds, expectedCitations)) {
    throw new Error("Supported historical answer did not cite the exact authoritative turns");
  }
  const normalizedSupported = supported.answer.description.toLocaleLowerCase("en-US");
  if (!/[А-Яа-яЁё]/u.test(supported.answer.description)) {
    throw new Error("Supported historical answer did not preserve the required Russian locale");
  }
  const renderedClaims = parseDiscordAnswerClaimEnvelope(supported.answer.description);
  if (renderedClaims.length !== campaign.questions.supported.expectedClaims.length ||
    renderedClaims.some((claim, index) => {
      const expected = campaign.questions.supported.expectedClaims[index];
      return expected === undefined || claim.text !== expected.text ||
        !sameStrings(claim.citationTurnIds, expected.citationTurnIds);
    })) {
    throw new Error("Supported historical answer contains an unpinned factual claim");
  }
  if (campaign.questions.supported.expectedAnswerTerms.some(
    (term) => !normalizedSupported.includes(term.toLocaleLowerCase("en-US")),
  )) {
    throw new Error("Supported historical answer omitted a required grounded term");
  }
  if (campaign.questions.supported.expectedClaims.some((claim) =>
    !normalizedSupported.includes(claim.text.toLocaleLowerCase("en-US")) ||
    claim.requiredTerms.some((term) =>
      !normalizedSupported.includes(term.toLocaleLowerCase("en-US"))) ||
    claim.citationTurnIds.some((turnId) => !supported.citationTurnIds.includes(turnId)))) {
    throw new Error("Supported historical answer omitted an expected cited claim");
  }
  if (supported.durableOutcome.outcome !== "answered") {
    throw new Error("Supported historical answer has the wrong durable semantic outcome");
  }
  const crashReceipts = await port.observeCrashReceipts();

  const unsupported = await exchange(
    campaign,
    port,
    campaign.questions.unsupported.text,
    campaign.unsupportedTarget,
    now,
  );
  const unsupportedSemanticallyAbstained =
    unsupported.durableOutcome.outcome === "insufficient_evidence";
  if (!unsupportedSemanticallyAbstained || unsupported.citationTurnIds.length !== 0 ||
    unsupported.answer.description !== HISTORICAL_REPLY_UNSUPPORTED_RESPONSE_V1) {
    throw new Error("Unsupported historical question did not produce a citation-free abstention");
  }
  if (JSON.stringify(rolloutContinuity(supported.durableAdmission)) !==
    JSON.stringify(rolloutContinuity(unsupported.durableAdmission))) {
    throw new Error("Historical questions crossed a durable worker rollout boundary");
  }
  const privateScopeAnswers = await port.observePrivateScopeAnswers({
    expectedAnswerReceipts: [supported.answer, unsupported.answer].map(
      ({ channelId, messageId, replyToMessageId }) => ({ channelId, messageId, replyToMessageId }),
    ),
    ...campaign.observationScope,
    sutApplicationId: campaign.sutApplicationId,
  });
  const intendedReceipts = new Set([supported.answer.messageId, unsupported.answer.messageId]);
  if (now() < Date.parse(campaign.observationScope.endedAt) ||
    JSON.stringify(privateScopeAnswers.scope) !== JSON.stringify(campaign.observationScope) ||
    privateScopeAnswers.receipts.length !== 2 ||
    privateScopeAnswers.receipts.some(({ messageId, replyToMessageId }) =>
      !intendedReceipts.has(messageId) ||
      (replyToMessageId !== supported.question.messageId &&
        replyToMessageId !== unsupported.question.messageId))) {
    throw new Error("Historical reply campaign observed a SUT answer outside its two target-bound receipts");
  }

  return historicalReplyCampaignEvidenceV1Schema.parse({
    campaign,
    crashReceipts,
    exchanges: { supported, unsupported },
    kind: "discord-historical-reply-qualification",
    observerAuthenticatedApplicationId,
    privateScopeAnswers,
    schemaVersion: 1,
    target,
    unsupportedTarget,
  });
}

async function exchange(
  campaign: HistoricalReplyCampaignInputV1,
  port: HistoricalReplyCampaignPort,
  text: string,
  target: HistoricalReplyCampaignInputV1["target"],
  now: () => number,
) {
  if (now() >= Date.parse(campaign.mutationAdmission.expiresAt)) {
    throw new Error("Historical reply mutation admission expired before question send");
  }
  await port.assertRuntimeReady();
  if (now() >= Date.parse(campaign.mutationAdmission.expiresAt)) {
    throw new Error("Historical reply mutation admission expired during runtime revalidation");
  }
  const question = await port.sendQuestion({
    channelId: target.channelId,
    replyToMessageId: target.messageId,
    text,
  });
  assertQuestion(campaign, target, question);
  const durableAdmission = await port.observeDurableAdmission(question.messageId);
  const expectedRollout = campaign.mutationAdmission.rollout;
  if (durableAdmission.questionId !== question.messageId ||
    durableAdmission.serviceContainerId !== campaign.restart.after.containerId ||
    durableAdmission.jobGeneration !== expectedRollout.jobGeneration ||
    durableAdmission.policyEpoch !== expectedRollout.policyEpoch ||
    JSON.stringify(durableAdmission.retrievalBinding) !==
      JSON.stringify(expectedRollout.retrievalBinding) ||
    durableAdmission.workerProtocolGeneration !== expectedRollout.workerProtocolGeneration) {
    throw new Error("Historical reply has no matching durable Infinity admission binding");
  }
  const answerReceipt = await port.awaitAnswer({
    afterMessageId: question.messageId,
    channelId: target.channelId,
    replyToQuestionMessageId: question.messageId,
    sutApplicationId: campaign.sutApplicationId,
  });
  const { answer, quietWindow } = answerReceipt;
  assertAnswer(campaign, target, question, answer);
  if (quietWindow.matchingAnswerMessageIds.length !== 1 ||
    quietWindow.matchingAnswerMessageIds[0] !== answer.messageId ||
    Date.parse(quietWindow.startedAt) < Date.parse(answer.createdAt) ||
    Date.parse(quietWindow.endedAt) - Date.parse(quietWindow.startedAt) <
      campaign.answerQuietWindowMilliseconds ||
    Date.parse(quietWindow.endedAt) - Date.parse(quietWindow.startedAt) >
      campaign.answerQuietWindowMilliseconds + 10_000) {
    throw new Error("Historical answer did not survive the bounded duplicate quiet window");
  }
  const durableOutcome = await port.observeDurableOutcome(question.messageId);
  const durableSettlement = await port.observeDurableSettlement(question.messageId);
  const admissionIdentity = {
    attemptId: durableAdmission.attemptId,
    effectId: durableAdmission.effectId,
    groundingPlanSha256: durableAdmission.groundingPlanSha256,
    jobId: durableAdmission.jobId,
  };
  const settlementIdentity = {
    attemptId: durableSettlement.attemptId,
    effectId: durableSettlement.effectId,
    groundingPlanSha256: durableSettlement.groundingPlanSha256,
    jobId: durableSettlement.jobId,
  };
  if (JSON.stringify(admissionIdentity) !== JSON.stringify(settlementIdentity) ||
    durableSettlement.externalReceipt !== answer.messageId) {
    throw new Error("Historical reply identity changed during crash reconciliation");
  }
  return {
    answer,
    citationTurnIds: citationTurnIdsFromDiscordAnswer(answer.description),
    durableAdmission,
    durableOutcome,
    durableSettlement,
    question: { ...question, textSha256: sha256(text) },
    quietWindow,
  };
}

function assertTarget(
  campaign: HistoricalReplyCampaignInputV1,
  expected: HistoricalReplyCampaignInputV1["target"],
  target: HistoricalReplyTargetObservation,
): void {
  if (target.authorApplicationId !== campaign.sutApplicationId ||
    target.channelId !== expected.channelId ||
    target.guildId !== campaign.guildId ||
    target.messageId !== expected.messageId) {
    throw new Error("Historical reply target is not the exact SUT-authored campaign projection");
  }
  if (target.projectionKind !== expected.kind) {
    throw new Error("Historical reply target has the wrong canonical projection kind");
  }
  const markerIndex = expected.kind === "live-transcript" ? 0 : 1;
  const expectedMarker = createObservedMeetingProjectionMarkers(
    expected.meetingId,
    expected.parentChannelId,
  )[markerIndex];
  if (target.projectionMarker !== expectedMarker) {
    throw new Error("Historical reply target has no genuine canonical projection receipt");
  }
}

function assertQuestion(
  campaign: HistoricalReplyCampaignInputV1,
  target: HistoricalReplyCampaignInputV1["target"],
  question: HistoricalReplyQuestionReceipt,
): void {
  if (question.authorApplicationId !== campaign.observerApplicationId ||
    question.channelId !== target.channelId ||
    question.replyToMessageId !== target.messageId ||
    Date.parse(question.createdAt) < Date.parse(campaign.restart.readyAt) ||
    Date.parse(question.createdAt) < Date.parse(campaign.rehydration.observedAt) ||
    Date.parse(question.createdAt) >= Date.parse(campaign.mutationAdmission.expiresAt)) {
    throw new Error("Observer question is misbound or was sent before durable rehydration");
  }
}

function assertAnswer(
  campaign: HistoricalReplyCampaignInputV1,
  target: HistoricalReplyCampaignInputV1["target"],
  question: HistoricalReplyQuestionReceipt,
  answer: HistoricalReplyAnswerObservation,
): void {
  if (answer.authorApplicationId !== campaign.sutApplicationId ||
    answer.channelId !== target.channelId ||
    answer.replyToMessageId !== question.messageId ||
    Date.parse(answer.createdAt) < Date.parse(question.createdAt) ||
    Date.parse(answer.createdAt) < Date.parse(campaign.rehydration.observedAt) ||
    Date.parse(answer.createdAt) >= Date.parse(campaign.mutationAdmission.expiresAt)) {
    throw new Error("Historical answer is misbound or arrived before durable rehydration");
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rolloutContinuity(admission: HistoricalReplyDurableQuestionAdmissionV1) {
  return {
    jobGeneration: admission.jobGeneration,
    policyEpoch: admission.policyEpoch,
    retrievalBinding: admission.retrievalBinding,
    workerProtocolEpoch: admission.workerProtocolEpoch,
    workerProtocolGeneration: admission.workerProtocolGeneration,
  };
}

function unescapeDiscordMarkdown(value: string): string {
  return value.replace(/\\([\\*_~|>`#[\]()])/gu, "$1");
}
