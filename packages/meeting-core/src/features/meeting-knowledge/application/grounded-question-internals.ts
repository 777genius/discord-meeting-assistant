import { resolveAnswerLocale, type AnswerLocale } from "../domain/answer-locale.js";
import type { RehydratedEvidenceTurn } from "../domain/grounding-plan.js";
import { historicalEvidenceSourceKey } from
  "../domain/historical-evidence-source.js";
import { requiresExhaustiveCoverage } from "../domain/question-scope.js";
import type { HistoricalAuthorizationObservationV1 } from "./ports/historical-grounding.js";
import type { LiveFinalizedMemoryQueryPort } from "./ports/live-finalized-memory.js";
import type { FocusedHistoricalEvidenceV2Result } from
  "./ports/focused-locator-retrieval-v2.js";
import type { ExhaustiveCoverage } from "./exhaustive-coverage.js";

export type GroundedPlaybackAuthorityResultV1 =
  | { readonly schemaVersion: 1; readonly status: "current" }
  | { readonly reason: string; readonly schemaVersion: 1; readonly status: "stale" };

export interface GroundedPlaybackAuthorityRequest {
  readonly activeParticipantId: string;
  readonly authorizationPrincipalRef?: string;
  readonly citationTurnIds: readonly string[];
  readonly evidenceEpoch: string;
  readonly knowledgeEpoch: string;
  readonly locale: string;
  readonly meetingId: string;
  readonly question: string;
  readonly roomId: string;
}

interface PlaybackPreparedEvidence {
  readonly authorityGeneration: string;
  readonly knowledgeEpoch: string;
  readonly turns: readonly RehydratedEvidenceTurn[];
}

export async function recheckGroundedPlaybackAuthority(
  input: GroundedPlaybackAuthorityRequest & {
    readonly maximumCandidates: number;
    readonly signal: AbortSignal;
  },
  dependencies: {
    readonly authorize: (
      scopeId: string,
    ) => Promise<HistoricalAuthorizationObservationV1 | null>;
    readonly live: LiveFinalizedMemoryQueryPort;
    readonly prepare: (context: LiveContext) => Promise<
      PlaybackPreparedEvidence | "historical_unavailable" | "route_required" | null
    >;
  },
): Promise<GroundedPlaybackAuthorityResultV1> {
  input.signal.throwIfAborted();
  if (
    requiresExhaustiveCoverage(input.question) ||
    input.citationTurnIds.length === 0 ||
    input.citationTurnIds.length > input.maximumCandidates ||
    new Set(input.citationTurnIds).size !== input.citationTurnIds.length
  ) {
    return stalePlaybackAuthority("playback_fence_input_invalid");
  }
  const context = await dependencies.live.resolveContext({
    meetingId: input.meetingId,
    requesterActorId: input.activeParticipantId,
    roomId: input.roomId,
    signal: input.signal,
  });
  if (context === null || await dependencies.authorize(context.scopeId) === null) {
    return stalePlaybackAuthority("playback_authority_denied");
  }
  const prepared = await dependencies.prepare(context);
  if (prepared === null || prepared === "historical_unavailable" ||
    prepared === "route_required") {
    return stalePlaybackAuthority("playback_watermark_unavailable");
  }
  const currentTurnIds = new Set(prepared.turns.map(({ turnId }) => turnId));
  input.signal.throwIfAborted();
  return prepared.authorityGeneration === input.evidenceEpoch &&
      prepared.knowledgeEpoch === input.knowledgeEpoch &&
      input.citationTurnIds.every((turnId) => currentTurnIds.has(turnId))
    ? Object.freeze({ schemaVersion: 1, status: "current" as const })
    : stalePlaybackAuthority("playback_watermark_changed");
}

export async function executeActiveExhaustiveCoverage(input: {
  readonly activeParticipantId: string;
  readonly authorizationPrincipalRef?: string;
  readonly exhaustive: Pick<ExhaustiveCoverage, "buildPlan"> | undefined;
  readonly ids: { digest(namespace: string, parts: readonly string[]): string };
  readonly meetingId: string;
  readonly question: string;
  readonly roomId: string;
  readonly scopeId: string;
  readonly signal: AbortSignal;
}): Promise<ReturnType<typeof notAnswered>> {
  if (input.exhaustive === undefined || input.authorizationPrincipalRef === undefined) {
    return notAnswered("unavailable", "exhaustive_coverage_not_configured");
  }
  const result = await input.exhaustive.buildPlan({
    authorizationPrincipalRef: input.authorizationPrincipalRef,
    question: input.question,
    requestId: input.ids.digest("exhaustive-request", [
      input.meetingId,
      input.activeParticipantId,
      input.question,
    ]),
    roomId: input.roomId,
    scopeId: input.scopeId,
    signal: input.signal,
  });
  return result.status === "ready"
    ? notAnswered("insufficient_evidence", "active_meeting_not_final_for_exhaustive_claim")
    : notAnswered(
        result.status === "incomplete" ? "unavailable" : "insufficient_evidence",
        `exhaustive_${result.status}`,
      );
}

