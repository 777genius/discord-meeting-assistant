import { DomainInvariantError, requireNonEmpty, requirePositiveInteger } from "./errors.js";
import type {
  SummaryActionItemSnapshot,
  SummaryDecisionSnapshot,
  SummaryOpenQuestionSnapshot,
  SummaryTopicSnapshot,
} from "../../meeting-intelligence/index.js";
import type { TranscriptTurn } from "../../transcription/index.js";

export interface LiveSummaryDraftSnapshot {
  readonly actionItems: readonly SummaryActionItemSnapshot[];
  readonly decisions: readonly SummaryDecisionSnapshot[];
  readonly openQuestions: readonly SummaryOpenQuestionSnapshot[];
  readonly overview: string;
  readonly revision: number;
  readonly title: string;
  readonly topics: readonly SummaryTopicSnapshot[];
}

function requireUniqueIdentifiers(identifiers: readonly string[]): void {
  if (new Set(identifiers).size !== identifiers.length) {
    throw new DomainInvariantError(
      "DUPLICATE_IDENTIFIER",
      "live summary structured item IDs must be unique",
    );
  }
}

/** Validates a summary against the immutable evidence supplied for this generation. */
export function normalizeLiveSummary(
  input: LiveSummaryDraftSnapshot,
  turns: readonly TranscriptTurn[] | undefined,
  expectedRevision: number,
): LiveSummaryDraftSnapshot {
  if (input.revision !== expectedRevision) {
    throw new DomainInvariantError(
      "CONFLICTING_COMPLETION",
      "live summary revision must advance exactly once",
    );
  }
  const knownTurns = turns === undefined
    ? undefined
    : new Set(turns.map(({ turnId }) => String(turnId)));
  const knownSpeakers = turns === undefined
    ? undefined
    : new Set(turns.map(({ speakerId }) => String(speakerId)));
  const evidenceGroups = [
    ...input.topics.map(({ evidenceTurnIds }) => evidenceTurnIds),
    ...input.decisions.map(({ evidenceTurnIds }) => evidenceTurnIds),
    ...input.actionItems.map(({ evidenceTurnIds }) => evidenceTurnIds),
    ...input.openQuestions.map(({ evidenceTurnIds }) => evidenceTurnIds),
  ];
  for (const evidenceTurnIds of evidenceGroups) {
    if (
      evidenceTurnIds.length === 0 ||
      new Set(evidenceTurnIds).size !== evidenceTurnIds.length ||
      (knownTurns !== undefined && evidenceTurnIds.some((turnId) => !knownTurns.has(turnId)))
    ) {
      throw new DomainInvariantError(
        "INVALID_EVIDENCE_REFERENCE",
        "live summary evidence must reference unique known finalized turns",
      );
    }
  }
  if (
    input.actionItems.some(
      ({ ownerSpeakerId }) =>
        ownerSpeakerId !== null &&
        knownSpeakers !== undefined &&
        !knownSpeakers.has(ownerSpeakerId),
    )
  ) {
    throw new DomainInvariantError(
      "INVALID_EVIDENCE_REFERENCE",
      "live summary action owner must be a known speaker",
    );
  }

  const actionItems = input.actionItems.map((item) => Object.freeze({
    actionItemId: requireNonEmpty(item.actionItemId, "liveSummary.actionItemId"),
    deadline: item.deadline === null
      ? null
      : requireNonEmpty(item.deadline, "liveSummary.actionItem.deadline"),
    evidenceTurnIds: Object.freeze([...item.evidenceTurnIds]),
    ownerSpeakerId: item.ownerSpeakerId,
    text: requireNonEmpty(item.text, "liveSummary.actionItem.text"),
  }));
  const decisions = input.decisions.map((item) => Object.freeze({
    decisionId: requireNonEmpty(item.decisionId, "liveSummary.decisionId"),
    evidenceTurnIds: Object.freeze([...item.evidenceTurnIds]),
    text: requireNonEmpty(item.text, "liveSummary.decision.text"),
  }));
  const openQuestions = input.openQuestions.map((item) => Object.freeze({
    evidenceTurnIds: Object.freeze([...item.evidenceTurnIds]),
    id: requireNonEmpty(item.id, "liveSummary.openQuestion.id"),
    text: requireNonEmpty(item.text, "liveSummary.openQuestion.text"),
  }));
  requireUniqueIdentifiers(actionItems.map(({ actionItemId }) => actionItemId));
  requireUniqueIdentifiers(decisions.map(({ decisionId }) => decisionId));
  requireUniqueIdentifiers(openQuestions.map(({ id }) => id));

  return Object.freeze({
    actionItems: Object.freeze(actionItems),
    decisions: Object.freeze(decisions),
    openQuestions: Object.freeze(openQuestions),
    overview: requireNonEmpty(input.overview, "liveSummary.overview"),
    revision: requirePositiveInteger(input.revision, "liveSummary.revision"),
    title: requireNonEmpty(input.title, "liveSummary.title"),
    topics: Object.freeze(input.topics.map((topic) => Object.freeze({
      ...topic,
      evidenceTurnIds: Object.freeze([...topic.evidenceTurnIds]),
      points: Object.freeze(topic.points.map((point) =>
        requireNonEmpty(point, "liveSummary.topic.point")
      )),
      title: requireNonEmpty(topic.title, "liveSummary.topic.title"),
    }))),
  });
}
