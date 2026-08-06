import type {
  LiveGenerationTelemetrySnapshot,
  LiveGenerationUsageSnapshot,
} from "../domain/live-generation.js";
import { LiveMeeting } from "../domain/live-meeting.js";
import type {
  IncrementalSummaryGenerationPort,
  LiveCaptionSnapshot,
  LiveMeetingFailure,
  LiveMeetingGenerationLedger,
  LiveMeetingProjectionPhase,
  LiveMeetingProjectionPort,
  LiveMeetingSnapshotAndTimelineReader,
  LiveMeetingStateRepository,
  LiveMeetingSummaryRepository,
} from "./ports/live-meeting.js";
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
import {
  generationBaseKey,
  type GeneratedResult,
} from "./live-meeting-generation.js";
import {
  defaultLiveSummaryCadencePolicy,
  LiveMeetingSummaryGenerationCoordinator,
  type LiveSummaryCadencePolicy,
} from "./live-meeting-summary-generation.js";

export { defaultLiveSummaryCadencePolicy };
export type { LiveSummaryCadencePolicy };

export interface RefreshLiveMeetingDependencies {
  readonly meetings: LiveMeetingGenerationLedger &
    LiveMeetingSnapshotAndTimelineReader &
    LiveMeetingStateRepository &
    LiveMeetingSummaryRepository;
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
      readonly generationFailure?: LiveMeetingFailure;
      readonly generationBase?: string;
      readonly generationStale?: boolean;
      readonly generationTelemetry?: LiveGenerationTelemetrySnapshot;
      readonly generationUsage?: LiveGenerationUsageSnapshot;
      readonly generated: boolean;
      readonly projected: boolean;
      readonly projectionFailure?: LiveMeetingFailure;
      readonly status: "refreshed";
    };

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

/** Coordinates refresh planning, visible projection and summary generation boundaries. */
export class RefreshLiveMeeting {
  private readonly policy: LiveSummaryCadencePolicy;
  private readonly projection: LiveMeetingProjectionCoordinator;
  private readonly summaryGeneration: LiveMeetingSummaryGenerationCoordinator;

  public constructor(private readonly dependencies: RefreshLiveMeetingDependencies) {
    this.policy = dependencies.policy ?? defaultLiveSummaryCadencePolicy;
    this.projection = new LiveMeetingProjectionCoordinator(
      dependencies.meetings,
      dependencies.projector,
    );
    this.summaryGeneration = new LiveMeetingSummaryGenerationCoordinator({
      meetings: dependencies.meetings,
      policy: this.policy,
      summarizer: dependencies.summarizer,
    });
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
        this.summaryGeneration.isDue({ elapsedMs, meeting, newTurns, nowMs }),
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
      ? this.summaryGeneration.generate({
          meeting: plan.meeting,
          newTurns: plan.newTurns,
          nowMs: plan.nowMs,
          turns: plan.turns,
        })
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

  private readCurrent(meetingId: string): Promise<CurrentLiveMeeting | null> {
    return this.dependencies.meetings.readSnapshotAndTimeline(meetingId);
  }
}
