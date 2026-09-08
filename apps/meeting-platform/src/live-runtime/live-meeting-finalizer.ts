import type {
  LiveMeetingRuntimeDependencies,
  LiveRuntimeClock,
} from "./contracts.js";
import type { ActiveLiveMeeting } from "./live-meeting-state.js";
import { TerminalEndTimeIntents } from "./terminal-end-time-intents.js";

interface LiveMeetingFinalizerDependencies {
  readonly clock: LiveRuntimeClock;
  readonly enqueueDomain: (
    state: ActiveLiveMeeting,
    task: () => Promise<void>,
  ) => void;
  readonly meetings: Map<string, ActiveLiveMeeting>;
  readonly refreshProjection: (
    state: ActiveLiveMeeting,
    nowMs: number,
  ) => Promise<void>;
  readonly runtime: LiveMeetingRuntimeDependencies;
}

/** Owns terminal intent reconciliation and one-shot live meeting settlement. */
export class LiveMeetingFinalizer {
  private readonly coldFinishPromises = new Map<string, Promise<void>>();
  private readonly terminalEndTimes = new TerminalEndTimeIntents();

  public constructor(private readonly dependencies: LiveMeetingFinalizerDependencies) {}

  public pendingRecordingIds(nowMs: number): readonly string[] {
    return [
      ...this.coldFinishPromises.keys(),
      ...this.terminalEndTimes.recordingIds(nowMs),
    ];
  }

  public waitForColdFinish(recordingId: string): Promise<void> | undefined {
    return this.coldFinishPromises.get(recordingId);
  }

  public rememberedEndTime(recordingId: string): number | undefined {
    return this.terminalEndTimes.get(
      recordingId,
      this.dependencies.clock.nowMilliseconds(),
    );
  }

  public async finishRecording(
    recordingId: string,
    proposedEndedAtMs: number,
    reuseTerminalTime = false,
  ): Promise<void> {
    const durability = this.dependencies.runtime.liveSttDurability;
    const recovered = await durability?.recoverRecording(recordingId);
    const terminalTime = reuseTerminalTime ? recovered?.endedAtMs ?? proposedEndedAtMs : proposedEndedAtMs;
    if (durability !== undefined && recovered !== undefined) {
      // Validate lifecycle evidence, and publish the time to memory only after sync.
      await durability.closeRecording(recovered.owner, terminalTime);
    }
    const endedAtMs = this.terminalEndTime(recordingId, terminalTime);
    const state = this.dependencies.meetings.get(recordingId);
    if (state !== undefined) {
      await this.beginFinish(state, endedAtMs);
      return;
    }
    const inFlight = this.coldFinishPromises.get(recordingId);
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    let finishPromise!: Promise<void>;
    finishPromise = (async () => {
      await this.closeAdmission(recordingId, endedAtMs);
      const result = await this.dependencies.runtime.finishMeeting.execute(
        recordingId,
        endedAtMs,
      );
      if (result !== "not-found") {
        await this.dependencies.runtime.finalizedMemory?.synchronizeMeeting(
          recordingId,
        );
        await this.dependencies.runtime.finalizedMemory?.finishMeeting(recordingId);
        this.terminalEndTimes.complete(recordingId);
      }
    })().finally(() => {
      if (this.coldFinishPromises.get(recordingId) === finishPromise) {
        this.coldFinishPromises.delete(recordingId);
      }
    });
    this.coldFinishPromises.set(recordingId, finishPromise);
    await finishPromise;
  }

  public async beginFinish(state: ActiveLiveMeeting, endedAtMs: number): Promise<void> {
    await this.closeAdmission(state.meetingId, endedAtMs);
    if (state.terminalCommitted) {
      return Promise.resolve();
    }
    if (state.finishPromise !== null) {
      return state.finishPromise;
    }
    if (!state.finalizationStarted) {
      state.finalizationStarted = true;
      state.finishing = true;
      state.farewell?.close();
      state.greetings?.close();
      state.conversation?.close();
      state.transcription.beginFinish();
      this.dependencies.enqueueDomain(state, async () => {
        await this.dependencies.refreshProjection(state, endedAtMs);
      });
    }
    const finishPromise = (async () => {
      await this.finish(state, endedAtMs);
      state.terminalCommitted = true;
      this.terminalEndTimes.complete(state.meetingId);
      this.dependencies.meetings.delete(state.meetingId);
    })().finally(() => {
        if (!state.terminalCommitted && state.finishPromise === finishPromise) {
          state.finishPromise = null;
        }
      });
    state.finishPromise = finishPromise;
    return finishPromise;
  }

  public startTerminalFinish(recordingId: string, endedAtMs: number): void {
    void this.finishRecording(recordingId, endedAtMs, true).catch((error: unknown) => {
      this.dependencies.runtime.logger.error(
        "Derived live meeting finalization failed",
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: recordingId,
        },
      );
    });
  }

  private async finish(state: ActiveLiveMeeting, endedAtMs: number): Promise<void> {
    await state.transcription.settle();
    state.transcriptionFenceClosed = true;
    await state.summary.settle();
    await state.farewell?.settle();
    await state.greetings?.settle();
    await state.conversation?.settle();
    await state.domainChain;
    const result = await this.dependencies.runtime.finishMeeting.execute(
      state.meetingId,
      endedAtMs,
    );
    if (result === "not-found") {
      throw new Error("Live meeting disappeared before finish");
    }
    await this.dependencies.runtime.finalizedMemory?.synchronizeMeeting(
      state.meetingId,
    );
    await this.dependencies.runtime.finalizedMemory?.finishMeeting(state.meetingId);
    this.dependencies.enqueueDomain(state, async () => {
      await this.dependencies.refreshProjection(state, endedAtMs);
    });
    await state.domainChain;
  }

  private async closeAdmission(recordingId: string, endedAtMs: number): Promise<void> {
    const durability = this.dependencies.runtime.liveSttDurability;
    if (durability === undefined) { return; }
    const recovered = await durability.recoverRecording(recordingId);
    await durability.closeRecording(recovered.owner, endedAtMs);
  }

  private terminalEndTime(recordingId: string, proposedEndedAtMs: number): number {
    return this.terminalEndTimes.remember(
      recordingId,
      proposedEndedAtMs,
      this.dependencies.clock.nowMilliseconds(),
    );
  }
}
