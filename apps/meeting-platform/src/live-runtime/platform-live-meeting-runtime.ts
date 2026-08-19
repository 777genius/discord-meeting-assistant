import { GlobalPacketFlowControl, LiveSessionAdmission,
  resolveLivePacketFlowControl } from "./live-packet-flow-control.js";
import type { LiveMeetingLifecycleEvent, LiveMeetingParticipantEvent,
  LiveMeetingRuntimeDependencies, LiveMeetingStartedEvent, LiveRuntimeClock,
  LiveRuntimeTimer, LiveRuntimeTimerHandle, LiveTranscriptionEvent,
  LiveVoicePacket, LiveVoicePacketBatch } from "./contracts.js";
import { createActiveLiveMeeting, type ActiveLiveMeeting } from
  "./live-meeting-state.js";
import { LiveMeetingFinalizer } from "./live-meeting-finalizer.js";
import { observeFinalizedHuman, registerFinalizedMemory,
  sealFinalizedMemory } from "./live-finalized-memory-lifecycle.js";
import { resolveSpeakerIdleFinalizeMs } from "./live-runtime-settings.js";
import { logFinalizedLiveTranscript } from "./live-transcript-observability.js";
import { systemLiveRuntimeClock, systemLiveRuntimeTimer } from
  "./runtime-clock.js";
import { closeLiveMeetings } from "./close-live-meetings.js";
import { RecordingOperationQueue } from "./recording-operation-queue.js";
import { releaseLiveMeetingsForRestart } from "./release-live-meetings-for-restart.js";
import { stableLiveTranscriptTurnId } from "./transcript-turn-id.js";

const refreshSchedulerIntervalMs = 100;
/**
 * Small lifecycle supervisor for derived live transcription, projection,
 * incremental summary and conversation. It owns no provider DTOs or SDKs.
 */
export class PlatformLiveMeetingRuntime {
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private readonly clock: LiveRuntimeClock;
  private readonly finalizer: LiveMeetingFinalizer;
  private readonly meetings = new Map<string, ActiveLiveMeeting>();
  private readonly packetFlow: ReturnType<typeof resolveLivePacketFlowControl>;
  private readonly packetAdmission: GlobalPacketFlowControl;
  private readonly recordingOperations = new RecordingOperationQueue();
  private readonly refreshTimer: LiveRuntimeTimerHandle;
  private readonly sessionAdmission: LiveSessionAdmission;
  private readonly speakerIdleFinalizeMs: number;
  private readonly timer: LiveRuntimeTimer;

  public constructor(
    private readonly dependencies: LiveMeetingRuntimeDependencies,
  ) {
    this.clock = dependencies.clock ?? systemLiveRuntimeClock;
    this.timer = dependencies.timer ?? systemLiveRuntimeTimer;
    this.packetFlow = resolveLivePacketFlowControl(dependencies.packetFlowControl);
    this.packetAdmission = new GlobalPacketFlowControl(
      this.packetFlow.maximumQueuedPacketsGlobally,
      this.clock,
      this.timer,
    );
    this.speakerIdleFinalizeMs = resolveSpeakerIdleFinalizeMs(
      dependencies.speakerIdleFinalizeMs,
    );
    this.sessionAdmission = new LiveSessionAdmission(
      this.packetFlow.maximumConcurrentSessions,
    );
    this.finalizer = new LiveMeetingFinalizer({
      clock: this.clock,
      enqueueDomain: (state, task) => {
        this.enqueueDomain(state, task);
      },
      meetings: this.meetings,
      refreshProjection: async (state, nowMs) => {
        await this.refreshProjection(state, nowMs);
      },
      runtime: this.dependencies,
    });
    this.refreshTimer = this.timer.repeat(refreshSchedulerIntervalMs, () => {
      this.tick();
    });
  }

  public async acceptLifecycle(event: LiveMeetingLifecycleEvent): Promise<void> {
    if (this.closed) {
      this.dependencies.logger.debug("Live meeting lifecycle skipped during shutdown", {
        eventType: event.type,
        meetingId: event.recordingId,
      });
      return;
    }
    if (event.type === "meeting.started") {
      await this.recordingOperations.enqueue(event.recordingId, () => this.start(event));
      return;
    }
    if (event.type === "participant.joined" || event.type === "participant.left") {
      await this.recordingOperations.enqueue(event.recordingId, async () => {
        await this.acceptParticipant(event);
      });
      return;
    }
    if (event.type === "meeting.ended" || event.type === "meeting.aborted") {
      await this.recordingOperations.enqueue(event.recordingId, () =>
        this.finalizer.finishRecording(event.recordingId, Date.parse(event.occurredAt))
      );
      return;
    }
    if (event.type === "meeting.connection_lost") {
      await this.recordingOperations.enqueue(event.recordingId, () =>
        this.meetings.get(event.recordingId)?.conversation?.disconnect() ?? Promise.resolve()
      );
      return;
    }
    if (event.type === "recording.authoritative_ready") {
      await sealFinalizedMemory(this.dependencies, event);
    }
  }

