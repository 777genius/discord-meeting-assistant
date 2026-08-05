import { createHash } from "node:crypto";

import {
  boundLiveFinalCaptionHistory,
  compareLiveCaptionSnapshots,
} from "./live-caption-history.js";

import type {
  LiveCaptionSignature,
  LiveCaptionSnapshot,
  LiveMeetingRefresher,
  LiveMeetingRefreshResult,
  LiveRuntimeClock,
  LiveRuntimeLogger,
  LiveTranscriptionEvent,
  LiveTranscriptTurn,
} from "./contracts.js";

const refreshIntervalMs = 5_000;
const maximumInitialCaptionProjectionJitterMs = 900;
const initialProjectionBackoffMs = 10_000;
const maximumProjectionBackoffMs = 300_000;
const activeCaptionRetentionMs = 30_000;

export interface LiveProjectionSchedulerDependencies {
  readonly captionSignature: LiveCaptionSignature;
  readonly clock: LiveRuntimeClock;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
  readonly refreshMeeting: LiveMeetingRefresher;
  readonly startedAtMs: number;
}

export interface LiveProjectionRefreshOutcome {
  readonly generationBase?: string;
}

/** Schedules and refreshes only the derived user-visible live projection. */
export class LiveProjectionScheduler {
  private readonly activeCaptions = new Map<string, LiveCaptionSnapshot>();
  private readonly finalCaptions = new Map<string, LiveCaptionSnapshot>();
  private lastProjectedCaptionsSignature: string | null = null;
  private nextRefreshAtMs: number;
  private permanentFailureCode: string | null = null;
  private failureCount = 0;
  private retryAtMs = 0;

  public constructor(
    private readonly dependencies: LiveProjectionSchedulerDependencies,
  ) {
    this.nextRefreshAtMs = dependencies.clock.nowMilliseconds() + refreshIntervalMs;
  }

  public get dueAtMilliseconds(): number {
    return this.nextRefreshAtMs;
  }

  public restoreFinalCaptions(turns: readonly LiveTranscriptTurn[]): void {
    for (const turn of turns) {
      this.finalCaptions.set(turn.turnId, {
        endMs: turn.endMs,
        isFinal: true,
        speakerId: turn.speakerId,
        startMs: turn.startMs,
        text: turn.text,
      });
    }
    boundLiveFinalCaptionHistory(this.finalCaptions);
  }

  public acceptTranscript(
    event: LiveTranscriptionEvent,
    turnId: string | undefined,
    finishing: boolean,
  ): void {
    const caption: LiveCaptionSnapshot = {
      endMs: event.endMs,
      isFinal: event.isFinal,
      speakerId: event.speakerId,
      startMs: event.startMs,
      text: event.text,
    };
    if (!event.isFinal) {
      this.activeCaptions.set(event.speakerId, caption);
      this.scheduleFirstCaptionRefresh(caption.text, finishing);
      return;
    }
    this.activeCaptions.delete(event.speakerId);
    if (turnId !== undefined) {
      this.finalCaptions.set(turnId, caption);
      boundLiveFinalCaptionHistory(this.finalCaptions);
    }
    this.scheduleFirstCaptionRefresh(caption.text, finishing);
  }

  public isDue(nowMs: number): boolean {
    return nowMs >= this.nextRefreshAtMs;
  }

  public reschedule(previousDueAtMs: number, nowMs: number): void {
    const scheduled = previousDueAtMs + refreshIntervalMs;
    this.nextRefreshAtMs = scheduled > nowMs ? scheduled : nowMs + refreshIntervalMs;
  }

  public async refresh(
    nowMs: number,
    finalizing: boolean,
  ): Promise<LiveProjectionRefreshOutcome> {
    const refreshStartedAtMs = this.dependencies.clock.monotonicMilliseconds();
    const phase = finalizing ? "finalizing" : "live";
    const captions = this.collectCaptions(nowMs);
    const captionsSignature = this.dependencies.captionSignature.calculate(captions);
    const projectionAllowed = finalizing || this.isProjectionAllowed(nowMs);
    const result = await this.dependencies.refreshMeeting.execute({
      captions,
      meetingId: this.dependencies.meetingId,
      nowMs,
      projectionPhase: phase,
      ...(projectionAllowed ? {} : { projection: "skip" as const }),
      projectionRequested:
        projectionAllowed && captionsSignature !== this.lastProjectedCaptionsSignature,
      summaryGeneration: "skip",
    });
    if (result.status === "not-found") {
      throw new Error("Live meeting disappeared before refresh");
    }
    this.handleProjectionResult(result, captionsSignature);
    this.dependencies.logger.info("Live caption projection refresh completed", {
      durationMs: Math.max(
        0,
        this.dependencies.clock.monotonicMilliseconds() - refreshStartedAtMs,
      ),
      meetingId: this.dependencies.meetingId,
      phase,
      projectionAllowed,
      projected: result.projected,
    });
    return result.generationBase === undefined
      ? {}
      : { generationBase: result.generationBase };
  }

