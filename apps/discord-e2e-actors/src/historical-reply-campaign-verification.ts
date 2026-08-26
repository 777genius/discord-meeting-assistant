import { createHash } from "node:crypto";

import type { RetainedE2eEvidence } from "./e2e-evidence-schema.js";
import type { VerificationFailureReporter } from "./e2e-evidence-verification-types.js";
import {
  historicalReplyPostRestartMutationAdmissionV1Schema,
  historicalReplyDurableRehydrationV1Schema,
  HISTORICAL_REPLY_UNSUPPORTED_RESPONSE_V1,
  type HistoricalReplyCampaignEvidenceV1,
} from "./historical-reply-campaign-contract.js";
import { createObservedMeetingProjectionMarkers } from
  "./live-discord-projection-marker-contract.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";
import { parseDiscordAnswerClaimEnvelope } from "./historical-reply-campaign.js";
import { historicalAuthorityMatchesRun, trustedHistoricalRosterMatches } from
  "./historical-reply-producer-verification.js";
import { governedPrivateCampaignObservationV1Schema } from
  "./governed-private-campaign-observation-contract.js";

type V10Run = Extract<RetainedE2eEvidence, { readonly schemaVersion: 10 }>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// oxlint-disable-next-line complexity
export function verifyHistoricalReplyCampaignEvidence(
  evidence: HistoricalReplyCampaignEvidenceV1,
  runs: readonly RetainedE2eEvidence[],
  fail: VerificationFailureReporter,
): void {
  const current = runs.filter((run): run is V10Run => run.schemaVersion === 10);
  const { campaign } = evidence;
  const targetRun = current.find(({ actorRun }) => actorRun.runId === campaign.target.runId);
  if (campaign.guildId !== HOSTED_CAMPAIGN_TARGET.guildId ||
    campaign.observerApplicationId !== HOSTED_CAMPAIGN_TARGET.observerApplicationId ||
    campaign.sutApplicationId !== HOSTED_CAMPAIGN_TARGET.sutApplicationId) {
    fail(
      "HISTORICAL_REPLY_COMPILED_TARGET_MISMATCH",
      "historical mutation is outside the compiled reviewed private Discord target",
    );
  }
  if (current.length !== runs.length || current.some(
    (run) => JSON.stringify(run.release) !== JSON.stringify(campaign.release),
  )) {
    fail(
      "HISTORICAL_REPLY_RELEASE_MISMATCH",
      "historical reply proof must bind the exact V10 campaign release",
    );
  }
  if (!historicalReplyPostRestartMutationAdmissionV1Schema.safeParse(
    campaign.mutationAdmission,
  ).success ||
    campaign.mutationAdmission.originalCampaign.release.releaseBindingSha256 !==
    campaign.release.releaseBindingSha256 ||
    JSON.stringify(campaign.mutationAdmission.originalCampaign.release) !==
      JSON.stringify(campaign.release) ||
    Date.parse(campaign.mutationAdmission.expiresAt) <= Math.max(
      Date.parse(evidence.exchanges.supported.answer.createdAt),
      Date.parse(evidence.exchanges.unsupported.answer.createdAt),
    )) {
    fail(
      "HISTORICAL_REPLY_MUTATION_ADMISSION_INVALID",
      "historical Discord mutations are not covered by the retained trusted release admission",
    );
  }
  if (targetRun === undefined || targetRun.meetingId !== campaign.target.meetingId ||
    targetRun.transcript.transcriptId !== campaign.target.transcriptId ||
    !projectionMatches(campaign, targetRun, campaign.target, evidence.target) ||
    !projectionMatches(campaign, targetRun, campaign.unsupportedTarget,
      evidence.unsupportedTarget)) {
    fail(
      "HISTORICAL_REPLY_TARGET_MISMATCH",
      "observer did not reply to the exact canonical SUT-authored campaign projection kind",
    );
  }
  if (targetRun === undefined ||
    campaign.restart.before.containerId !== targetRun.deployment.meetingPlatform.containerId ||
    campaign.restart.before.imageId !== targetRun.deployment.meetingPlatform.imageId ||
    campaign.restart.before.sourceRevision !==
      targetRun.deployment.meetingPlatform.sourceRevision ||
    campaign.restart.before.composeConfigHash !==
      targetRun.deployment.meetingPlatform.composeConfigHash ||
    campaign.restart.before.composeProject !==
      targetRun.deployment.meetingPlatform.composeProject ||
    campaign.restart.before.composeService !==
      targetRun.deployment.meetingPlatform.composeService ||
    campaign.restart.before.repositoryDigest !==
      targetRun.deployment.meetingPlatform.repositoryDigest ||
    campaign.restart.before.startedAt !==
      targetRun.deployment.meetingPlatform.containerStartedAt) {
    fail(
      "HISTORICAL_REPLY_RESTART_MISMATCH",
      "restart proof does not continue from the exact V10 Meeting Platform instance",
    );
  }
  verifyCanonicalAuthority(campaign, targetRun, fail);
  verifyRehydrationFence(evidence, fail);
  verifyExchangeBindings(evidence, fail);
  verifyCrashReconciliation(evidence, fail);
  verifyPrivateScopeAnswers(evidence, fail);
  verifySupportedAnswer(evidence, targetRun, fail);
  verifyUnsupportedAnswer(evidence, fail);
}

