import { DomainInvariantError } from "../domain/errors.js";
import {
  LiveMeeting,
  type LiveGenerationUsageSnapshot,
  type StartLiveMeetingInput,
} from "../domain/live-meeting.js";
import type { StageFailure } from "../domain/meeting.js";
import type { TranscriptTurnSnapshot } from "../domain/transcript.js";
import type {
  IncrementalSummaryGenerationPort,
  LiveCaptionSnapshot,
  LiveMeetingProjectionPort,
  LiveMeetingRepository,
} from "./ports.js";

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

export interface StartLiveMeetingDependencies {
  readonly meetings: LiveMeetingRepository;
}

export type StartLiveMeetingResult =
  | { readonly status: "started" }
  | { readonly status: "reused" };

export class StartLiveMeeting {
  public constructor(private readonly dependencies: StartLiveMeetingDependencies) {}

  public async execute(input: StartLiveMeetingInput): Promise<StartLiveMeetingResult> {
    const existing = await this.dependencies.meetings.findById(input.meetingId);
    if (existing !== null) {
      const meeting = LiveMeeting.restore(existing);
      if (
        meeting.publicationTargetId !== input.publicationTargetId ||
        meeting.startedAtMs !== input.startedAtMs
      ) {
        throw new DomainInvariantError(
          "CONFLICTING_COMPLETION",
          "live meeting identity was reused with different start data",
        );
      }
      return { status: "reused" };
    }

    const meeting = LiveMeeting.start(input);
    await this.dependencies.meetings.save(meeting.toSnapshot(), null);
    return { status: "started" };
  }
}

export class AppendLiveTranscriptTurn {
  public constructor(private readonly meetings: LiveMeetingRepository) {}

  public async execute(
    meetingId: string,
    turn: TranscriptTurnSnapshot,
  ): Promise<"appended" | "not-found" | "reused"> {
    const snapshot = await this.meetings.findById(meetingId);
    if (snapshot === null) {
      return "not-found";
    }
    const meeting = LiveMeeting.restore(snapshot);
    const expectedRevision = meeting.revision;
    if (!meeting.appendFinalTurn(turn)) {
      return "reused";
    }
    await this.meetings.save(meeting.toSnapshot(), expectedRevision);
    return "appended";
  }
}

export class FinishLiveMeeting {
  public constructor(private readonly meetings: LiveMeetingRepository) {}

  public async execute(
    meetingId: string,
    endedAtMs: number,
  ): Promise<"ended" | "not-found" | "reused"> {
    const snapshot = await this.meetings.findById(meetingId);
    if (snapshot === null) {
      return "not-found";
    }
    const meeting = LiveMeeting.restore(snapshot);
    const expectedRevision = meeting.revision;
    if (!meeting.end(endedAtMs)) {
      return "reused";
    }
    await this.meetings.save(meeting.toSnapshot(), expectedRevision);
    return "ended";
  }
}

export interface RefreshLiveMeetingDependencies {
  readonly meetings: LiveMeetingRepository;
  readonly policy?: LiveSummaryCadencePolicy;
  readonly projector: LiveMeetingProjectionPort;
  readonly summarizer: IncrementalSummaryGenerationPort;
}

export interface RefreshLiveMeetingInput {
  readonly captions: readonly LiveCaptionSnapshot[];
  readonly meetingId: string;
  readonly nowMs: number;
}

export type RefreshLiveMeetingResult =
  | { readonly status: "not-found" }
  | {
      readonly generationFailure?: StageFailure;
      readonly generationUsage?: LiveGenerationUsageSnapshot;
      readonly generated: boolean;
      readonly projected: boolean;
      readonly projectionFailure?: StageFailure;
      readonly status: "refreshed";
    };

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

export class RefreshLiveMeeting {
  private readonly policy: LiveSummaryCadencePolicy;

  public constructor(private readonly dependencies: RefreshLiveMeetingDependencies) {
    this.policy = dependencies.policy ?? defaultLiveSummaryCadencePolicy;
  }

