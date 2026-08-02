import {
  DomainInvariantError,
  requireNonEmpty,
  requirePositiveInteger,
} from "./errors.js";
import {
  createSpeakerId,
  createSummaryId,
  createTranscriptId,
  type SpeakerId,
  type SummaryId,
  type TranscriptId,
} from "./identifiers.js";
import type { FinalTranscript } from "./transcript.js";

export interface SummaryDecisionSnapshot {
  readonly decisionId: string;
  readonly evidenceTurnIds: readonly string[];
  readonly text: string;
}

export interface SummaryActionItemSnapshot {
  readonly actionItemId: string;
  readonly deadline: string | null;
  readonly evidenceTurnIds: readonly string[];
  readonly ownerSpeakerId: string | null;
  readonly text: string;
}

export interface SummaryOpenQuestionSnapshot {
  readonly evidenceTurnIds: readonly string[];
  readonly id: string;
  readonly text: string;
}

export interface SummaryTopicSnapshot {
  readonly evidenceTurnIds: readonly string[];
  readonly points: readonly string[];
  readonly title: string;
}

export interface EvidenceBackedSummarySnapshot {
  readonly actionItems: readonly SummaryActionItemSnapshot[];
  readonly decisions: readonly SummaryDecisionSnapshot[];
  /** Legacy question text retained during restore but excluded from publication. */
  readonly legacyUnverifiedOpenQuestions?: readonly string[];
  readonly openQuestions: readonly SummaryOpenQuestionSnapshot[];
  readonly overview: string;
  readonly summaryId: string;
  readonly title: string;
  readonly topics: readonly SummaryTopicSnapshot[];
  readonly transcriptId: string;
  readonly version: number;
}

export interface SummaryDecision {
  readonly decisionId: string;
  readonly evidenceTurnIds: readonly string[];
  readonly text: string;
}

export interface SummaryActionItem {
  readonly actionItemId: string;
  readonly deadline: string | null;
  readonly evidenceTurnIds: readonly string[];
  readonly ownerSpeakerId: SpeakerId | null;
  readonly text: string;
}

export interface SummaryOpenQuestion {
  readonly evidenceTurnIds: readonly string[];
  readonly id: string;
  readonly text: string;
}

export interface SummaryTopic {
  readonly evidenceTurnIds: readonly string[];
  readonly points: readonly string[];
  readonly title: string;
}

type LegacySummaryActionItemSnapshot = Omit<SummaryActionItemSnapshot, "deadline">;

type LegacyEvidenceBackedSummarySnapshot = Omit<
  EvidenceBackedSummarySnapshot,
  "actionItems" | "topics"
> & {
  readonly actionItems: readonly LegacySummaryActionItemSnapshot[];
};

type SummaryCreationSnapshot =
  | EvidenceBackedSummarySnapshot
  | LegacyEvidenceBackedSummarySnapshot;

function validateEvidence(
  evidenceTurnIds: readonly string[],
  transcript: FinalTranscript,
  field: string,
): readonly string[] {
  if (evidenceTurnIds.length === 0) {
    throw new DomainInvariantError(
      "EVIDENCE_REQUIRED",
      `${field} must reference at least one transcript turn`,
    );
  }

  const normalized = evidenceTurnIds.map((turnId) => requireNonEmpty(turnId, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new DomainInvariantError(
      "DUPLICATE_IDENTIFIER",
      `${field} cannot contain duplicate transcript turn IDs`,
    );
  }

  for (const turnId of normalized) {
    if (!transcript.hasTurn(turnId)) {
      throw new DomainInvariantError(
        "INVALID_EVIDENCE_REFERENCE",
        `${field} references unknown transcript turn ${turnId}`,
      );
    }
  }

  return Object.freeze(normalized);
}

function requireOpenQuestionSnapshot(value: unknown): SummaryOpenQuestionSnapshot {
  if (typeof value !== "object" || value === null) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "summary.openQuestions must use the evidence-backed question contract",
    );
  }
  const candidate = value as Record<string, unknown>;
  const evidenceTurnIds = candidate["evidenceTurnIds"];
  if (
    !Array.isArray(evidenceTurnIds) ||
    evidenceTurnIds.some((turnId) => typeof turnId !== "string") ||
    typeof candidate["id"] !== "string" ||
    typeof candidate["text"] !== "string"
  ) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "summary.openQuestions must use the evidence-backed question contract",
    );
  }
  return {
    evidenceTurnIds,
    id: candidate["id"],
    text: candidate["text"],
  };
}