function projectionMatches(
  campaign: HistoricalReplyCampaignEvidenceV1["campaign"],
  run: V10Run,
  target: HistoricalReplyCampaignEvidenceV1["campaign"]["target"],
  observed: HistoricalReplyCampaignEvidenceV1["target"],
): boolean {
  const markerIndex = target.kind === "live-transcript" ? 0 : 1;
  const marker = createObservedMeetingProjectionMarkers(
    target.meetingId, target.parentChannelId,
  )[markerIndex];
  const summaryMatches = target.kind === "live-transcript" ||
    (run.summary.summaryId === target.summaryId &&
      run.publication.messageId === target.messageId &&
      projectionChannelId(run) === target.channelId);
  const parentMatches = target.kind === "live-transcript" ||
    target.parentChannelId === run.publication.container.parentChannelId;
  return summaryMatches && parentMatches && target.meetingId === run.meetingId &&
    target.transcriptId === run.transcript.transcriptId &&
    observed.authorApplicationId === campaign.sutApplicationId &&
    observed.channelId === target.channelId && observed.guildId === campaign.guildId &&
    observed.messageId === target.messageId && observed.projectionMarker === marker &&
    observed.projectionKind === target.kind;
}

function projectionChannelId(run: V10Run): string {
  const container = run.publication.container;
  return container.kind === "thread" ? container.threadId : container.parentChannelId;
}

function verifyCanonicalAuthority(
  campaign: HistoricalReplyCampaignEvidenceV1["campaign"],
  targetRun: V10Run | undefined,
  fail: VerificationFailureReporter,
): void {
  const authority = campaign.canonicalAuthority;
  if (targetRun === undefined || !historicalAuthorityMatchesRun(campaign, targetRun)) {
    fail(
      "HISTORICAL_REPLY_AUTHORITY_MISMATCH",
      "reply grounding authority is not the target projection's authoritative campaign transcript",
    );
    return;
  }
  if (!trustedHistoricalRosterMatches(campaign, targetRun)) {
    fail(
      "HISTORICAL_REPLY_TRUSTED_ROSTER_INVALID",
      "authoritative reconnect transcript contains bot, unknown, or non-roster identity",
    );
  }
  for (const retained of authority.turns) {
    const turn = targetRun.transcript.turns.find(({ turnId }) => turnId === retained.turnId);
    if (turn === undefined || turn.speakerId !== retained.speakerId ||
      turn.startMs !== retained.startMs || turn.endMs !== retained.endMs ||
      sha256(turn.text) !== retained.textSha256) {
      fail(
        "HISTORICAL_REPLY_AUTHORITY_MISMATCH",
        `historical citation ${retained.turnId} does not match the authoritative final transcript`,
      );
    }
  }
}

