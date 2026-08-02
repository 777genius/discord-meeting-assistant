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

export interface SummaryTopicSnapshot {
  readonly evidenceTurnIds: readonly string[];
  readonly points: readonly string[];
  readonly title: string;
}

export interface EvidenceBackedSummarySnapshot {
  readonly actionItems: readonly SummaryActionItemSnapshot[];
  readonly decisions: readonly SummaryDecisionSnapshot[];
  readonly openQuestions: readonly string[];
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

export class EvidenceBackedSummary {
  public readonly summaryId: SummaryId;
  public readonly transcriptId: TranscriptId;
  public readonly version: number;
  public readonly title: string;
  public readonly overview: string;
  public readonly decisions: readonly SummaryDecision[];
  public readonly actionItems: readonly SummaryActionItem[];
  public readonly openQuestions: readonly string[];
  public readonly topics: readonly SummaryTopic[];

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
    this.openQuestions = Object.freeze(
      snapshot.openQuestions.map((question) =>
        requireNonEmpty(question, "summary.openQuestion"),
      ),
    );
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
      openQuestions: [...this.openQuestions],
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
