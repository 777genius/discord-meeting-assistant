import { DomainInvariantError } from "../domain/errors.js";
import {
  normalizeLiveGenerationTelemetry,
  normalizeLiveGenerationUsage,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
} from "../domain/live-generation.js";
import {
  LiveMeeting,
  type LiveMeetingSnapshot,
} from "../domain/live-meeting.js";
import type { LiveSummaryDraftSnapshot } from "../domain/live-summary.js";
import type { StageFailure } from "../domain/meeting.js";
import type { TranscriptTurnSnapshot } from "../domain/transcript.js";
import type {
  IncrementalSummaryGenerationPort,
  LiveCaptionSnapshot,
  LiveMeetingProjectionPhase,
  LiveMeetingProjectionPort,
  LiveMeetingRepository,
  LiveMeetingSnapshotAndTimelineReader,
} from "./ports.js";
import {
  LiveMeetingProjectionCoordinator,
  type LiveProjectionResult,
} from "./live-meeting-projection.js";
import {
  currentTurns,
  hasVisibleCaption,
  isInitialProjectionDue,
  isProjectionDue,
  resolvedProjectionPhase,
  type CurrentLiveMeeting,
  type RefreshPlan,
} from "./live-meeting-refresh-planning.js";

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

export interface RefreshLiveMeetingDependencies {
  readonly meetings: LiveMeetingRepository & LiveMeetingSnapshotAndTimelineReader;
  readonly policy?: LiveSummaryCadencePolicy;
  readonly projector: LiveMeetingProjectionPort;
  readonly summarizer: IncrementalSummaryGenerationPort;
}

export interface RefreshLiveMeetingInput {
  readonly captions: readonly LiveCaptionSnapshot[];
  readonly meetingId: string;
  readonly nowMs: number;
  readonly projectionPhase?: LiveMeetingProjectionPhase;
  readonly projection?: "allow" | "skip";
  readonly projectionRequested?: boolean;
  readonly summaryGeneration?: "cadence" | "skip";
}

export type RefreshLiveMeetingResult =
  | { readonly status: "not-found" }
  | {
      readonly generationFailure?: StageFailure;
      readonly generationBase?: string;
      readonly generationStale?: boolean;
      readonly generationTelemetry?: LiveGenerationTelemetrySnapshot;
      readonly generationUsage?: LiveGenerationUsageSnapshot;
      readonly generated: boolean;
      readonly projected: boolean;
      readonly projectionFailure?: StageFailure;
      readonly status: "refreshed";
    };

interface GenerationBase {
  readonly draftSummaryRevision: number | null;
  readonly evidenceTurns: readonly TranscriptTurnSnapshot[];
  readonly status: LiveMeetingSnapshot["status"];
}

interface GeneratedResult {
  readonly failure?: StageFailure;
  readonly generated: boolean;
  readonly stale: boolean;
  readonly telemetry?: LiveGenerationTelemetrySnapshot;
  readonly usage?: LiveGenerationUsageSnapshot;
}

const maximumCompatibleGenerationSaveAttempts = 3;

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}

function operationIdentity(operation: string, ...parts: readonly string[]): string {
  return [operation, ...parts.map(identityPart)].join("|");
}

function estimateSchedulingTokens(turns: readonly TranscriptTurnSnapshot[]): number {
  const characters = turns.reduce((total, turn) => total + turn.text.length, 0);
  return Math.ceil(characters / 3);
}

function unexpectedFailure(stage: "generation" | "projection", error: unknown): StageFailure {
  return {
    code: `UNEXPECTED_LIVE_${stage.toUpperCase()}_FAILURE`,
    message: error instanceof Error ? error.message : `Unexpected live ${stage} failure`,
    retryable: true,
  };
}

function invalidGenerationFailure(error: unknown): StageFailure {
  return {
    code: "INVALID_LIVE_SUMMARY_OUTPUT",
    message: error instanceof Error ? error.message : "Invalid live summary output",
    retryable: false,
  };
}

function sameTurn(left: TranscriptTurnSnapshot, right: TranscriptTurnSnapshot): boolean {
  return left.turnId === right.turnId &&
    left.speakerId === right.speakerId &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.text === right.text;
}

function generationBaseSnapshot(
  meeting: LiveMeeting,
  turns: readonly TranscriptTurnSnapshot[],
): GenerationBase {
  return {
    draftSummaryRevision: meeting.draftSummary?.revision ?? null,
    evidenceTurns: turns.map((turn) => ({ ...turn })),
    status: meeting.status,
  };
}