function verifyRehydrationFence(
  evidence: HistoricalReplyCampaignEvidenceV1,
  fail: VerificationFailureReporter,
): void {
  const { campaign, exchanges } = evidence;
  const readyAt = Date.parse(campaign.restart.readyAt);
  const rehydratedAt = Date.parse(campaign.rehydration.observedAt);
  const questionTimes = [
    Date.parse(exchanges.supported.question.createdAt),
    Date.parse(exchanges.unsupported.question.createdAt),
  ];
  const answerTimes = [
    Date.parse(exchanges.supported.answer.createdAt),
    Date.parse(exchanges.unsupported.answer.createdAt),
  ];
  const readiness = campaign.rehydration;
  const request = campaign.mutationAdmission.rollout.retrievalBinding.request;
  const mappedTurnIds = new Set(readiness.documentMappings.flatMap(
    ({ canonicalTurnIds }) => canonicalTurnIds,
  ));
  if (!historicalReplyDurableRehydrationV1Schema.safeParse(readiness).success ||
    campaign.rehydration.desiredSourceGeneration !== campaign.canonicalAuthority.generation ||
    request.binding.profileId !== readiness.appliedIndexProfileId ||
    request.scope.memoryScopeId !== readiness.scopeId || request.scope.spaceId !== readiness.roomId ||
    request.filters.sourceGenerations.length !== 1 ||
    request.filters.sourceGenerations.some(({ projectionGeneration, sourceKey }) =>
      projectionGeneration !== readiness.appliedIndexGeneration ||
      sourceKey !== readiness.appliedReleaseRef) ||
    campaign.canonicalAuthority.turns.some(({ turnId }) => !mappedTurnIds.has(turnId)) ||
    questionTimes.some((time) => time < readyAt || time < rehydratedAt) ||
    answerTimes.some((time) => time < readyAt || time < rehydratedAt)) {
    fail(
      "HISTORICAL_REPLY_BEFORE_REHYDRATION",
      "historical question or answer arrived before release-bound Infinity rehydration was durable",
    );
  }
}

// oxlint-disable-next-line complexity
function verifyExchangeBindings(
  evidence: HistoricalReplyCampaignEvidenceV1,
  fail: VerificationFailureReporter,
): void {
  const { campaign, exchanges } = evidence;
  const supportedBinding = exchanges.supported.durableAdmission.retrievalBinding;
  const unsupportedBinding = exchanges.unsupported.durableAdmission.retrievalBinding;
  const supportedAdmission = exchanges.supported.durableAdmission;
  const unsupportedAdmission = exchanges.unsupported.durableAdmission;
  const supportedProtocolEpoch: unknown = Reflect.get(supportedAdmission, "workerProtocolEpoch");
  const unsupportedProtocolEpoch: unknown = Reflect.get(
    unsupportedAdmission,
    "workerProtocolEpoch",
  );
  const expectedProtocolEpoch: unknown = Reflect.get(
    campaign.mutationAdmission.rollout,
    "workerProtocolEpoch",
  );
  if (JSON.stringify(supportedBinding) !== JSON.stringify(unsupportedBinding) ||
    JSON.stringify(supportedBinding) !==
      JSON.stringify(campaign.mutationAdmission.rollout.retrievalBinding) ||
    supportedAdmission.policyEpoch !== unsupportedAdmission.policyEpoch ||
    supportedAdmission.jobGeneration !== unsupportedAdmission.jobGeneration ||
    supportedProtocolEpoch !== unsupportedProtocolEpoch ||
    supportedProtocolEpoch !== expectedProtocolEpoch ||
    supportedAdmission.workerProtocolGeneration !== unsupportedAdmission.workerProtocolGeneration) {
    fail(
      "HISTORICAL_REPLY_ROLLOUT_CONTINUITY_MISMATCH",
      "both questions must retain the same policy, worker generation, protocol, and retrieval binding",
    );
  }
  if (evidence.observerAuthenticatedApplicationId !== campaign.observerApplicationId) {
    fail("HISTORICAL_REPLY_OBSERVER_MISMATCH", "historical reply used the wrong observer identity");
  }
  for (const [exchange, target] of [
    [exchanges.supported, campaign.target],
    [exchanges.unsupported, campaign.unsupportedTarget],
  ] as const) {
    const retrievalPath: unknown = Reflect.get(
      exchange.durableAdmission.retrievalBinding,
      "retrievalPath",
    );
    if (exchange.question.authorApplicationId !== campaign.observerApplicationId ||
      exchange.question.channelId !== target.channelId ||
      exchange.question.replyToMessageId !== target.messageId ||
      exchange.answer.authorApplicationId !== campaign.sutApplicationId ||
      exchange.answer.channelId !== target.channelId ||
      exchange.answer.replyToMessageId !== exchange.question.messageId ||
      Date.parse(exchange.answer.createdAt) < Date.parse(exchange.question.createdAt)) {
      fail(
        "HISTORICAL_REPLY_MESSAGE_BINDING_INVALID",
        "question or answer is bound to the wrong author, container, or replied-to message",
      );
    }
    if (exchange.quietWindow.matchingAnswerMessageIds.length !== 1 ||
      exchange.quietWindow.matchingAnswerMessageIds[0] !== exchange.answer.messageId ||
      Date.parse(exchange.quietWindow.startedAt) < Date.parse(exchange.answer.createdAt) ||
      Date.parse(exchange.quietWindow.endedAt) - Date.parse(exchange.quietWindow.startedAt) <
        campaign.answerQuietWindowMilliseconds ||
      Date.parse(exchange.quietWindow.endedAt) - Date.parse(exchange.quietWindow.startedAt) >
        campaign.answerQuietWindowMilliseconds + 10_000) {
      fail(
        "HISTORICAL_REPLY_DUPLICATE_OR_UNBOUNDED",
        "historical answer lacks a bounded post-answer quiet window or contains a late duplicate",
      );
    }
    if (exchange.durableAdmission.questionId !== exchange.question.messageId ||
        exchange.durableAdmission.serviceContainerId !== campaign.restart.after.containerId ||
        retrievalPath !== "infinity_locator_v2" ||
        Date.parse(exchange.durableAdmission.observedAt) >
          Date.parse(exchange.answer.createdAt) ||
        exchange.durableOutcome.questionId !== exchange.question.messageId ||
        exchange.durableOutcome.serviceContainerId !== campaign.restart.after.containerId ||
        Date.parse(exchange.durableOutcome.observedAt) <
          Date.parse(exchange.quietWindow.endedAt)) {
      fail(
        "HISTORICAL_REPLY_DURABLE_OUTCOME_MISMATCH",
        "durable answer status is bound to the wrong question or restarted service",
      );
    }
    const admissionIdentity = {
      attemptId: exchange.durableAdmission.attemptId,
      effectId: exchange.durableAdmission.effectId,
      groundingPlanSha256: exchange.durableAdmission.groundingPlanSha256,
      jobId: exchange.durableAdmission.jobId,
    };
    const settlementIdentity = {
      attemptId: exchange.durableSettlement.attemptId,
      effectId: exchange.durableSettlement.effectId,
      groundingPlanSha256: exchange.durableSettlement.groundingPlanSha256,
      jobId: exchange.durableSettlement.jobId,
    };
    if (JSON.stringify(admissionIdentity) !== JSON.stringify(settlementIdentity) ||
      exchange.durableSettlement.externalReceipt !== exchange.answer.messageId ||
      exchange.durableSettlement.serviceContainerId !== campaign.restart.after.containerId) {
      fail(
        "HISTORICAL_REPLY_RECONCILIATION_IDENTITY_MISMATCH",
        "job, provider attempt, grounding, effect, or Discord receipt changed during reconciliation",
      );
    }
  }
}