  public async execute(input: RefreshLiveMeetingInput): Promise<RefreshLiveMeetingResult> {
    const snapshot = await this.dependencies.meetings.findById(input.meetingId);
    if (snapshot === null) {
      return { status: "not-found" };
    }
    const meeting = LiveMeeting.restore(snapshot);
    const nowMs = Math.max(meeting.startedAtMs, input.nowMs);
    const elapsedMs = nowMs - meeting.startedAtMs;
    const newTurns = meeting.turns
      .filter(({ turnId }) => !meeting.summarizedTurnIds.has(turnId))
      .map((turn) => turn.toSnapshot());
    const shouldGenerate = this.shouldGenerate(meeting, elapsedMs, nowMs, newTurns);
    let generated = false;
    let generationFailure: StageFailure | undefined;
    let generationUsage: LiveGenerationUsageSnapshot | undefined;

    const shouldProject =
      meeting.projectionExternalId !== null ||
      meeting.status === "ended" ||
      elapsedMs >= this.policy.publishAfterMs;
    let projected = false;
    let projectionFailure: StageFailure | undefined;
    if (shouldProject) {
      const projectedResult = await this.project(meeting, input.captions, nowMs, elapsedMs);
      projected = projectedResult.projected;
      projectionFailure = projectedResult.failure;
    }

    if (shouldGenerate) {
      const result = await this.generate(meeting, nowMs, newTurns);
      generated = result.generated;
      generationFailure = result.failure;
      generationUsage = result.usage;
      if (generated && shouldProject) {
        const updatedProjection = await this.project(
          meeting,
          input.captions,
          nowMs,
          elapsedMs,
        );
        projected = projected || updatedProjection.projected;
        projectionFailure = updatedProjection.failure;
      }
    }

    return {
      ...(generationFailure === undefined ? {} : { generationFailure }),
      ...(generationUsage === undefined ? {} : { generationUsage }),
      generated,
      projected,
      ...(projectionFailure === undefined ? {} : { projectionFailure }),
      status: "refreshed",
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
    return (
      estimateSchedulingTokens(newTurns) >= this.policy.minimumNewTurnTokens ||
      sinceLastSummary >= this.policy.forceSummaryAfterMs
    );
  }

  private async generate(
    meeting: LiveMeeting,
    nowMs: number,
    newTurns: readonly TranscriptTurnSnapshot[],
  ): Promise<{
    readonly failure?: StageFailure;
    readonly generated: boolean;
    readonly usage?: LiveGenerationUsageSnapshot;
  }> {
    const turns = meeting.turns.map((turn) => turn.toSnapshot());
    const newTurnIds = new Set(newTurns.map(({ turnId }) => turnId));
    const previousTurns = turns.filter(({ turnId }) => !newTurnIds.has(turnId));
    const overlapStartMs = Math.max(
      0,
      (newTurns[0]?.startMs ?? 0) - this.policy.recentContextOverlapMs,
    );
    const recentContextTurns = previousTurns
      .filter(({ endMs }) => endMs >= overlapStartMs)
      .slice(-this.policy.maximumRecentContextTurns);
    const nextSummaryRevision = (meeting.draftSummary?.revision ?? 0) + 1;
    const lastTurnId = turns.at(-1)?.turnId ?? "none";
    let result;
    try {
      result = await this.dependencies.summarizer.generate({
        idempotencyKey: operationIdentity(
          "live-evidence-summary:v1",
          meeting.meetingId,
          String(nextSummaryRevision),
          String(turns.length),
          lastTurnId,
        ),
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
      return { failure: unexpectedFailure("generation", error), generated: false };
    }
    if (!result.ok) {
      if (result.usage !== undefined) {
        await this.persistRejectedUsage(meeting, result.usage);
      }
      return {
        failure: result.failure,
        generated: false,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    }

    try {
      const expectedRevision = meeting.revision;
      meeting.acceptSummary({
        generatedAtMs: nowMs,
        summary: result.value.summary,
        throughTurnCount: turns.length,
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      });
      await this.dependencies.meetings.save(meeting.toSnapshot(), expectedRevision);
      return {
        generated: true,
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      };
    } catch (error) {
      if (error instanceof DomainInvariantError) {
        if (result.value.usage !== undefined) {
          await this.persistRejectedUsage(meeting, result.value.usage);
        }
        return {
          failure: invalidGenerationFailure(error),
          generated: false,
          ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
        };
      }
      throw error;
    }
  }

  private async persistRejectedUsage(
    meeting: LiveMeeting,
    usage: LiveGenerationUsageSnapshot,
  ): Promise<void> {
    const expectedRevision = meeting.revision;
    if (meeting.recordGenerationUsage(usage)) {
      await this.dependencies.meetings.save(meeting.toSnapshot(), expectedRevision);
    }
  }

  private async project(
    meeting: LiveMeeting,
    captions: readonly LiveCaptionSnapshot[],
    nowMs: number,
    elapsedMs: number,
  ): Promise<{ readonly failure?: StageFailure; readonly projected: boolean }> {
    const projectedRevision = meeting.revision;
    let result;
    try {
      result = await this.dependencies.projector.publish({
        captions,
        currentExternalPublicationId: meeting.projectionExternalId,
        elapsedMs,
        idempotencyKey: operationIdentity(
          "meeting-live-projection:v1",
          meeting.meetingId,
          meeting.publicationTargetId,
        ),
        meetingId: meeting.meetingId,
        publicationTargetId: meeting.publicationTargetId,
        revision: projectedRevision,
        status: meeting.status,
        summary: meeting.draftSummary,
        updatedAtMs: nowMs,
      });
    } catch (error) {
      return { failure: unexpectedFailure("projection", error), projected: false };
    }
    if (!result.ok) {
      return { failure: result.failure, projected: false };
    }

    const expectedRevision = meeting.revision;
    const receiptChanged = meeting.completeProjection(
      result.value.externalPublicationId,
      projectedRevision,
    );
    if (receiptChanged) {
      await this.dependencies.meetings.save(meeting.toSnapshot(), expectedRevision);
    }
    return { projected: true };
  }
}