  /**
   * Admits packets only after the caller durably accepted them. Queue pressure
   * degrades the derived live path without altering authoritative evidence.
   */
  public async acceptVoiceBatch(batch: LiveVoicePacketBatch): Promise<void> {
    if (this.closed) {
      return;
    }
    const packetsByMeeting = new Map<string, LiveVoicePacket[]>();
    for (const packet of batch.packets) {
      const packets = packetsByMeeting.get(packet.recordingId);
      if (packets === undefined) {
        packetsByMeeting.set(packet.recordingId, [packet]);
      } else {
        packets.push(packet);
      }
    }
    await Promise.all(
      [...packetsByMeeting].map(([recordingId, packets]) =>
        this.recordingOperations.enqueue(recordingId, () =>
          this.acceptPackets(recordingId, packets)
        )
      ),
    );
  }

  public prepareForAuthoritativeFinal(recordingId: string): void {
    if (this.closed) {
      return;
    }
    void this.recordingOperations.enqueue(recordingId, () => {
      this.finalizer.startTerminalFinish(recordingId, this.clock.nowMilliseconds());
      return Promise.resolve();
    });
  }

  public async settleBeforeFinalPublication(
    recordingId: string,
  ): Promise<void> {
    await this.recordingOperations.enqueue(recordingId, () =>
      this.finalizer.finishRecording(recordingId, this.clock.nowMilliseconds())
    );
  }

