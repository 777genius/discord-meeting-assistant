import { DomainInvariantError } from "../domain/errors.js";
import {
  normalizeLiveGenerationTelemetry,
  normalizeLiveGenerationUsage,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
} from "../domain/live-generation.js";
import { LiveMeeting } from "../domain/live-meeting.js";
import type { LiveSummaryDraftSnapshot } from "../domain/live-summary.js";
import type { TranscriptTurnSnapshot } from "../domain/transcript.js";
import {
  estimateSchedulingTokens,
  generationBaseKey,
  generationBaseSnapshot,
  invalidGenerationFailure,
  isCompatibleGenerationBase,
  maximumCompatibleGenerationSaveAttempts,
  unexpectedLiveRefreshFailure,
  type GeneratedResult,
  type GenerationBase,
} from "./live-meeting-generation.js";
import type { CurrentLiveMeeting } from "./live-meeting-refresh-planning.js";
import type {
  IncrementalSummaryGenerationPort,
  LiveMeetingGenerationLedger,
  LiveMeetingSnapshotAndTimelineReader,
  LiveMeetingSummaryRepository,
} from "./ports/live-meeting.js";

export interface LiveSummaryCadencePolicy {
  readonly forceSummaryAfterMs: number;
  readonly maximumRecentContextTurns: number;
  readonly minimumNewTurnTokens: number;
  readonly minimumSummaryIntervalMs: number;
  readonly publishAfterMs: number;
  readonly recentContextOverlapMs: number;
}

export const defaultLiveSummaryCadencePolicy: LiveSummaryCadencePolicy = Object.freeze({
  forceSummaryAfterMs: 180_000,
  maximumRecentContextTurns: 256,
  minimumNewTurnTokens: 300,
  minimumSummaryIntervalMs: 90_000,
  publishAfterMs: 300_000,
  recentContextOverlapMs: 180_000,
});

type LiveSummaryPersistence = LiveMeetingGenerationLedger &
  LiveMeetingSnapshotAndTimelineReader &
  LiveMeetingSummaryRepository;

export interface LiveMeetingSummaryGenerationDependencies {
  readonly meetings: LiveSummaryPersistence;
  readonly policy: LiveSummaryCadencePolicy;
  readonly summarizer: IncrementalSummaryGenerationPort;
}

export interface GenerateLiveMeetingSummaryInput {
  readonly meeting: LiveMeeting;
  readonly newTurns: readonly TranscriptTurnSnapshot[];
  readonly nowMs: number;
  readonly turns: readonly TranscriptTurnSnapshot[];
}

/** Owns incremental-summary cadence, provider execution and durable settlement. */
export class LiveMeetingSummaryGenerationCoordinator {
  public constructor(
    private readonly dependencies: LiveMeetingSummaryGenerationDependencies,
  ) {}

  public isDue(
    meeting: LiveMeeting,
    elapsedMs: number,
    nowMs: number,
    newTurns: readonly TranscriptTurnSnapshot[],
  ): boolean {
    if (newTurns.length === 0) {
      return false;
    }
    if (meeting.status === "ended") {
      return true;
    }
    if (meeting.draftSummary === null) {
      return elapsedMs >= this.dependencies.policy.publishAfterMs;
    }
    const sinceLastSummary = nowMs - (meeting.summaryGeneratedAtMs ?? meeting.startedAtMs);
    if (sinceLastSummary < this.dependencies.policy.minimumSummaryIntervalMs) {
      return false;
    }
    return estimateSchedulingTokens(newTurns) >=
      this.dependencies.policy.minimumNewTurnTokens ||
      sinceLastSummary >= this.dependencies.policy.forceSummaryAfterMs;
  }