function stalePlaybackAuthority(reason: string): GroundedPlaybackAuthorityResultV1 {
  return Object.freeze({ reason, schemaVersion: 1, status: "stale" });
}

export function crossSourceTurns(
  current: readonly RehydratedEvidenceTurn[],
  historical: readonly RehydratedEvidenceTurn[],
  maximumCandidates: number,
): RehydratedEvidenceTurn[] {
  const selected: RehydratedEvidenceTurn[] = [];
  for (let rank = 0; selected.length < maximumCandidates; rank += 1) {
    const currentTurn = current[rank];
    const historicalTurn = historical[rank];
    if (currentTurn === undefined && historicalTurn === undefined) {
      break;
    }
    if (currentTurn !== undefined) {
      selected.push(currentTurn);
    }
    if (historicalTurn !== undefined && selected.length < maximumCandidates) {
      selected.push(historicalTurn);
    }
  }
  return selected;
}

export function deduplicateEvidenceTurns(
  values: readonly RehydratedEvidenceTurn[],
  fallback: {
    readonly meetingId: string;
    readonly transcriptId: string;
    readonly transcriptVersion: number;
  },
  existing: Map<string, RehydratedEvidenceTurn> = new Map(),
): Map<string, RehydratedEvidenceTurn> {
  for (const turn of values) {
    const source = turn.source;
    const key = [
      historicalEvidenceSourceKey(source?.historicalSource),
      source?.meetingId ?? fallback.meetingId,
      source?.transcriptId ?? fallback.transcriptId,
      String(source?.transcriptVersion ?? fallback.transcriptVersion),
      turn.turnId,
      String(source?.sourceStartCodePoint ?? "whole"),
      String(source?.sourceEndCodePoint ?? "whole"),
    ].join("\u0000");
    if (!existing.has(key)) {
      existing.set(key, turn);
    }
  }
  return existing;
}

export function sameAuthorization(
  admitted: HistoricalAuthorizationObservationV1,
  refreshed: HistoricalAuthorizationObservationV1,
): boolean {
  return admitted.authorized && refreshed.authorized &&
    admitted.authorizationDigest === refreshed.authorizationDigest &&
    admitted.authorizationEpoch === refreshed.authorizationEpoch &&
    admitted.policyVersion === refreshed.policyVersion;
}

type LiveContext = NonNullable<
  Awaited<ReturnType<LiveFinalizedMemoryQueryPort["resolveContext"]>>
>;

export function sameLiveContext(
  admitted: LiveContext,
  refreshed: LiveContext,
): boolean {
  return admitted.appliedGeneration === refreshed.appliedGeneration &&
    admitted.identityGeneration === refreshed.identityGeneration &&
    admitted.knowledgeEpoch === refreshed.knowledgeEpoch &&
    admitted.meetingId === refreshed.meetingId &&
    admitted.roomId === refreshed.roomId &&
    admitted.scopeId === refreshed.scopeId &&
    admitted.sourceGeneration === refreshed.sourceGeneration &&
    admitted.humanActorIds.length === refreshed.humanActorIds.length &&
    admitted.humanActorIds.every((actorId, index) =>
      actorId === refreshed.humanActorIds[index]
    );
}

export function normalizedLocale(locale: string, question: string): AnswerLocale {
  const normalized = locale.toLocaleLowerCase();
  return normalized.startsWith("ru")
    ? "ru"
    : normalized.startsWith("en")
      ? "en"
      : resolveAnswerLocale(question);
}

export function notAnswered(
  status: "cancelled" | "insufficient_evidence" | "unavailable",
  reason: string,
): {
  readonly reason: string;
  readonly schemaVersion: 1;
  readonly status: "cancelled" | "insufficient_evidence" | "unavailable";
} {
  return Object.freeze({ reason, schemaVersion: 1, status });
}

export function normalizeHistoricalResult(
  value: FocusedHistoricalEvidenceV2Result,
): FocusedHistoricalEvidenceV2Result {
  const candidate = value as unknown as Record<string, unknown>;
  if (candidate.status === "current" &&
    typeof candidate.authorityGeneration === "string" &&
    candidate.authorityGeneration.length > 0 && Array.isArray(candidate.turns)) {
    return value;
  }
  if (candidate.status === "empty" &&
    typeof candidate.authorityGeneration === "string" &&
    candidate.authorityGeneration.length > 0) {
    return value;
  }
  if (candidate.status === "unavailable" && typeof candidate.reason === "string") {
    return value;
  }
  return Object.freeze({ reason: "provider_result_unavailable",
    status: "unavailable" });
}

export function unavailableHistoricalResult(signal?: AbortSignal):
FocusedHistoricalEvidenceV2Result {
  signal?.throwIfAborted();
  return Object.freeze({ reason: "provider_result_unavailable",
    status: "unavailable" });
}