function containsUnchangedEvidence(
  turns: readonly TranscriptTurnSnapshot[],
  evidenceTurns: readonly TranscriptTurnSnapshot[],
): boolean {
  const turnsById = new Map(turns.map((turn) => [turn.turnId, turn]));
  return evidenceTurns.every((evidenceTurn) => {
    const currentTurn = turnsById.get(evidenceTurn.turnId);
    return currentTurn !== undefined && sameTurn(currentTurn, evidenceTurn);
  });
}

function isCompatibleGenerationBase(
  current: CurrentLiveMeeting,
  base: GenerationBase,
): boolean {
  return current.snapshot.status === base.status &&
    (current.snapshot.draftSummary?.revision ?? null) === base.draftSummaryRevision &&
    containsUnchangedEvidence(currentTurns(current.timeline), base.evidenceTurns);
}

function refreshedResult(
  generationBase: string | undefined,
  generation: GeneratedResult,
  projection: LiveProjectionResult,
): RefreshLiveMeetingResult {
  return {
    ...(generation.failure === undefined ? {} : { generationFailure: generation.failure }),
    ...(generationBase === undefined ? {} : { generationBase }),
    ...(generation.stale ? { generationStale: true } : {}),
    ...(generation.telemetry === undefined ? {} : { generationTelemetry: generation.telemetry }),
    ...(generation.usage === undefined ? {} : { generationUsage: generation.usage }),
    generated: generation.generated,
    projected: projection.projected,
    ...(projection.failure === undefined ? {} : { projectionFailure: projection.failure }),
    status: "refreshed",
  };
}

function generationBaseKey(
  meeting: LiveMeeting,
  turns: readonly TranscriptTurnSnapshot[],
): string {
  const nextSummaryRevision = (meeting.draftSummary?.revision ?? 0) + 1;
  return operationIdentity(
    "live-evidence-summary:v3",
    meeting.meetingId,
    String(nextSummaryRevision),
    meeting.status,
    String(turns.length),
    turns.at(-1)?.turnId ?? "none",
  );
}

export class RefreshLiveMeeting {
  private readonly policy: LiveSummaryCadencePolicy;
  private readonly projection: LiveMeetingProjectionCoordinator;

  public constructor(private readonly dependencies: RefreshLiveMeetingDependencies) {
    this.policy = dependencies.policy ?? defaultLiveSummaryCadencePolicy;
    this.projection = new LiveMeetingProjectionCoordinator(
      dependencies.meetings,
      dependencies.projector,
    );
  }

  public async execute(input: RefreshLiveMeetingInput): Promise<RefreshLiveMeetingResult> {
    const current = await this.readCurrent(input.meetingId);
    if (current === null) {
      return { status: "not-found" };
    }
    const plan = this.createPlan(current, input);
    const initialProjection = await this.projectIfDue(plan, input.captions);
    const generation = await this.generateIfDue(plan);
    const projection = await this.projectAfterGeneration(
      plan,
      input.captions,
      generation,
      initialProjection,
    );
    if (projection === null) {
      return { status: "not-found" };
    }
    return refreshedResult(plan.generationBase, generation, projection);
  }

  private createPlan(
    current: CurrentLiveMeeting,
    input: RefreshLiveMeetingInput,
  ): RefreshPlan {
    const meeting = LiveMeeting.restore(current.snapshot);
    const turns = currentTurns(current.timeline);
    const newTurns = current.timeline
      .filter(({ isSummarized }) => !isSummarized)
      .map(({ turn }) => turn);
    const nowMs = Math.max(meeting.startedAtMs, input.nowMs);
    const elapsedMs = nowMs - meeting.startedAtMs;
    const projectionPhase = resolvedProjectionPhase(input.projectionPhase, meeting);
    const projectionAllowed = input.projection !== "skip";
    const projectionRequested = input.projectionRequested ?? true;
    const initialProjectionDue = isInitialProjectionDue(
      meeting,
      elapsedMs,
      hasVisibleCaption(input.captions),
      turns.length,
      this.policy.publishAfterMs,
    );
    const canProject = meeting.projectionExternalId !== null || initialProjectionDue;
    return {
      canProject,
      elapsedMs,
      generationBase: newTurns.length === 0 ? undefined : generationBaseKey(meeting, turns),
      meeting,
      newTurns,
      nowMs,
      projectionAllowed,
      projectionPhase,
      shouldGenerate: input.summaryGeneration !== "skip" &&
        this.shouldGenerate(meeting, elapsedMs, nowMs, newTurns),
      shouldProject: isProjectionDue(
        meeting,
        projectionPhase,
        canProject,
        projectionRequested,
      ),
      turns,
    };
  }

  private generateIfDue(plan: RefreshPlan): Promise<GeneratedResult> {
    return plan.shouldGenerate
      ? this.generate(plan.meeting, plan.turns, plan.newTurns, plan.nowMs)
      : Promise.resolve({ generated: false, stale: false });
  }