function verifyCrashReconciliation(
  evidence: HistoricalReplyCampaignEvidenceV1,
  fail: VerificationFailureReporter,
): void {
  const receipt = evidence.crashReceipts[0];
  const exchange = evidence.exchanges.supported;
  if (evidence.crashReceipts.length !== 1 || receipt === undefined ||
    receipt.campaignId !== evidence.campaign.campaignId ||
    receipt.injectionId !== `public-reply-crash:${evidence.campaign.runId}` ||
    receipt.effectId !== exchange.durableAdmission.effectId ||
    receipt.effectId !== exchange.durableSettlement.effectId ||
    receipt.externalReceipt !== exchange.answer.messageId ||
    receipt.externalReceipt !== exchange.durableSettlement.externalReceipt ||
    exchange.durableAdmission.jobId !== exchange.question.messageId ||
    exchange.durableAdmission.jobId !== exchange.durableSettlement.jobId ||
    exchange.durableAdmission.attemptId !== exchange.durableSettlement.attemptId ||
    exchange.durableAdmission.groundingPlanSha256 !==
      exchange.durableSettlement.groundingPlanSha256 ||
    Date.parse(receipt.triggeredAt) < Date.parse(exchange.answer.createdAt) ||
    Date.parse(receipt.triggeredAt) > Date.parse(exchange.durableSettlement.observedAt) ||
    receipt.crashedHostProcessId !== evidence.campaign.restart.after.hostProcessId ||
    receipt.crashedHostProcessId === exchange.durableSettlement.serviceHostProcessId) {
    fail(
      "HISTORICAL_REPLY_CRASH_RECEIPT_INVALID",
      "crash receipt does not bind the canonical job, attempt, grounding plan, effect, receipt, time, and replacement process",
    );
  }
}

