import type {
  GeneratedSummary,
  LiveSummaryDraftSnapshot,
} from "@discord-meeting/meeting-core";

import { SubscriptionRuntimeAdapterError } from "./errors.js";
import type { ProviderMeetingSummary } from "./provider-summary-schema.js";
import { stableSubscriptionRuntimeId } from "./stable-id.js";

export function validateProviderSummaryEvidence(
  summary: ProviderMeetingSummary,
  knownTurnIds: ReadonlySet<string>,
  knownSpeakerIds: ReadonlySet<string>,
): void {
  const evidenceGroups = [
    ...summary.topics.map((topic) => topic.evidenceTurnIds),
    ...summary.decisions.map((decision) => decision.evidenceTurnIds),
    ...summary.actionItems.map((actionItem) => actionItem.evidenceTurnIds),
    ...summary.openQuestions.map((question) => question.evidenceTurnIds),
  ];
  for (const evidenceTurnIds of evidenceGroups) {
    if (new Set(evidenceTurnIds).size !== evidenceTurnIds.length) {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_evidence",
        "Summary evidence references must not contain duplicates",
      );
    }
    if (evidenceTurnIds.some((turnId) => !knownTurnIds.has(turnId))) {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_evidence",
        "Summary references a transcript turn that does not exist",
      );
    }
  }
  if (
    summary.actionItems.some(
      ({ ownerSpeakerId }) =>
        ownerSpeakerId !== null && !knownSpeakerIds.has(ownerSpeakerId),
    )
  ) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_evidence",
      "Summary action owner is not a transcript speaker",
    );
  }
}

export function mapFinalProviderSummary(
  summary: ProviderMeetingSummary,
  idempotencyKey: string,
): GeneratedSummary {
  return {
    ...mapProviderSummaryContent(summary, idempotencyKey),
    summaryId: stableSubscriptionRuntimeId("summary", idempotencyKey),
    version: 1,
  };
}

export function mapIncrementalProviderSummary(
  summary: ProviderMeetingSummary,
  idempotencyKey: string,
  revision: number,
): LiveSummaryDraftSnapshot {
  return {
    ...mapProviderSummaryContent(summary, idempotencyKey),
    revision,
  };
}

function mapProviderSummaryContent(
  summary: ProviderMeetingSummary,
  idempotencyKey: string,
): Omit<LiveSummaryDraftSnapshot, "revision"> {
  return {
    actionItems: summary.actionItems.map((actionItem, index) => ({
      actionItemId: stableSubscriptionRuntimeId(
        "action",
        idempotencyKey,
        String(index + 1),
      ),
      deadline: actionItem.deadline,
      evidenceTurnIds: [...actionItem.evidenceTurnIds],
      ownerSpeakerId: actionItem.ownerSpeakerId,
      text: actionItem.text,
    })),
    decisions: summary.decisions.map((decision, index) => ({
      decisionId: stableSubscriptionRuntimeId(
        "decision",
        idempotencyKey,
        String(index + 1),
      ),
      evidenceTurnIds: [...decision.evidenceTurnIds],
      text: decision.text,
    })),
    openQuestions: summary.openQuestions.map((question, index) => ({
      evidenceTurnIds: [...question.evidenceTurnIds],
      id: stableSubscriptionRuntimeId(
        "question",
        idempotencyKey,
        String(index + 1),
      ),
      text: question.text,
    })),
    overview: summary.overview,
    title: summary.title,
    topics: summary.topics.map((topic) => ({
      evidenceTurnIds: [...topic.evidenceTurnIds],
      points: [...topic.points],
      title: topic.title,
    })),
  };
}