export class EvidenceBackedSummary {
  public readonly summaryId: SummaryId;
  public readonly transcriptId: TranscriptId;
  public readonly version: number;
  public readonly title: string;
  public readonly overview: string;
  public readonly decisions: readonly SummaryDecision[];
  public readonly actionItems: readonly SummaryActionItem[];
  public readonly openQuestions: readonly SummaryOpenQuestion[];
  public readonly topics: readonly SummaryTopic[];
  private readonly legacyUnverifiedOpenQuestions: readonly string[];

  private constructor(snapshot: SummaryCreationSnapshot, transcript: FinalTranscript) {
    this.summaryId = createSummaryId(snapshot.summaryId);
    this.transcriptId = createTranscriptId(snapshot.transcriptId);
    if (this.transcriptId !== transcript.transcriptId) {
      throw new DomainInvariantError(
        "INVALID_EVIDENCE_REFERENCE",
        "summary transcriptId must match the evidence transcript",
      );
    }
    this.version = requirePositiveInteger(snapshot.version, "summary.version");
    this.title = requireNonEmpty(snapshot.title, "summary.title");
    this.overview = requireNonEmpty(snapshot.overview, "summary.overview");
    this.legacyUnverifiedOpenQuestions = Object.freeze(
      (snapshot.legacyUnverifiedOpenQuestions ?? []).map((question) =>
        requireNonEmpty(question, "summary.legacyUnverifiedOpenQuestion"),
      ),
    );

    const decisions = snapshot.decisions.map((decision) =>
      Object.freeze({
        decisionId: requireNonEmpty(decision.decisionId, "summary.decisionId"),
        evidenceTurnIds: validateEvidence(
          decision.evidenceTurnIds,
          transcript,
          "summary.decision.evidenceTurnIds",
        ),
        text: requireNonEmpty(decision.text, "summary.decision.text"),
      }),
    );
    if (new Set(decisions.map(({ decisionId }) => decisionId)).size !== decisions.length) {
      throw new DomainInvariantError(
        "DUPLICATE_IDENTIFIER",
        "summary decision IDs must be unique",
      );
    }

    const actionItems = snapshot.actionItems.map((actionItem) => {
      const ownerSpeakerId =
        actionItem.ownerSpeakerId === null
          ? null
          : createSpeakerId(actionItem.ownerSpeakerId);
      if (ownerSpeakerId !== null && !transcript.hasSpeaker(ownerSpeakerId)) {
        throw new DomainInvariantError(
          "INVALID_OWNER_REFERENCE",
          `summary action item owner ${ownerSpeakerId} is not a transcript speaker`,
        );
      }

      return Object.freeze({
        actionItemId: requireNonEmpty(
          actionItem.actionItemId,
          "summary.actionItemId",
        ),
        deadline:
          "deadline" in actionItem && actionItem.deadline !== null
            ? requireNonEmpty(actionItem.deadline, "summary.actionItem.deadline")
            : null,
        evidenceTurnIds: validateEvidence(
          actionItem.evidenceTurnIds,
          transcript,
          "summary.actionItem.evidenceTurnIds",
        ),
        ownerSpeakerId,
        text: requireNonEmpty(actionItem.text, "summary.actionItem.text"),
      });
    });
    if (
      new Set(actionItems.map(({ actionItemId }) => actionItemId)).size !==
      actionItems.length
    ) {
      throw new DomainInvariantError(
        "DUPLICATE_IDENTIFIER",
        "summary action item IDs must be unique",
      );
    }

    this.decisions = Object.freeze(decisions);
    this.actionItems = Object.freeze(actionItems);
    this.topics = Object.freeze(
      ("topics" in snapshot ? snapshot.topics : []).map((topic) => {
        if (topic.points.length === 0) {
          throw new DomainInvariantError(
            "EMPTY_VALUE",
            "summary.topic.points must contain at least one point",
          );
        }
        return Object.freeze({
          evidenceTurnIds: validateEvidence(
            topic.evidenceTurnIds,
            transcript,
            "summary.topic.evidenceTurnIds",
          ),
          points: Object.freeze(
            topic.points.map((point) =>
              requireNonEmpty(point, "summary.topic.point"),
            ),
          ),
          title: requireNonEmpty(topic.title, "summary.topic.title"),
        });
      }),
    );
    const openQuestions = (snapshot.openQuestions as readonly unknown[]).map(
      (value) => {
        const question = requireOpenQuestionSnapshot(value);
        return Object.freeze({
          evidenceTurnIds: validateEvidence(
            question.evidenceTurnIds,
            transcript,
            "summary.openQuestion.evidenceTurnIds",
          ),
          id: requireNonEmpty(question.id, "summary.openQuestion.id"),
          text: requireNonEmpty(question.text, "summary.openQuestion.text"),
        });
      },
    );
    if (new Set(openQuestions.map(({ id }) => id)).size !== openQuestions.length) {
      throw new DomainInvariantError(
        "DUPLICATE_IDENTIFIER",
        "summary open question IDs must be unique",
      );
    }
    this.openQuestions = Object.freeze(openQuestions);
  }