function verifyPrivateScopeAnswers(
  evidence: HistoricalReplyCampaignEvidenceV1,
  fail: VerificationFailureReporter,
): void {
  const expected = new Map([
    [evidence.exchanges.supported.answer.messageId,
      evidence.exchanges.supported.question.messageId],
    [evidence.exchanges.unsupported.answer.messageId,
      evidence.exchanges.unsupported.question.messageId],
  ]);
  const observed = evidence.privateScopeAnswers;
  if (!governedPrivateCampaignObservationV1Schema.safeParse(observed).success ||
    JSON.stringify(observed.scope) !== JSON.stringify(evidence.campaign.observationScope) ||
    observed.receipts.length !== 2 || new Set(observed.receipts.map(({ messageId }) => messageId)).size !== 2 ||
    observed.receipts.some(({ messageId, replyToMessageId }) =>
      expected.get(messageId) !== replyToMessageId)) {
    fail(
      "HISTORICAL_REPLY_PRIVATE_SCOPE_ANSWER_MISMATCH",
      "compiled private scope must contain exactly the two target-bound SUT answers and no others",
    );
  }
}

function verifySupportedAnswer(
  evidence: HistoricalReplyCampaignEvidenceV1,
  targetRun: V10Run | undefined,
  fail: VerificationFailureReporter,
): void {
  const { campaign, exchanges } = evidence;
  const question = campaign.questions.supported;
  const answer = exchanges.supported;
  const normalized = answer.answer.description.toLocaleLowerCase("en-US");
  let renderedClaims: ReturnType<typeof parseDiscordAnswerClaimEnvelope> = [];
  try {
    renderedClaims = parseDiscordAnswerClaimEnvelope(answer.answer.description);
  } catch {
    // The common grounding failure below owns the stable verifier code.
  }
  const authorityTextByTurn = new Map(campaign.canonicalAuthority.turns.map(
    ({ turnId }) => [turnId, targetRun?.transcript.turns.find((turn) =>
      turn.turnId === turnId)?.text ?? ""],
  ));
  const unsupportedExpectedClaim = question.expectedClaims.some((claim) => {
    if (!claim.citationTurnIds.every((turnId) => answer.citationTurnIds.includes(turnId))) {
      return true;
    }
    const citedText = claim.citationTurnIds.map((turnId) => authorityTextByTurn.get(turnId) ?? "")
      .join(" ").toLocaleLowerCase("en-US");
    return !normalized.includes(claim.text.toLocaleLowerCase("en-US")) ||
      !citedText.includes(claim.text.toLocaleLowerCase("en-US")) ||
      claim.requiredTerms.some((term) =>
        !normalized.includes(term.toLocaleLowerCase("en-US")) ||
        !citedText.includes(term.toLocaleLowerCase("en-US")));
  });
  const unpinnedRenderedClaim = renderedClaims.length !== question.expectedClaims.length ||
    renderedClaims.some((claim, index) => {
      const expected = question.expectedClaims[index];
      if (expected === undefined || claim.text !== expected.text ||
        !sameStrings(claim.citationTurnIds, expected.citationTurnIds)) {
        return true;
      }
      const citedText = claim.citationTurnIds.map(
        (turnId) => authorityTextByTurn.get(turnId) ?? "",
      ).join(" ").toLocaleLowerCase("en-US");
      return !citedText.includes(claim.text.toLocaleLowerCase("en-US"));
    });
  if (answer.question.textSha256 !== sha256(question.text) ||
    !sameStrings(answer.citationTurnIds, question.expectedCitationTurnIds) ||
    answer.durableOutcome.outcome !== "answered" ||
    unsupportedExpectedClaim || unpinnedRenderedClaim || question.expectedAnswerTerms.some(
      (term) => !normalized.includes(term.toLocaleLowerCase("en-US")),
    )) {
    fail(
      "HISTORICAL_REPLY_GROUNDING_INVALID",
      "supported answer lacks the exact historical citations or grounded claim terms",
    );
  }
}

function verifyUnsupportedAnswer(
  evidence: HistoricalReplyCampaignEvidenceV1,
  fail: VerificationFailureReporter,
): void {
  const { campaign, exchanges } = evidence;
  const question = campaign.questions.unsupported;
  const answer = exchanges.unsupported;
  const semanticAbstention = answer.durableOutcome.outcome === "insufficient_evidence";
  if (answer.question.textSha256 !== sha256(question.text) ||
    !semanticAbstention ||
    answer.citationTurnIds.length !== 0 ||
    answer.answer.description !== HISTORICAL_REPLY_UNSUPPORTED_RESPONSE_V1) {
    fail(
      "HISTORICAL_REPLY_ABSTENTION_INVALID",
      "unsupported claim must receive a durable or rendered citation-free abstention",
    );
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