  public async generate(input: GenerateLiveMeetingSummaryInput): Promise<GeneratedResult> {
    const base = generationBaseSnapshot(input.meeting, input.turns);
    const newTurnIds = new Set(input.newTurns.map(({ turnId }) => turnId));
    const previousTurns = input.turns.filter(({ turnId }) => !newTurnIds.has(turnId));
    const overlapStartMs = Math.max(
      0,
      (input.newTurns[0]?.startMs ?? 0) - this.dependencies.policy.recentContextOverlapMs,
    );
    const recentContextTurns = previousTurns
      .filter(({ endMs }) => endMs >= overlapStartMs)
      .slice(-this.dependencies.policy.maximumRecentContextTurns);
    const nextSummaryRevision = (input.meeting.draftSummary?.revision ?? 0) + 1;
    let result;
    try {
      result = await this.dependencies.summarizer.generate({
        idempotencyKey: generationBaseKey(input.meeting, input.turns),
        knownSpeakerIds: [...new Set(input.turns.map(({ speakerId }) => speakerId))],
        knownTurnIds: input.turns.map(({ turnId }) => turnId),
        meetingId: input.meeting.meetingId,
        newTurns: input.newTurns,
        previousSummary: input.meeting.draftSummary,
        recentContextTurns,
        revision: nextSummaryRevision,
        throughTurnCount: input.turns.length,
      });
    } catch (error) {
      return {
        failure: unexpectedLiveRefreshFailure("generation", error),
        generated: false,
        stale: false,
      };
    }
    if (!result.ok) {
      await this.persistRejectedGeneration(input.meeting.meetingId, result);
      return {
        failure: result.failure,
        generated: false,
        stale: false,
        ...(result.telemetry === undefined ? {} : { telemetry: result.telemetry }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    }

    try {
      const applied = await this.applyGeneratedSummary(input.meeting.meetingId, base, {
        evidenceTurns: base.evidenceTurns,
        generatedAtMs: input.nowMs,
        summary: result.value.summary,
        ...(result.value.telemetry === undefined ? {} : { telemetry: result.value.telemetry }),
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      });
      if (!applied) {
        await this.persistRejectedGeneration(input.meeting.meetingId, result.value);
        return {
          generated: false,
          stale: true,
          ...(result.value.telemetry === undefined ? {} : { telemetry: result.value.telemetry }),
          ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
        };
      }
      return {
        generated: true,
        stale: false,
        ...(result.value.telemetry === undefined ? {} : { telemetry: result.value.telemetry }),
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      };
    } catch (error) {
      if (error instanceof DomainInvariantError) {
        await this.persistRejectedGeneration(input.meeting.meetingId, result.value);
        return {
          failure: invalidGenerationFailure(error),
          generated: false,
          stale: false,
          ...(result.value.telemetry === undefined ? {} : { telemetry: result.value.telemetry }),
          ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
        };
      }
      throw error;
    }
  }

  private async persistRejectedGeneration(
    meetingId: string,
    input: {
      readonly telemetry?: LiveGenerationTelemetrySnapshot;
      readonly usage?: LiveGenerationUsageSnapshot;
    },
  ): Promise<void> {
    if (input.usage !== undefined) {
      await this.dependencies.meetings.appendGenerationUsage(
        meetingId,
        normalizeLiveGenerationUsage(input.usage),
      );
    }
    if (input.telemetry !== undefined) {
      await this.dependencies.meetings.appendGenerationTelemetry(
        meetingId,
        normalizeLiveGenerationTelemetry(input.telemetry),
      );
    }
  }

  private async applyGeneratedSummary(
    meetingId: string,
    base: GenerationBase,
    input: {
      readonly evidenceTurns: readonly TranscriptTurnSnapshot[];
      readonly generatedAtMs: number;
      readonly summary: LiveSummaryDraftSnapshot;
      readonly telemetry?: LiveGenerationTelemetrySnapshot;
      readonly usage?: LiveGenerationUsageSnapshot;
    },
  ): Promise<boolean> {
    for (let attempt = 0; attempt < maximumCompatibleGenerationSaveAttempts; attempt += 1) {
      const current = await this.readCurrent(meetingId);
      if (current === null || !isCompatibleGenerationBase(current, base)) {
        return false;
      }
      const meeting = LiveMeeting.restore(current.snapshot);
      const expectedRevision = meeting.revision;
      meeting.acceptSummary(input);
      const generatedEvidenceIds = new Set(input.evidenceTurns.map(({ turnId }) => turnId));
      try {
        await this.dependencies.meetings.commitSummary({
          expectedRevision,
          newlySummarizedTurnIds: current.timeline
            .filter(({ isSummarized, turn }) =>
              !isSummarized && generatedEvidenceIds.has(turn.turnId)
            )
            .map(({ turn }) => turn.turnId),
          snapshot: meeting.toSnapshot(),
          ...(input.telemetry === undefined
            ? {}
            : { telemetry: normalizeLiveGenerationTelemetry(input.telemetry) }),
          ...(input.usage === undefined
            ? {}
            : { usage: normalizeLiveGenerationUsage(input.usage) }),
        });
        return true;
      } catch (error) {
        const latest = await this.readCurrent(meetingId);
        if (latest === null || !isCompatibleGenerationBase(latest, base)) {
          return false;
        }
        if (latest.snapshot.revision === expectedRevision) {
          throw error;
        }
      }
    }
    return false;
  }

  private readCurrent(meetingId: string): Promise<CurrentLiveMeeting | null> {
    return this.dependencies.meetings.readSnapshotAndTimeline(meetingId);
  }
}
