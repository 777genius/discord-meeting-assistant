import {
  type GeneratedSummary,
} from "@discord-meeting/meeting-core/meeting-intelligence";
import {
  type LiveSummaryDraftSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";

import { SubscriptionRuntimeAdapterError } from "./errors.js";
import type {
  ProviderIncrementalMeetingSummary,
  ProviderMeetingSummary,
  ProviderMeetingSummaryWithEvidence,
} from "./provider-summary-schema.js";
import { stableSubscriptionRuntimeId } from "./stable-id.js";

export function validateProviderSummaryEvidence(
  summary: ProviderMeetingSummaryWithEvidence,
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

/**
 * A cumulative live revision must keep one same-kind successor for every
 * previous structured item. The successor may revise the prose or add newer
 * evidence, but it cannot discard the evidence lineage that made the earlier
 * item durable cumulative memory.
 */
export function validateIncrementalSummaryRetention(
  summary: ProviderIncrementalMeetingSummary,
  previousSummary: LiveSummaryDraftSnapshot | null,
): void {
  if (previousSummary === null) {
    return;
  }
  requireInjectiveEvidenceLineage(
    previousSummary.topics,
    summary.topics,
    "topics",
  );
  requireInjectiveEvidenceLineage(
    previousSummary.decisions,
    summary.decisions,
    "decisions",
  );
  requireInjectiveEvidenceLineage(
    previousSummary.actionItems,
    summary.actionItems,
    "action items",
  );
  requireInjectiveEvidenceLineage(
    previousSummary.openQuestions,
    summary.openQuestions,
    "open questions",
  );
}

interface EvidenceLineageItem {
  readonly evidenceTurnIds: readonly string[];
}

function requireInjectiveEvidenceLineage(
  previousItems: readonly EvidenceLineageItem[],
  nextItems: readonly EvidenceLineageItem[],
  field: string,
): void {
  if (
    previousItems.length > nextItems.length ||
    !hasInjectiveEvidenceLineage(previousItems, nextItems, 0, new Set())
  ) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_evidence",
      `Incremental summary dropped previous ${field} evidence lineage`,
    );
  }
}

function hasInjectiveEvidenceLineage(
  previousItems: readonly EvidenceLineageItem[],
  nextItems: readonly EvidenceLineageItem[],
  previousIndex: number,
  usedNextIndexes: ReadonlySet<number>,
): boolean {
  if (previousIndex === previousItems.length) {
    return true;
  }
  const previousEvidence = previousItems[previousIndex]?.evidenceTurnIds ?? [];
  for (const [nextIndex, nextItem] of nextItems.entries()) {
    if (
      usedNextIndexes.has(nextIndex) ||
      previousEvidence.some((turnId) => !nextItem.evidenceTurnIds.includes(turnId))
    ) {
      continue;
    }
    if (
      hasInjectiveEvidenceLineage(
        previousItems,
        nextItems,
        previousIndex + 1,
        new Set([...usedNextIndexes, nextIndex]),
      )
    ) {
      return true;
    }
  }
  return false;
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
  summary: ProviderIncrementalMeetingSummary,
  idempotencyKey: string,
  revision: number,
): LiveSummaryDraftSnapshot {
  return {
    ...mapProviderSummaryContent(summary, idempotencyKey),
    revision,
  };
}

function mapProviderSummaryContent(
  summary: ProviderMeetingSummaryWithEvidence,
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
