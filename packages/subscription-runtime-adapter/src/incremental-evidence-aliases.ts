import type {
  IncrementalSummaryGenerationRequest,
  LiveSummaryDraftSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";
import type { TranscriptTurnSnapshot } from "@discord-meeting/meeting-core/transcription";

import { SubscriptionRuntimeAdapterError } from "./errors.js";
import type { ProviderIncrementalMeetingSummary } from "./provider-summary-schema.js";

export interface IncrementalEvidenceAliases {
  readonly citableTurnIds: readonly string[];
  mapPreviousSummary(
    summary: LiveSummaryDraftSnapshot | null,
  ): ProviderPromptPreviousSummary | null;
  mapTurn(turn: TranscriptTurnSnapshot): ProviderPromptTurn;
  restoreSummary(
    summary: ProviderIncrementalMeetingSummary,
  ): ProviderIncrementalMeetingSummary;
}

interface ProviderPromptTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

type ProviderPromptPreviousSummary = Omit<LiveSummaryDraftSnapshot, "actionItems" | "decisions" | "openQuestions" | "topics"> & {
  readonly actionItems: readonly {
    readonly deadline: string | null;
    readonly evidenceTurnIds: readonly string[];
    readonly ownerSpeakerId: string | null;
    readonly text: string;
  }[];
  readonly decisions: readonly {
    readonly evidenceTurnIds: readonly string[];
    readonly text: string;
  }[];
  readonly openQuestions: readonly {
    readonly evidenceTurnIds: readonly string[];
    readonly text: string;
  }[];
  readonly topics: readonly {
    readonly evidenceTurnIds: readonly string[];
    readonly points: readonly string[];
    readonly title: string;
  }[];
};

/** Keeps opaque canonical turn IDs out of the provider prompt and output. */
export function createIncrementalEvidenceAliases(
  request: IncrementalSummaryGenerationRequest,
): IncrementalEvidenceAliases {
  const citableCanonicalIds = new Set([
    ...request.previousSummaryEvidenceTurns.map(({ turnId }) => turnId),
    ...request.recentContextTurns.map(({ turnId }) => turnId),
    ...request.newTurns.map(({ turnId }) => turnId),
  ]);
  const orderedCanonicalIds = request.knownTurnIds.filter((turnId) =>
    citableCanonicalIds.has(turnId)
  );
  if (orderedCanonicalIds.length !== citableCanonicalIds.size) {
    throw new SubscriptionRuntimeAdapterError(
      "invalid_input",
      "Citable incremental evidence must be present in knownTurnIds",
    );
  }
  const canonicalToAlias = new Map(
    orderedCanonicalIds.map((turnId, index) => [turnId, `e${index + 1}`]),
  );
  const aliasToCanonical = new Map(
    [...canonicalToAlias].map(([turnId, alias]) => [alias, turnId]),
  );
  const aliasTurnId = (turnId: string): string => {
    const alias = canonicalToAlias.get(turnId);
    if (alias === undefined) {
      throw new SubscriptionRuntimeAdapterError(
        "invalid_input",
        "Incremental evidence turn has no provider alias",
      );
    }
    return alias;
  };
  const restoreEvidence = (turnIds: readonly string[]): string[] =>
    turnIds.map((alias) => {
      const turnId = aliasToCanonical.get(alias);
      if (turnId === undefined) {
        throw new SubscriptionRuntimeAdapterError(
          "invalid_evidence",
          "Summary references an unknown citable evidence alias",
        );
      }
      return turnId;
    });
  return {
    citableTurnIds: orderedCanonicalIds.map(aliasTurnId),
    mapPreviousSummary: (summary) => summary === null
      ? null
      : mapPreviousSummary(summary, aliasTurnId),
    mapTurn: (turn) => ({ ...turn, turnId: aliasTurnId(turn.turnId) }),
    restoreSummary: (summary) => ({
      ...summary,
      actionItems: summary.actionItems.map((item) => ({
        ...item,
        evidenceTurnIds: restoreEvidence(item.evidenceTurnIds),
      })),
      decisions: summary.decisions.map((item) => ({
        ...item,
        evidenceTurnIds: restoreEvidence(item.evidenceTurnIds),
      })),
      openQuestions: summary.openQuestions.map((item) => ({
        ...item,
        evidenceTurnIds: restoreEvidence(item.evidenceTurnIds),
      })),
      topics: summary.topics.map((item) => ({
        ...item,
        evidenceTurnIds: restoreEvidence(item.evidenceTurnIds),
      })),
    }),
  };
}

function mapPreviousSummary(
  summary: LiveSummaryDraftSnapshot,
  aliasTurnId: (turnId: string) => string,
): ProviderPromptPreviousSummary {
  return {
    actionItems: summary.actionItems.map(({ deadline, evidenceTurnIds, ownerSpeakerId, text }) => ({
      deadline,
      evidenceTurnIds: evidenceTurnIds.map(aliasTurnId),
      ownerSpeakerId,
      text,
    })),
    decisions: summary.decisions.map(({ evidenceTurnIds, text }) => ({
      evidenceTurnIds: evidenceTurnIds.map(aliasTurnId),
      text,
    })),
    openQuestions: summary.openQuestions.map(({ evidenceTurnIds, text }) => ({
      evidenceTurnIds: evidenceTurnIds.map(aliasTurnId),
      text,
    })),
    overview: summary.overview,
    revision: summary.revision,
    title: summary.title,
    topics: summary.topics.map(({ evidenceTurnIds, points, title }) => ({
      evidenceTurnIds: evidenceTurnIds.map(aliasTurnId),
      points: [...points],
      title,
    })),
  };
}