  private collectCaptions(nowMs: number): readonly LiveCaptionSnapshot[] {
    const cutoffMs = Math.max(0, nowMs - this.dependencies.startedAtMs) -
      activeCaptionRetentionMs;
    for (const [speakerId, caption] of this.activeCaptions) {
      if (caption.endMs < cutoffMs) {
        this.activeCaptions.delete(speakerId);
      }
    }
    return [
      ...this.finalCaptions.values(),
      ...this.activeCaptions.values(),
    ].toSorted(compareLiveCaptionSnapshots);
  }

  private scheduleFirstCaptionRefresh(captionText: string, finishing: boolean): void {
    if (
      finishing ||
      this.lastProjectedCaptionsSignature !== null ||
      captionText.trim().length === 0
    ) {
      return;
    }
    const dueAtMs = this.dependencies.clock.nowMilliseconds() +
      deterministicOffsetMs(
        "live-first-caption-projection:v1",
        this.dependencies.meetingId,
        maximumInitialCaptionProjectionJitterMs,
      );
    this.nextRefreshAtMs = Math.min(this.nextRefreshAtMs, dueAtMs);
  }

  private isProjectionAllowed(nowMs: number): boolean {
    return this.permanentFailureCode === null && nowMs >= this.retryAtMs;
  }

  private handleProjectionResult(
    result: Extract<LiveMeetingRefreshResult, { readonly status: "refreshed" }>,
    captionsSignature: string,
  ): void {
    if (result.projectionFailure !== undefined) {
      if (result.projectionFailure.retryable) {
        this.deferProjection(result.projectionFailure.code);
      } else {
        this.fencePermanentFailure(result.projectionFailure.code);
      }
      this.dependencies.logger.warn("Live projection refresh failed", {
        errorCode: result.projectionFailure.code,
        meetingId: this.dependencies.meetingId,
        retryable: result.projectionFailure.retryable,
      });
    }
    if (result.projected) {
      this.lastProjectedCaptionsSignature = captionsSignature;
      this.failureCount = 0;
      this.retryAtMs = 0;
    }
  }

  private deferProjection(errorCode: string): void {
    this.failureCount += 1;
    const delayMs = projectionBackoffDelayMs(
      this.dependencies.meetingId,
      this.failureCount,
    );
    this.retryAtMs = this.dependencies.clock.nowMilliseconds() + delayMs;
    this.dependencies.logger.info("Live projection retry deferred", {
      delayMs,
      errorCode,
      failureCount: this.failureCount,
      meetingId: this.dependencies.meetingId,
    });
  }

  private fencePermanentFailure(errorCode: string): void {
    if (this.permanentFailureCode !== null) {
      return;
    }
    this.permanentFailureCode = errorCode;
    this.failureCount = 0;
    this.retryAtMs = Number.POSITIVE_INFINITY;
    this.dependencies.logger.error("Live projection permanently fenced", {
      errorCode,
      meetingId: this.dependencies.meetingId,
      release: "runtime-restart-or-configuration-change",
    });
  }
}

function projectionBackoffDelayMs(
  meetingId: string,
  failureCount: number,
): number {
  const exponent = Math.min(failureCount - 1, 5);
  const baseDelayMs = Math.min(
    initialProjectionBackoffMs * 2 ** exponent,
    maximumProjectionBackoffMs,
  );
  const jitterBudgetMs = Math.floor(baseDelayMs / 5);
  return baseDelayMs - deterministicOffsetMs(
    `live-projection-retry:v1:${failureCount}`,
    meetingId,
    jitterBudgetMs,
  );
}

function deterministicOffsetMs(
  namespace: string,
  meetingId: string,
  maximumOffsetMs: number,
): number {
  if (maximumOffsetMs <= 0) {
    return 0;
  }
  const digest = createHash("sha256")
    .update(`${namespace}\u0000${meetingId}`, "utf8")
    .digest();
  return digest.readUInt32BE(0) % (maximumOffsetMs + 1);
}
