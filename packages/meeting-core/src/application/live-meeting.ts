import { DomainInvariantError } from "../domain/errors.js";
import {
  LiveMeeting,
  type LiveGenerationTelemetrySnapshot,
  type LiveGenerationUsageSnapshot,
  type LiveMeetingSnapshot,
  type LiveSummaryDraftSnapshot,
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
  | { readonly finalizedTurns: readonly TranscriptTurnSnapshot[]; readonly status: "started" }
  | { readonly finalizedTurns: readonly TranscriptTurnSnapshot[]; readonly status: "reused" };

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
      return {
        finalizedTurns: meeting.turns.map((turn) => turn.toSnapshot()),
        status: "reused",
      };
    }

    const meeting = LiveMeeting.start(input);
    await this.dependencies.meetings.save(meeting.toSnapshot(), null);
    return { finalizedTurns: [], status: "started" };
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
  /**
   * Keeps summary generation available to a separate single-flight worker
   * without allowing it to concurrently edit the mutable live projection.
   */
  readonly projection?: "allow" | "skip";
  readonly projectionRequested?: boolean;
  readonly summaryGeneration?: "cadence" | "skip";
}

export type RefreshLiveMeetingResult =
  | { readonly status: "not-found" }
  | {
      readonly generationFailure?: StageFailure;
      /** Changes whenever the durable input base for an incremental run changes. */
      readonly generationBase?: string;
      readonly generationStale?: boolean;
      readonly generationTelemetry?: LiveGenerationTelemetrySnapshot;
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

interface GenerationBase {
  readonly draftSummaryRevision: number | null;
  /**
   * Exact finalized evidence seen by the generator. Its membership and
   * contents, rather than its position in the mutable timeline, form the
   * optimistic-concurrency boundary for the generated result.
   */
  readonly evidenceTurns: readonly TranscriptTurnSnapshot[];
  readonly status: LiveMeetingSnapshot["status"];
  readonly summarizedTurnIds: readonly string[];
}

const maximumCompatibleGenerationSaveAttempts = 3;
const maximumProjectionSaveAttempts = 3;

function generationBaseSnapshot(snapshot: LiveMeetingSnapshot): GenerationBase {
  return {
    draftSummaryRevision: snapshot.draftSummary?.revision ?? null,
    evidenceTurns: snapshot.turns.map((turn) => ({ ...turn })),
    status: snapshot.status,
    summarizedTurnIds: [...snapshot.summarizedTurnIds].toSorted(),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameTurn(
  left: TranscriptTurnSnapshot,
  right: TranscriptTurnSnapshot,
): boolean {
  return left.turnId === right.turnId &&
    left.speakerId === right.speakerId &&
    left.startMs === right.startMs &&
    left.endMs === right.endMs &&
    left.text === right.text;
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
  snapshot: LiveMeetingSnapshot,
  base: GenerationBase,
): boolean {
  return (
    snapshot.status === base.status &&
    (snapshot.draftSummary?.revision ?? null) === base.draftSummaryRevision &&
    sameStrings([...snapshot.summarizedTurnIds].toSorted(), base.summarizedTurnIds) &&
    containsUnchangedEvidence(snapshot.turns, base.evidenceTurns)
  );
}

function generationBaseKey(
  meeting: LiveMeeting,
  turns: readonly TranscriptTurnSnapshot[],
): string {
  const nextSummaryRevision = (meeting.draftSummary?.revision ?? 0) + 1;
  const summarizedTurnIds = [...meeting.summarizedTurnIds].toSorted();
  // Final turns are immutable and append-only inside the aggregate. Therefore
  // the count changes for every new evidence base, including a late turn that
  // sorts into the middle of the timeline. Summary revision and covered-count
  // changes fence every successfully accepted base without a platform hash in
  // the Clean Architecture core.
  return operationIdentity(
    "live-evidence-summary:v2",
    meeting.meetingId,
    String(nextSummaryRevision),
    meeting.status,
    String(summarizedTurnIds.length),
    summarizedTurnIds.at(-1) ?? "none",
    String(turns.length),
    turns.at(-1)?.turnId ?? "none",
  );
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
    const shouldGenerate = input.summaryGeneration !== "skip" &&
      this.shouldGenerate(meeting, elapsedMs, nowMs, newTurns);
    const generationBase = newTurns.length === 0
      ? undefined
      : generationBaseKey(meeting, meeting.turns.map((turn) => turn.toSnapshot()));
    let generated = false;
    let generationFailure: StageFailure | undefined;
    let generationStale = false;
    let generationTelemetry: LiveGenerationTelemetrySnapshot | undefined;
    let generationUsage: LiveGenerationUsageSnapshot | undefined;
    const projectionAllowed = input.projection !== "skip";

    const projectionRequested = input.projectionRequested ?? true;
    const hasVisibleCaption = input.captions.some(({ text }) => text.trim().length > 0);
    const hasRecognizedEvidence =
      hasVisibleCaption || meeting.turns.length > 0 || meeting.draftSummary !== null;
    const initialProjectionDue = hasRecognizedEvidence && (
      meeting.status === "ended" ||
      elapsedMs >= this.policy.publishAfterMs ||
      hasVisibleCaption
    );
    const canProject = meeting.projectionExternalId !== null || initialProjectionDue;
    const projectionStateDirty = meeting.projectedRevision < meeting.revision;
    const shouldProject =
      canProject &&
      (meeting.status === "ended" || projectionStateDirty || projectionRequested);
    let projected = false;
    let projectionFailure: StageFailure | undefined;
    if (projectionAllowed && shouldProject) {
      const projectedResult = await this.project(meeting, input.captions, nowMs, elapsedMs);
      projected = projectedResult.projected;
      projectionFailure = projectedResult.failure;
    }

    if (shouldGenerate) {
      const result = await this.generate(meeting, nowMs, newTurns);
      generated = result.generated;
      generationFailure = result.failure;
      generationStale = result.stale;
      generationTelemetry = result.telemetry;
      generationUsage = result.usage;
      if (generated && canProject && projectionAllowed) {
        const generatedSnapshot = await this.dependencies.meetings.findById(input.meetingId);
        if (generatedSnapshot === null) {
          return { status: "not-found" };
        }
        const updatedProjection = await this.project(
          LiveMeeting.restore(generatedSnapshot),
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
      ...(generationBase === undefined ? {} : { generationBase }),
      ...(generationStale ? { generationStale: true } : {}),
      ...(generationTelemetry === undefined ? {} : { generationTelemetry }),
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
    readonly stale: boolean;
    readonly telemetry?: LiveGenerationTelemetrySnapshot;
    readonly usage?: LiveGenerationUsageSnapshot;
  }> {
    const meetingSnapshot = meeting.toSnapshot();
    const turns = meetingSnapshot.turns;
    const base = generationBaseSnapshot(meetingSnapshot);
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
        generatedAtMs: nowMs,
        summary: result.value.summary,
        ...(result.value.telemetry === undefined
          ? {}
          : { telemetry: result.value.telemetry }),
        evidenceTurns: base.evidenceTurns,
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      });
      if (!applied) {
        await this.persistRejectedGeneration(meeting.meetingId, result.value);
        return {
          generated: false,
          stale: true,
          ...(result.value.telemetry === undefined
            ? {}
            : { telemetry: result.value.telemetry }),
          ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
        };
      }
      return {
        generated: true,
        stale: false,
        ...(result.value.telemetry === undefined
          ? {}
          : { telemetry: result.value.telemetry }),
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      };
    } catch (error) {
      if (error instanceof DomainInvariantError) {
        await this.persistRejectedGeneration(meeting.meetingId, result.value);
        return {
          failure: invalidGenerationFailure(error),
          generated: false,
          stale: false,
          ...(result.value.telemetry === undefined
            ? {}
            : { telemetry: result.value.telemetry }),
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
    if (input.telemetry === undefined && input.usage === undefined) {
      return;
    }
    for (let attempt = 0; attempt < maximumCompatibleGenerationSaveAttempts; attempt += 1) {
      const snapshot = await this.dependencies.meetings.findById(meetingId);
      if (snapshot === null) {
        return;
      }
      const meeting = LiveMeeting.restore(snapshot);
      const expectedRevision = meeting.revision;
      const usageChanged = input.usage === undefined
        ? false
        : meeting.recordGenerationUsage(input.usage);
      const telemetryChanged = input.telemetry === undefined
        ? false
        : meeting.recordGenerationTelemetry(input.telemetry);
      if (!usageChanged && !telemetryChanged) {
        return;
      }
      try {
        await this.dependencies.meetings.save(meeting.toSnapshot(), expectedRevision);
        return;
      } catch (error) {
        const latest = await this.dependencies.meetings.findById(meetingId);
        if (latest === null || latest.revision === expectedRevision) {
          throw error;
        }
      }
    }
    throw new Error("Unable to persist rejected generation telemetry after concurrent updates");
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
      const snapshot = await this.dependencies.meetings.findById(meetingId);
      if (snapshot === null || !isCompatibleGenerationBase(snapshot, base)) {
        return false;
      }
      const meeting = LiveMeeting.restore(snapshot);
      const expectedRevision = meeting.revision;
      meeting.acceptSummary(input);
      try {
        await this.dependencies.meetings.save(meeting.toSnapshot(), expectedRevision);
        return true;
      } catch (error) {
        const latest = await this.dependencies.meetings.findById(meetingId);
        if (latest === null || !isCompatibleGenerationBase(latest, base)) {
          return false;
        }
        if (latest.revision === expectedRevision) {
          throw error;
        }
      }
    }
    return false;
  }

  private async project(
    initialMeeting: LiveMeeting,
    captions: readonly LiveCaptionSnapshot[],
    nowMs: number,
    elapsedMs: number,
  ): Promise<{ readonly failure?: StageFailure; readonly projected: boolean }> {
    let meeting = initialMeeting;
    for (let attempt = 0; attempt < maximumProjectionSaveAttempts; attempt += 1) {
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
      try {
        const receiptChanged = meeting.completeProjection(
          result.value.externalPublicationId,
          projectedRevision,
        );
        if (receiptChanged) {
          await this.dependencies.meetings.save(meeting.toSnapshot(), expectedRevision);
        }
        return { projected: true };
      } catch (error) {
        const latest = await this.dependencies.meetings.findById(meeting.meetingId);
        if (latest === null) {
          return {
            failure: unexpectedFailure(
              "projection",
              new Error("Live meeting disappeared after projection publication"),
            ),
            projected: false,
          };
        }
        if (
          latest.projectionExternalId === result.value.externalPublicationId &&
          latest.projectedRevision >= projectedRevision
        ) {
          return { projected: true };
        }
        if (latest.revision === expectedRevision) {
          return { failure: unexpectedFailure("projection", error), projected: false };
        }
        meeting = LiveMeeting.restore(latest);
      }
    }
    return {
      failure: {
        code: "LIVE_PROJECTION_CONFLICT",
        message: "Live projection changed concurrently during receipt reconciliation",
        retryable: true,
      },
      projected: false,
    };
  }
}