  public static create(
    snapshot: EvidenceBackedSummarySnapshot,
    transcript: FinalTranscript,
  ): EvidenceBackedSummary;

  /** Restores summaries persisted before topics and action deadlines were added. */
  public static create(
    snapshot: LegacyEvidenceBackedSummarySnapshot,
    transcript: FinalTranscript,
  ): EvidenceBackedSummary;
  public static create(
    snapshot: SummaryCreationSnapshot,
    transcript: FinalTranscript,
  ): EvidenceBackedSummary {
    return new EvidenceBackedSummary(snapshot, transcript);
  }

  /** Restores current snapshots and quarantines legacy string-only questions. */
  public static restore(
    snapshot: EvidenceBackedSummarySnapshot,
    transcript: FinalTranscript,
  ): EvidenceBackedSummary {
    const openQuestions = snapshot.openQuestions as readonly (
      | string
      | SummaryOpenQuestionSnapshot
    )[];
    const legacyQuestions = openQuestions.filter(
      (question): question is string => typeof question === "string",
    );
    if (legacyQuestions.length === 0) {
      return new EvidenceBackedSummary(snapshot, transcript);
    }
    if (legacyQuestions.length !== openQuestions.length) {
      throw new DomainInvariantError(
        "INVALID_SNAPSHOT",
        "summary.openQuestions cannot mix legacy and evidence-backed questions",
      );
    }

    return new EvidenceBackedSummary(
      {
        ...snapshot,
        legacyUnverifiedOpenQuestions: [
          ...(snapshot.legacyUnverifiedOpenQuestions ?? []),
          ...legacyQuestions,
        ],
        openQuestions: [],
      },
      transcript,
    );
  }

  public toSnapshot(): EvidenceBackedSummarySnapshot {
    return {
      actionItems: this.actionItems.map((actionItem) => ({
        actionItemId: actionItem.actionItemId,
        deadline: actionItem.deadline,
        evidenceTurnIds: [...actionItem.evidenceTurnIds],
        ownerSpeakerId: actionItem.ownerSpeakerId,
        text: actionItem.text,
      })),
      decisions: this.decisions.map((decision) => ({
        decisionId: decision.decisionId,
        evidenceTurnIds: [...decision.evidenceTurnIds],
        text: decision.text,
      })),
      ...(this.legacyUnverifiedOpenQuestions.length === 0
        ? {}
        : {
            legacyUnverifiedOpenQuestions: [
              ...this.legacyUnverifiedOpenQuestions,
            ],
          }),
      openQuestions: this.openQuestions.map((question) => ({
        evidenceTurnIds: [...question.evidenceTurnIds],
        id: question.id,
        text: question.text,
      })),
      overview: this.overview,
      summaryId: this.summaryId,
      title: this.title,
      topics: this.topics.map((topic) => ({
        evidenceTurnIds: [...topic.evidenceTurnIds],
        points: [...topic.points],
        title: topic.title,
      })),
      transcriptId: this.transcriptId,
      version: this.version,
    };
  }

  public equals(other: EvidenceBackedSummary): boolean {
    return JSON.stringify(this.toSnapshot()) === JSON.stringify(other.toSnapshot());
  }
}