  private projectIfDue(
    plan: RefreshPlan,
    captions: readonly LiveCaptionSnapshot[],
  ): Promise<LiveProjectionResult> {
    return plan.projectionAllowed && plan.shouldProject
      ? this.projection.publish({
          captions,
          elapsedMs: plan.elapsedMs,
          meeting: plan.meeting,
          nowMs: plan.nowMs,
          phase: plan.projectionPhase,
        })
      : Promise.resolve({ projected: false });
  }

  private async projectAfterGeneration(
    plan: RefreshPlan,
    captions: readonly LiveCaptionSnapshot[],
    generation: GeneratedResult,
    initialProjection: LiveProjectionResult,
  ): Promise<LiveProjectionResult | null> {
    if (!generation.generated || !plan.canProject || !plan.projectionAllowed) {
      return initialProjection;
    }
    const updated = await this.readCurrent(plan.meeting.meetingId);
    if (updated === null) {
      return null;
    }
    const refreshedProjection = await this.projection.publish({
      captions,
      elapsedMs: plan.elapsedMs,
      meeting: LiveMeeting.restore(updated.snapshot),
      nowMs: plan.nowMs,
      phase: plan.projectionPhase,
    });
    return {
      ...(refreshedProjection.failure === undefined
        ? {}
        : { failure: refreshedProjection.failure }),
      projected: initialProjection.projected || refreshedProjection.projected,
    };
  }

  private shouldGenerate(
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
      return elapsedMs >= this.policy.publishAfterMs;
    }
    const sinceLastSummary = nowMs - (meeting.summaryGeneratedAtMs ?? meeting.startedAtMs);
    if (sinceLastSummary < this.policy.minimumSummaryIntervalMs) {
      return false;
    }
    return estimateSchedulingTokens(newTurns) >= this.policy.minimumNewTurnTokens ||
      sinceLastSummary >= this.policy.forceSummaryAfterMs;
  }

  private async generate(
    meeting: LiveMeeting,
    turns: readonly TranscriptTurnSnapshot[],
    newTurns: readonly TranscriptTurnSnapshot[],
    nowMs: number,
  ): Promise<GeneratedResult> {
    const base = generationBaseSnapshot(meeting, turns);
    const newTurnIds = new Set(newTurns.map(({ turnId }) => turnId));
    const previousTurns = turns.filter(({ turnId }) => !newTurnIds.has(turnId));
    const overlapStartMs = Math.max(0, (newTurns[0]?.startMs ?? 0) - this.policy.recentContextOverlapMs);
    const recentContextTurns = previousTurns
      .filter(({ endMs }) => endMs >= overlapStartMs)
      .slice(-this.policy.maximumRecentContextTurns);
    const nextSummaryRevision = (meeting.draftSummary?.revision ?? 0) + 1;
    let result;
    try {
      result = await this.dependencies.summarizer.generate({
        idempotencyKey: generationBaseKey(meeting, turns),
        knownSpeakerIds: [...new Set(turns.map(({ speakerId }) => speakerId))],
        knownTurnIds: turns.map(({ turnId }) => turnId),
        meetingId: meeting.meetingId,
        newTurns,
        previousSummary: meeting.draftSummary,
        recentContextTurns,
        revision: nextSummaryRevision,
        throughTurnCount: turns.length,
      });
    } catch (error) {
      return { failure: unexpectedFailure("generation", error), generated: false, stale: false };
    }
    if (!result.ok) {
      await this.persistRejectedGeneration(meeting.meetingId, result);
      return {
        failure: result.failure,
        generated: false,
        stale: false,
        ...(result.telemetry === undefined ? {} : { telemetry: result.telemetry }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    }

    try {
      const applied = await this.applyGeneratedSummary(meeting.meetingId, base, {
        evidenceTurns: base.evidenceTurns,
        generatedAtMs: nowMs,
        summary: result.value.summary,
        ...(result.value.telemetry === undefined ? {} : { telemetry: result.value.telemetry }),
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      });
      if (!applied) {
        await this.persistRejectedGeneration(meeting.meetingId, result.value);
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
        await this.persistRejectedGeneration(meeting.meetingId, result.value);
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
            .filter(({ isSummarized, turn }) => !isSummarized && generatedEvidenceIds.has(turn.turnId))
            .map(({ turn }) => turn.turnId),
          snapshot: meeting.toSnapshot(),
          ...(input.telemetry === undefined
            ? {}
            : { telemetry: normalizeLiveGenerationTelemetry(input.telemetry) }),
          ...(input.usage === undefined ? {} : { usage: normalizeLiveGenerationUsage(input.usage) }),
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

  private async readCurrent(meetingId: string): Promise<CurrentLiveMeeting | null> {
    return this.dependencies.meetings.readSnapshotAndTimeline(meetingId);
  }
}