  public async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    this.timer.cancel(this.refreshTimer);
    const nowMs = this.clock.nowMilliseconds();
    const recordingIds = new Set([
      ...this.meetings.keys(),
      ...this.recordingOperations.pendingRecordingIds(),
      ...this.finalizer.pendingRecordingIds(nowMs),
    ]);
    this.closePromise = closeLiveMeetings({
      endedAtMs: nowMs,
      finalizer: this.finalizer,
      recordingIds,
      recordingOperations: this.recordingOperations,
    });
    return this.closePromise;
  }

  /** Releases derived ownership without committing a terminal transition. */
  public async releaseForRestart(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise;
    }
    this.closed = true;
    this.timer.cancel(this.refreshTimer);
    this.closePromise = releaseLiveMeetingsForRestart({
      meetings: this.meetings,
      recordingOperations: this.recordingOperations,
    });
    return this.closePromise;
  }

  private async start(event: LiveMeetingStartedEvent): Promise<void> {
    await this.finalizer.waitForColdFinish(event.recordingId);
    if (this.meetings.has(event.recordingId)) {
      return;
    }
    const publicationTargetId = await event.publicationTarget.resolve();
    if (publicationTargetId === null) {
      this.dependencies.logger.warn(
        "Derived live meeting skipped for unconfigured recording source",
        { meetingId: event.recordingId },
      );
      return;
    }
    const startedAtMs = Date.parse(event.occurredAt);
    const result = await this.dependencies.startMeeting.execute({
      meetingId: event.recordingId,
      publicationTargetId,
      startedAtMs,
    });
    if (result.lifecycleStatus === "ended") {
      this.dependencies.logger.info("Derived live meeting start reused after terminal commit", {
        meetingId: event.recordingId,
      });
      return;
    }
    await registerFinalizedMemory(this.dependencies, event);
    const state = createActiveLiveMeeting({
      clock: this.clock,
      dependencies: this.dependencies,
      event,
      onTranscript: (meeting, transcript) => {
        this.acceptTranscript(meeting, transcript);
      },
      packetFlow: this.packetFlow,
      packetAdmission: this.packetAdmission,
      sessionAdmission: this.sessionAdmission,
      speakerIdleFinalizeMs: this.speakerIdleFinalizeMs,
      startedAtMs,
      suppressInitialParticipantGreetings: result.status === "reused",
      timer: this.timer,
    });
    state.projection.restoreFinalCaptions(result.finalizedTurns);
    this.meetings.set(state.meetingId, state);
    this.dependencies.logger.info("Derived live meeting started", {
      meetingId: state.meetingId,
      reused: result.status === "reused",
    });
    const terminalEndTime = this.finalizer.rememberedEndTime(state.meetingId);
    if (terminalEndTime !== undefined) {
      await this.finalizer.beginFinish(state, terminalEndTime);
    }
  }

  private async acceptPackets(
    recordingId: string,
    packets: readonly LiveVoicePacket[],
  ): Promise<void> {
    const state = this.meetings.get(recordingId);
    if (state === undefined || state.finishing) {
      for (const packet of packets) {
        this.dependencies.logger.debug("Live packet skipped without active derived meeting", {
          meetingId: packet.recordingId,
          speakerId: packet.speakerId,
        });
      }
      return;
    }
    await state.transcription.accept({
      format: { channelCount: 1, codec: "opus", sampleRateHz: 48_000 },
      packets,
    });
  }

  private async acceptParticipant(event: LiveMeetingParticipantEvent): Promise<void> {
    const state = this.meetings.get(event.recordingId);
    if (state === undefined || state.finishing) {
      return;
    }
    if (event.type === "participant.joined") {
      await observeFinalizedHuman(this.dependencies, event);
      state.farewell?.participantJoined(event.participantId);
      state.greetings?.participantJoined(event.participantId, event.occurredAt);
    } else {
      // Cancellation owns the departure edge. A slow or failed roster projection
      // must never leave generation or playback running for the departed actor.
      await state.conversation?.participantLeft(event.participantId);
      state.farewell?.participantLeft(event.participantId);
      state.greetings?.participantLeft(event.participantId);
      await observeFinalizedHuman(this.dependencies, event);
    }
    this.dependencies.logger.info("Live participant lifecycle accepted", {
      eventType: event.type,
      meetingId: event.recordingId,
      occurredAt: event.occurredAt,
      participantId: event.participantId,
    });
  }

  private acceptTranscript(
    state: ActiveLiveMeeting,
    event: LiveTranscriptionEvent,
  ): void {
    if (state.transcriptionFenceClosed) {
      this.dependencies.logger.debug("Late live transcript ignored after finalization", {
        meetingId: state.meetingId,
        speakerId: event.speakerId,
      });
      return;
    }
    const farewellRevision = state.farewell?.observeSpeech(event);
    state.conversation?.observeSpeech(event, state.finishing);
    const turnId = event.isFinal ? stableLiveTranscriptTurnId(event) : undefined;
    state.projection.acceptTranscript(event, turnId, state.finishing);
    if (!event.isFinal || turnId === undefined) {
      return;
    }
    logFinalizedLiveTranscript({
      clock: this.clock,
      event,
      logger: this.dependencies.logger,
      meetingId: state.meetingId,
      startedAtMs: state.startedAtMs,
    });
    this.enqueueDomain(state, async () => {
      const result = await this.dependencies.appendTurn.execute(state.meetingId, {
        endMs: event.endMs,
        speakerId: event.speakerId,
        startMs: event.startMs,
        text: event.text,
        turnId,
      });
      if (result === "not-found") {
        throw new Error("Live meeting disappeared before transcript append");
      }
      await this.dependencies.finalizedMemory?.synchronizeMeeting(state.meetingId);
      if (farewellRevision !== undefined) {
        state.farewell?.observeFinalizedTurn(event, turnId, farewellRevision);
      }
      await state.conversation?.observeFinalizedTurn(
        event,
        turnId,
        () => state.finishing,
      );
    });
  }

  private tick(): void {
    const nowMs = this.clock.nowMilliseconds();
    for (const state of this.meetings.values()) {
      state.conversation?.scheduleSpeechObservation(() => state.finishing);
      state.farewell?.advance();
      state.greetings?.advance();
      this.scheduleDueRefresh(state, nowMs);
    }
  }

  private scheduleDueRefresh(state: ActiveLiveMeeting, nowMs: number): void {
    const projectionDue = state.projection.isDue(nowMs);
    const summaryDue = state.summary.isDue(nowMs);
    if (state.finishing || state.refreshQueued || (!projectionDue && !summaryDue)) {
      return;
    }
    const projectionDueAtMs = state.projection.dueAtMilliseconds;
    const summaryDueAtMs = state.summary.dueAtMilliseconds;
    state.refreshQueued = true;
    state.conversation?.advance(false);
    this.enqueueDomain(state, async () => {
      try {
        if (state.finishing) {
          return;
        }
        if (projectionDue) {
          await this.refreshProjection(state, nowMs);
        }
        if (summaryDue) {
          state.summary.start({
            isFinalizing: () => state.finishing,
            nowMs,
            requestProjection: () => {
              this.requestProjectionAfterSummary(state);
            },
          });
        }
      } finally {
        if (projectionDue) {
          state.projection.reschedule(
            projectionDueAtMs,
            this.clock.nowMilliseconds(),
          );
        }
        if (summaryDue) {
          state.summary.reschedule(
            summaryDueAtMs,
            this.clock.nowMilliseconds(),
          );
        }
        state.refreshQueued = false;
      }
    });
  }

  private requestProjectionAfterSummary(state: ActiveLiveMeeting): void {
    this.enqueueDomain(state, async () => {
      if (!state.finishing) {
        await this.refreshProjection(state, this.clock.nowMilliseconds());
      }
    });
  }

  private async refreshProjection(
    state: ActiveLiveMeeting,
    nowMs: number,
  ): Promise<void> {
    const outcome = await state.projection.refresh(nowMs, state.finishing);
    state.summary.reconcileEvidenceBase(outcome.generationBase);
  }

  private enqueueDomain(
    state: ActiveLiveMeeting,
    task: () => Promise<void>,
  ): void {
    const guarded = async (): Promise<void> => {
      try {
        await task();
      } catch (error) {
        this.dependencies.logger.warn("Derived live meeting operation failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: state.meetingId,
        });
      }
    };
    state.domainChain = state.domainChain.then(guarded, guarded);
  }
}
