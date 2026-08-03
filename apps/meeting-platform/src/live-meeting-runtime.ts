import { createHash } from "node:crypto";

import type {
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import { renderRussianLiveCaptionsMarkdown } from "@discord-meeting/discord-adapter";
import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
  type LiveCaptionSnapshot,
  type LiveGenerationTelemetrySnapshot,
  type TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core";
import type { Logger } from "@discord-meeting/observability-adapter";
import { opusPacketDurationSamples } from "@discord-meeting/recording-ingress-adapter";
import type {
  VoicetextLiveSession,
  VoicetextLiveTranscriptEvent,
  OpenVoicetextLiveSessionRequest,
} from "@discord-meeting/voicetext-adapter";

import {
  boundLiveFinalCaptionHistory,
  compareLiveCaptionSnapshots,
} from "./live-caption-history.js";
import {
  LiveSessionAdmission,
  SourceTimelinePacer,
  SpeakerPacketFlowControl,
  resolveLivePacketFlowControl,
  type LivePacketFlowControl,
  type LiveSessionRelease,
} from "./live-packet-flow-control.js";

const refreshIntervalMs = 5_000;
const refreshSchedulerIntervalMs = 100;
const maximumInitialCaptionProjectionJitterMs = 900;
const activeCaptionRetentionMs = 30_000;
const maximumRememberedMeetingPacketIds = 65_536;
const defaultSpeakerIdleFinalizeMs = 750;
const maximumLivePacketDeliveryAttempts = 2;
const initialSummaryGenerationBackoffMs = 30_000;
const maximumSummaryGenerationBackoffMs = 300_000;
const initialProjectionBackoffMs = 10_000;
const maximumProjectionBackoffMs = 300_000;

export interface LiveMeetingRuntimeDependencies {
  readonly appendTurn: AppendLiveTranscriptTurn;
  readonly finishMeeting: FinishLiveMeeting;
  readonly logger: Logger;
  /** Compatibility-only direct target used by deterministic legacy tests. */
  readonly publicationTargetId?: string;
  readonly publicationTargets?: {
    resolve(input: {
      readonly guildId: string;
      readonly voiceChannelId: string;
    }): Promise<string | null>;
  };
  /**
   * Bounds the derived-only live projection. The authoritative Craig spool is
   * committed before this runtime receives a packet batch.
   */
  readonly packetFlowControl?: LivePacketFlowControl;
  readonly refreshMeeting: RefreshLiveMeeting;
  readonly speakerIdleFinalizeMs?: number;
  readonly startMeeting: StartLiveMeeting;
  readonly transcriber: LiveTranscriptionPort;
}

interface LiveTranscriptionPort {
  openSession(
    request: OpenVoicetextLiveSessionRequest,
  ): Promise<VoicetextLiveSession>;
}

interface SpeakerStream {
  admissionChain: Promise<void>;
  backpressureDegraded: boolean;
  chain: Promise<void>;
  inactivityTimer: NodeJS.Timeout | null;
  lastRelativeTimeMs: number | null;
  nextSegment: number;
  openingAbortController: AbortController | null;
  readonly packetFlow: SpeakerPacketFlowControl;
  readonly pacer: SourceTimelinePacer;
  session: VoicetextLiveSession | null;
  sessionLease: LiveSessionRelease | null;
}

interface LiveMeetingState {
  readonly activeCaptions: Map<string, LiveCaptionSnapshot>;
  domainChain: Promise<void>;
  readonly finalCaptions: Map<string, LiveCaptionSnapshot>;
  finishPromise: Promise<void> | null;
  finishing: boolean;
  generationFailureCount: number;
  permanentGenerationBase: string | null;
  generationPromise: Promise<void> | null;
  generationRetryAtMs: number;
  lastProjectedCaptionsSignature: string | null;
  readonly meetingId: string;
  nextRefreshAtMs: number;
  nextSummaryRefreshAtMs: number;
  readonly packetIdOrder: string[];
  readonly packetIds: Set<string>;
  permanentProjectionFailureCode: string | null;
  projectionFailureCount: number;
  projectionRetryAtMs: number;
  refreshQueued: boolean;
  /** Failed after bounded inline delivery attempts; exact replay stays eligible. */
  readonly retryablePacketIds: Map<string, true>;
  readonly speakers: Map<string, SpeakerStream>;
  readonly startedAtMs: number;
}

export class PlatformLiveMeetingRuntime {
  private readonly meetings = new Map<string, LiveMeetingState>();
  private readonly maximumQueuedPacketsPerSpeaker: number;
  private readonly packetBackpressureTimeoutMs: number;
  private readonly refreshTimer: NodeJS.Timeout;
  private readonly sessionAdmission: LiveSessionAdmission;
  private readonly speakerIdleFinalizeMs: number;

  public constructor(
    private readonly dependencies: LiveMeetingRuntimeDependencies,
  ) {
    if (
      dependencies.publicationTargets === undefined &&
      dependencies.publicationTargetId === undefined
    ) {
      throw new Error("a live meeting publication target source is required");
    }
    this.speakerIdleFinalizeMs = validateSpeakerIdleFinalizeMs(
      dependencies.speakerIdleFinalizeMs,
    );
    const packetFlowControl = resolveLivePacketFlowControl(
      dependencies.packetFlowControl,
    );
    this.maximumQueuedPacketsPerSpeaker =
      packetFlowControl.maximumQueuedPacketsPerSpeaker;
    this.packetBackpressureTimeoutMs =
      packetFlowControl.packetBackpressureTimeoutMs;
    this.sessionAdmission = new LiveSessionAdmission(
      packetFlowControl.maximumConcurrentSessions,
    );
    this.refreshTimer = setInterval(() => {
      this.tick();
    }, refreshSchedulerIntervalMs);
    this.refreshTimer.unref();
  }

  public async acceptLifecycle(event: CraigLifecycleEvent): Promise<void> {
    if (event.type === "meeting.started") {
      await this.start(event);
      return;
    }
    if (event.type === "meeting.ended" || event.type === "meeting.aborted") {
      const state = this.meetings.get(event.recordingId);
      if (state !== undefined) {
        this.beginFinish(state, Date.parse(event.occurredAt));
      }
    }
  }

  /**
   * Admits packets only after their durable Craig write has completed. A full
   * derived queue applies bounded HTTP backpressure; it never advances the
   * live timeline and silently discards the packet.
   */
  public async acceptVoiceBatch(batch: VoicePacketBatch): Promise<void> {
    const deadlineMs = Date.now() + this.packetBackpressureTimeoutMs;
    const batches = new Map<
      string,
      {
        readonly packets: Array<VoicePacketBatch["packets"][number]>;
        readonly state: LiveMeetingState;
        readonly stream: SpeakerStream;
      }
    >();
    for (const packet of batch.packets) {
      const state = this.meetings.get(packet.recordingId);
      if (state === undefined || state.finishing) {
        this.dependencies.logger.debug(
          "Live packet skipped without active derived meeting",
          {
            meetingId: packet.recordingId,
            speakerId: packet.speakerId,
          },
        );
        continue;
      }
      const stream = this.speakerStream(state, packet.speakerId);
      const key = `${packet.recordingId}\0${packet.speakerId}`;
      const grouped = batches.get(key);
      if (grouped === undefined) {
        batches.set(key, { packets: [packet], state, stream });
      } else {
        grouped.packets.push(packet);
      }
    }
    await Promise.all(
      [...batches.values()].map(({ packets, state, stream }) =>
        this.enqueuePacketAdmission(state, stream, packets, deadlineMs),
      ),
    );
  }

  private enqueuePacketAdmission(
    state: LiveMeetingState,
    stream: SpeakerStream,
    packets: readonly VoicePacketBatch["packets"][number][],
    deadlineMs: number,
  ): Promise<void> {
    if (!stream.packetFlow.tryReserveAdmission(packets.length)) {
      this.notePacketAdmissionBacklogOverflow(
        state,
        stream,
        packets[0]!.speakerId,
      );
      return Promise.resolve();
    }
    const admit = async () => {
      try {
        for (const packet of packets) {
          try {
            await this.admitLivePacket(state, stream, packet, deadlineMs);
          } catch (error) {
            this.dependencies.logger.warn(
              "Derived live packet admission failed",
              {
                errorName: error instanceof Error ? error.name : "UnknownError",
                meetingId: state.meetingId,
                speakerId: packet.speakerId,
              },
            );
          }
        }
      } finally {
        stream.packetFlow.releaseAdmission(packets.length);
      }
    };
    const completion = stream.admissionChain.then(admit, admit);
    // A bad derived packet must not poison admission for future durable Craig
    // retries of this speaker.
    stream.admissionChain = completion.catch(() => {});
    return completion;
  }

  private async admitLivePacket(
    state: LiveMeetingState,
    stream: SpeakerStream,
    packet: VoicePacketBatch["packets"][number],
    deadlineMs: number,
  ): Promise<void> {
    if (this.isFinishing(state)) {
      return;
    }
    const packetId = packetIdentity(packet);
    if (this.isLivePacketSuppressed(state, stream, packet, packetId)) {
      return;
    }
    if (
      !(await stream.packetFlow.waitForQueueSlot(
        deadlineMs,
        () => this.isFinishing(state),
      ))
    ) {
      if (!this.isFinishing(state)) {
        this.notePacketBackpressureTimeout(state, stream, packet.speakerId);
      }
      return;
    }
    if (
      this.isFinishing(state) ||
      this.isLivePacketSuppressed(state, stream, packet, packetId)
    ) {
      return;
    }
    this.cancelSpeakerIdleFinalization(stream);
    stream.packetFlow.reserveQueueSlot();
    const task = async () => {
      try {
        await this.sendLivePacket(state, stream, packet, packetId);
      } catch (error) {
        this.terminateSpeakerSession(stream);
        if (!state.finishing && !stream.packetFlow.signal.aborted) {
          this.dependencies.logger.warn(
            "Derived live transcription packet failed",
            {
              errorName: error instanceof Error ? error.name : "UnknownError",
              meetingId: state.meetingId,
              speakerId: packet.speakerId,
            },
          );
        }
      } finally {
        stream.packetFlow.releaseQueueSlot();
        if (
          stream.packetFlow.queuedPacketCount === 0 &&
          stream.session !== null &&
          !state.finishing
        ) {
          this.scheduleSpeakerIdleFinalization(state, packet.speakerId, stream);
        }
      }
    };
    stream.chain = stream.chain.then(task, task);
  }

  private notePacketBackpressureTimeout(
    state: LiveMeetingState,
    stream: SpeakerStream,
    speakerId: string,
  ): void {
    this.notePacketDegradation(
      state,
      stream,
      speakerId,
      "LIVE_PACKET_BACKPRESSURE_TIMEOUT",
    );
  }

  private notePacketAdmissionBacklogOverflow(
    state: LiveMeetingState,
    stream: SpeakerStream,
    speakerId: string,
  ): void {
    this.notePacketDegradation(
      state,
      stream,
      speakerId,
      "LIVE_PACKET_ADMISSION_BACKLOG_FULL",
    );
  }

  private notePacketDegradation(
    state: LiveMeetingState,
    stream: SpeakerStream,
    speakerId: string,
    errorCode: "LIVE_PACKET_ADMISSION_BACKLOG_FULL" | "LIVE_PACKET_BACKPRESSURE_TIMEOUT",
  ): void {
    if (stream.backpressureDegraded) {
      return;
    }
    stream.backpressureDegraded = true;
    this.dependencies.logger.warn(
      "Derived live transcription degraded after packet backpressure",
      {
        errorCode,
        maximumQueuedPacketsPerSpeaker: stream.packetFlow.maximumQueuedPackets,
        meetingId: state.meetingId,
        packetBackpressureTimeoutMs: this.packetBackpressureTimeoutMs,
        pendingAdmissionPackets: stream.packetFlow.pendingAdmissionPacketCount,
        queuedPackets: stream.packetFlow.queuedPacketCount,
        speakerId,
      },
    );
  }

  private async sendLivePacket(
    state: LiveMeetingState,
    stream: SpeakerStream,
    packet: VoicePacketBatch["packets"][number],
    packetId: string,
  ): Promise<void> {
    // Admission happens before the provider I/O so that Craig's durable ingest
    // remains bounded. Re-check completion state here: another queued retry
    // may have completed while this task was waiting its turn.
    if (
      this.isFinishing(state) ||
      this.isLivePacketSuppressed(state, stream, packet, packetId)
    ) {
      return;
    }
    const opus = Buffer.from(packet.opusBase64, "base64");
    const durationSamples48Khz = opusPacketDurationSamples(opus);
    const earliestPacketAtMs = await stream.pacer.waitForPacketTime(
      state.startedAtMs,
      packet.relativeTimeMs,
      stream.packetFlow.signal,
    );
    if (earliestPacketAtMs === null) {
      return;
    }
    // Keep a failed head packet ahead of later audio from the same speaker.
    // One bounded reconnect/send retry handles a transient provider failure
    // without requiring Craig to redeliver A after queued B has advanced the
    // live timeline.
    for (
      let attempt = 1;
      attempt <= maximumLivePacketDeliveryAttempts;
      attempt += 1
    ) {
      try {
        const session = await this.openSpeakerSession(
          state,
          stream,
          packet.speakerId,
        );
        if (session === null || stream.packetFlow.signal.aborted) {
          return;
        }
        const sendStartedAtMs = Date.now();
        await session.sendPacket({
          durationSamples48Khz,
          opus,
          packetId,
          relativeTimeMs: packet.relativeTimeMs,
        });
        this.commitLivePacketSend(
          state,
          stream,
          packet,
          packetId,
          earliestPacketAtMs,
          durationSamples48Khz,
          sendStartedAtMs,
        );
        return;
      } catch (error) {
        this.terminateSpeakerSession(stream);
        if (state.finishing || stream.packetFlow.signal.aborted) {
          return;
        }
        if (attempt === maximumLivePacketDeliveryAttempts) {
          this.rememberRetryableLivePacket(state, packet, packetId);
          throw error;
        }
      }
    }
  }

  private commitLivePacketSend(
    state: LiveMeetingState,
    stream: SpeakerStream,
    packet: VoicePacketBatch["packets"][number],
    packetId: string,
    earliestPacketAtMs: number,
    durationSamples48Khz: number,
    sendStartedAtMs: number,
  ): void {
    // A provider success is the commit point for live-only identity and
    // timeline state. If opening/sending fails, the same durable Craig packet
    // can be admitted again instead of being silently suppressed as a replay.
    stream.pacer.recordPacketSent(
      earliestPacketAtMs,
      durationSamples48Khz,
      sendStartedAtMs,
    );
    const recoveredFailedPacket = state.retryablePacketIds.delete(packetId);
    stream.lastRelativeTimeMs = Math.max(
      stream.lastRelativeTimeMs ?? packet.relativeTimeMs,
      packet.relativeTimeMs,
    );
    rememberMeetingPacket(state, packetId);
    if (recoveredFailedPacket) {
      this.dependencies.logger.info(
        "Derived live transcription packet recovered after delivery failure",
        {
          meetingId: state.meetingId,
          speakerId: packet.speakerId,
        },
      );
    }
    if (stream.backpressureDegraded) {
      stream.backpressureDegraded = false;
      this.dependencies.logger.info(
        "Derived live transcription recovered from backpressure",
        {
          meetingId: state.meetingId,
          speakerId: packet.speakerId,
        },
      );
    }
  }

  private rememberRetryableLivePacket(
    state: LiveMeetingState,
    packet: VoicePacketBatch["packets"][number],
    packetId: string,
  ): void {
    if (state.retryablePacketIds.has(packetId)) {
      return;
    }
    state.retryablePacketIds.set(packetId, true);
    if (state.retryablePacketIds.size > maximumRememberedMeetingPacketIds) {
      const oldestPacketId = state.retryablePacketIds.keys().next().value;
      if (oldestPacketId !== undefined) {
        state.retryablePacketIds.delete(oldestPacketId);
      }
    }
    this.dependencies.logger.warn(
      "Derived live transcription packet exhausted bounded delivery retries",
      {
        errorCode: "LIVE_PACKET_DELIVERY_RETRY_EXHAUSTED",
        meetingId: state.meetingId,
        relativeTimeMs: packet.relativeTimeMs,
        speakerId: packet.speakerId,
      },
    );
  }

  private isLivePacketSuppressed(
    state: LiveMeetingState,
    stream: SpeakerStream,
    packet: VoicePacketBatch["packets"][number],
    packetId: string,
  ): boolean {
    if (state.packetIds.has(packetId)) {
      return true;
    }
    // A failed head packet may be replayed after a later packet has made
    // progress. This is the bounded degraded fallback after inline recovery
    // has already tried to preserve provider send order.
    if (state.retryablePacketIds.has(packetId)) {
      return false;
    }
    if (
      stream.lastRelativeTimeMs === null ||
      packet.relativeTimeMs >= stream.lastRelativeTimeMs
    ) {
      return false;
    }
    this.dependencies.logger.warn("Out-of-order live packet skipped", {
      meetingId: state.meetingId,
      speakerId: packet.speakerId,
    });
    return true;
  }

  private async openSpeakerSession(
    state: LiveMeetingState,
    stream: SpeakerStream,
    speakerId: string,
  ): Promise<VoicetextLiveSession | null> {
    if (stream.session !== null) {
      return stream.session;
    }
    const lease = await this.sessionAdmission.acquire(
      stream.packetFlow.signal,
    );
    if (lease === null) {
      return null;
    }
    stream.sessionLease = lease;
    const openingAbortController = new AbortController();
    stream.openingAbortController = openingAbortController;
    try {
      const segment = stream.nextSegment;
      stream.nextSegment += 1;
      const session = await this.dependencies.transcriber.openSession({
        idempotencyKey: `voicetext-live:v2|${state.meetingId}|${speakerId}|${segment}`,
        meetingId: state.meetingId,
        onTranscript: (transcript) => {
          this.acceptTranscript(state, transcript);
        },
        signal: openingAbortController.signal,
        speakerId,
      });
      if (
        openingAbortController.signal.aborted ||
        stream.sessionLease !== lease
      ) {
        session.terminate();
        if (stream.sessionLease === lease) {
          stream.sessionLease = null;
          lease();
        }
        return null;
      }
      stream.session = session;
      return session;
    } catch (error) {
      if (stream.sessionLease === lease) {
        stream.sessionLease = null;
        lease();
      }
      throw error;
    } finally {
      if (stream.openingAbortController === openingAbortController) {
        stream.openingAbortController = null;
      }
    }
  }

  private terminateSpeakerSession(stream: SpeakerStream): void {
    const session = stream.session;
    const lease = stream.sessionLease;
    stream.session = null;
    stream.sessionLease = null;
    session?.terminate();
    lease?.();
  }

  private async finalizeSpeakerSession(
    state: LiveMeetingState,
    speakerId: string,
    stream: SpeakerStream,
    failureMessage: string,
  ): Promise<void> {
    const session = stream.session;
    const lease = stream.sessionLease;
    stream.session = null;
    stream.sessionLease = null;
    if (session === null) {
      lease?.();
      return;
    }
    try {
      await session.finalize();
    } catch (error) {
      session.terminate();
      this.dependencies.logger.warn(failureMessage, {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: state.meetingId,
        speakerId,
      });
    } finally {
      lease?.();
    }
  }

  public prepareForAuthoritativeFinal(recordingId: string): void {
    const state = this.meetings.get(recordingId);
    if (state === undefined) {
      return;
    }
    this.beginFinish(state, Date.now());
  }

  public async settleBeforeFinalPublication(
    recordingId: string,
  ): Promise<void> {
    const state = this.meetings.get(recordingId);
    if (state === undefined) {
      return;
    }
    this.beginFinish(state, Date.now());
    await state.finishPromise;
  }

  public async close(): Promise<void> {
    clearInterval(this.refreshTimer);
    const nowMs = Date.now();
    await Promise.allSettled(
      [...this.meetings.values()].map((state) => {
        this.beginFinish(state, nowMs);
        return state.finishPromise ?? Promise.resolve();
      }),
    );
  }

  private async start(
    event: Extract<CraigLifecycleEvent, { readonly type: "meeting.started" }>,
  ): Promise<void> {
    if (this.meetings.has(event.recordingId)) {
      return;
    }
    const publicationTargetId =
      this.dependencies.publicationTargetId ??
      (await this.dependencies.publicationTargets?.resolve({
        guildId: event.guildId,
        voiceChannelId: event.channelId,
      })) ??
      null;
    if (publicationTargetId === null) {
      this.dependencies.logger.warn(
        "Derived live meeting skipped for unconfigured channel",
        {
          guildId: event.guildId,
          meetingId: event.recordingId,
          voiceChannelId: event.channelId,
        },
      );
      return;
    }
    const state: LiveMeetingState = {
      activeCaptions: new Map(),
      domainChain: Promise.resolve(),
      finalCaptions: new Map(),
      finishPromise: null,
      finishing: false,
      generationFailureCount: 0,
      permanentGenerationBase: null,
      generationPromise: null,
      generationRetryAtMs: 0,
      lastProjectedCaptionsSignature: null,
      meetingId: event.recordingId,
      nextRefreshAtMs: Date.now() + refreshIntervalMs,
      nextSummaryRefreshAtMs: Date.now() + refreshIntervalMs,
      packetIdOrder: [],
      packetIds: new Set(),
      permanentProjectionFailureCode: null,
      projectionFailureCount: 0,
      projectionRetryAtMs: 0,
      refreshQueued: false,
      retryablePacketIds: new Map(),
      speakers: new Map(),
      startedAtMs: Date.parse(event.occurredAt),
    };
    this.meetings.set(event.recordingId, state);
    this.enqueueDomain(state, async () => {
      const result = await this.dependencies.startMeeting.execute({
        meetingId: state.meetingId,
        publicationTargetId,
        startedAtMs: state.startedAtMs,
      });
      restoreFinalCaptions(state, result.finalizedTurns);
      this.dependencies.logger.info("Derived live meeting started", {
        meetingId: state.meetingId,
        reused: result.status === "reused",
      });
    });
  }

  private speakerStream(
    state: LiveMeetingState,
    speakerId: string,
  ): SpeakerStream {
    const existing = state.speakers.get(speakerId);
    if (existing !== undefined) {
      return existing;
    }
    const created: SpeakerStream = {
      admissionChain: Promise.resolve(),
      backpressureDegraded: false,
      chain: Promise.resolve(),
      inactivityTimer: null,
      lastRelativeTimeMs: null,
      nextSegment: 1,
      openingAbortController: null,
      packetFlow: new SpeakerPacketFlowControl(
        this.maximumQueuedPacketsPerSpeaker,
      ),
      pacer: new SourceTimelinePacer(),
      session: null,
      sessionLease: null,
    };
    state.speakers.set(speakerId, created);
    return created;
  }

  private isFinishing(state: LiveMeetingState): boolean {
    return state.finishing;
  }

  private acceptTranscript(
    state: LiveMeetingState,
    event: VoicetextLiveTranscriptEvent,
  ): void {
    const caption: LiveCaptionSnapshot = {
      endMs: event.endMs,
      isFinal: event.isFinal,
      speakerId: event.speakerId,
      startMs: event.startMs,
      text: event.text,
    };
    if (!event.isFinal) {
      state.activeCaptions.set(event.speakerId, caption);
      scheduleFirstCaptionProjection(state, caption.text);
      return;
    }
    state.activeCaptions.delete(event.speakerId);
    state.finalCaptions.set(stableTurnId(event), caption);
    boundLiveFinalCaptionHistory(state.finalCaptions);
    scheduleFirstCaptionProjection(state, caption.text);
    this.dependencies.logger.info("Live transcript turn finalized", {
      endMs: event.endMs,
      meetingId: state.meetingId,
      providerLagMs: Math.max(
        0,
        Date.now() - (state.startedAtMs + event.endMs),
      ),
      speakerId: event.speakerId,
      startMs: event.startMs,
    });
    this.enqueueDomain(state, async () => {
      const result = await this.dependencies.appendTurn.execute(
        state.meetingId,
        {
          endMs: event.endMs,
          speakerId: event.speakerId,
          startMs: event.startMs,
          text: event.text,
          turnId: stableTurnId(event),
        },
      );
      if (result === "not-found") {
        throw new Error("Live meeting disappeared before transcript append");
      }
    });
  }

  private tick(): void {
    const nowMs = Date.now();
    for (const state of this.meetings.values()) {
      const projectionDue = nowMs >= state.nextRefreshAtMs;
      const summaryDue = nowMs >= state.nextSummaryRefreshAtMs;
      if (
        state.finishing ||
        state.refreshQueued ||
        (!projectionDue && !summaryDue)
      ) {
        continue;
      }
      const refreshDueAtMs = state.nextRefreshAtMs;
      const summaryDueAtMs = state.nextSummaryRefreshAtMs;
      state.refreshQueued = true;
      this.enqueueDomain(state, async () => {
        try {
          if (state.finishing) {
            return;
          }
          if (projectionDue) {
            await this.refreshProjection(state, nowMs);
          }
          if (summaryDue) {
            this.startSummaryGeneration(state, nowMs);
          }
        } finally {
          if (projectionDue) {
            state.nextRefreshAtMs = nextRefreshAtMs(refreshDueAtMs, Date.now());
          }
          if (summaryDue) {
            state.nextSummaryRefreshAtMs = nextRefreshAtMs(
              summaryDueAtMs,
              Date.now(),
            );
          }
          state.refreshQueued = false;
        }
      });
    }
  }

  private async refreshProjection(
    state: LiveMeetingState,
    nowMs: number,
  ): Promise<void> {
    const refreshStartedAtMs = performance.now();
    const captions = collectLiveCaptions(
      state,
      Math.max(0, nowMs - state.startedAtMs),
    );
    const captionsSignature = liveCaptionsSignature(captions);
    const projectionAllowed = this.projectionAllowed(state, nowMs);
    const result = await this.dependencies.refreshMeeting.execute({
      captions,
      meetingId: state.meetingId,
      nowMs,
      ...(projectionAllowed ? {} : { projection: "skip" as const }),
      projectionRequested:
        projectionAllowed &&
        captionsSignature !== state.lastProjectedCaptionsSignature,
      summaryGeneration: "skip",
    });
    if (result.status === "not-found") {
      throw new Error("Live meeting disappeared before refresh");
    }
    this.reconcilePermanentGenerationFence(state, result.generationBase);
    if (result.projectionFailure !== undefined) {
      if (result.projectionFailure.retryable) {
        this.deferProjection(state, result.projectionFailure.code);
      } else {
        this.fencePermanentProjectionFailure(
          state,
          result.projectionFailure.code,
        );
      }
      this.dependencies.logger.warn("Live Discord projection refresh failed", {
        errorCode: result.projectionFailure.code,
        meetingId: state.meetingId,
        retryable: result.projectionFailure.retryable,
      });
    }
    if (result.projected) {
      state.lastProjectedCaptionsSignature = captionsSignature;
      state.projectionFailureCount = 0;
      state.projectionRetryAtMs = 0;
    }
    this.dependencies.logger.info("Live caption projection refresh completed", {
      durationMs: Math.max(0, performance.now() - refreshStartedAtMs),
      meetingId: state.meetingId,
      projectionAllowed,
      projected: result.projected,
    });
  }

  private projectionAllowed(state: LiveMeetingState, nowMs: number): boolean {
    return (
      state.permanentProjectionFailureCode === null &&
      nowMs >= state.projectionRetryAtMs
    );
  }

  private deferProjection(state: LiveMeetingState, errorCode: string): void {
    state.projectionFailureCount += 1;
    const delayMs = projectionBackoffDelayMs(
      state.meetingId,
      state.projectionFailureCount,
    );
    state.projectionRetryAtMs = Date.now() + delayMs;
    this.dependencies.logger.info("Live Discord projection retry deferred", {
      delayMs,
      errorCode,
      failureCount: state.projectionFailureCount,
      meetingId: state.meetingId,
    });
  }

  private fencePermanentProjectionFailure(
    state: LiveMeetingState,
    errorCode: string,
  ): void {
    if (state.permanentProjectionFailureCode !== null) {
      return;
    }
    state.permanentProjectionFailureCode = errorCode;
    state.projectionFailureCount = 0;
    state.projectionRetryAtMs = Number.POSITIVE_INFINITY;
    this.dependencies.logger.error(
      "Live Discord projection permanently fenced",
      {
        errorCode,
        meetingId: state.meetingId,
        release: "runtime-restart-or-configuration-change",
      },
    );
  }

  private startSummaryGeneration(state: LiveMeetingState, nowMs: number): void {
    if (
      state.finishing ||
      state.generationPromise !== null ||
      state.permanentGenerationBase !== null ||
      nowMs < state.generationRetryAtMs
    ) {
      return;
    }
    const generation = this.generateSummary(state, nowMs)
      .catch((error: unknown) => {
        this.deferSummaryGeneration(
          state,
          "UNEXPECTED_LIVE_GENERATION_FAILURE",
          true,
        );
        this.dependencies.logger.warn(
          "Incremental meeting summary refresh failed",
          {
            errorCode: "UNEXPECTED_LIVE_GENERATION_FAILURE",
            errorName: error instanceof Error ? error.name : "UnknownError",
            meetingId: state.meetingId,
            retryable: true,
          },
        );
      })
      .finally(() => {
        if (state.generationPromise === generation) {
          state.generationPromise = null;
        }
      });
    state.generationPromise = generation;
  }

  private async generateSummary(
    state: LiveMeetingState,
    nowMs: number,
  ): Promise<void> {
    const generationStartedAtMs = performance.now();
    const result = await this.dependencies.refreshMeeting.execute({
      captions: [],
      meetingId: state.meetingId,
      nowMs,
      projection: "skip",
      projectionRequested: false,
    });
    if (result.status === "not-found") {
      throw new Error("Live meeting disappeared before summary generation");
    }
    if (result.generationFailure !== undefined) {
      if (result.generationFailure.retryable) {
        this.deferSummaryGeneration(state, result.generationFailure.code, true);
      } else {
        this.fencePermanentGenerationFailure(
          state,
          result.generationBase,
          result.generationFailure.code,
        );
      }
      this.dependencies.logger.warn(
        "Incremental meeting summary refresh failed",
        {
          errorCode: result.generationFailure.code,
          meetingId: state.meetingId,
          retryable: result.generationFailure.retryable,
        },
      );
    } else if (result.generated) {
      state.generationFailureCount = 0;
      state.generationRetryAtMs = 0;
      if (!state.finishing) {
        this.enqueueDomain(state, async () => {
          if (!state.finishing) {
            await this.refreshProjection(state, Date.now());
          }
        });
      }
    } else if (result.generationStale === true) {
      this.dependencies.logger.info(
        "Incremental meeting summary result was stale",
        {
          meetingId: state.meetingId,
        },
      );
    }
    if (result.generationTelemetry !== undefined) {
      this.dependencies.logger.info(
        "Incremental meeting summary telemetry recorded",
        generationTelemetryLogFields(
          state.meetingId,
          result.generationTelemetry,
        ),
      );
    }
    if (result.generationUsage !== undefined) {
      this.dependencies.logger.info(
        "Incremental meeting summary usage measured",
        {
          apiEquivalentCostUsd: result.generationUsage.apiEquivalentCostUsd,
          cachedInputTokens: result.generationUsage.cachedInputTokens,
          inputTokens: result.generationUsage.inputTokens,
          meetingId: state.meetingId,
          model: result.generationUsage.model,
          outputTokens: result.generationUsage.outputTokens,
          priceCard: result.generationUsage.priceCard,
          totalTokens: result.generationUsage.totalTokens,
        },
      );
    } else if (result.generated && result.generationTelemetry === undefined) {
      this.dependencies.logger.warn(
        "Incremental meeting summary usage telemetry is missing",
        {
          meetingId: state.meetingId,
        },
      );
    }
    this.dependencies.logger.info(
      "Incremental meeting summary refresh completed",
      {
        durationMs: Math.max(0, performance.now() - generationStartedAtMs),
        generated: result.generated,
        meetingId: state.meetingId,
        stale: result.generationStale ?? false,
      },
    );
  }

  private deferSummaryGeneration(
    state: LiveMeetingState,
    errorCode: string,
    retryable: boolean,
  ): void {
    state.generationFailureCount += 1;
    const exponent = Math.min(state.generationFailureCount - 1, 4);
    const delayMs = Math.min(
      initialSummaryGenerationBackoffMs * 2 ** exponent,
      maximumSummaryGenerationBackoffMs,
    );
    state.generationRetryAtMs = Date.now() + delayMs;
    this.dependencies.logger.info(
      "Incremental meeting summary retry deferred",
      {
        delayMs,
        errorCode,
        failureCount: state.generationFailureCount,
        meetingId: state.meetingId,
        retryable,
      },
    );
  }

  private fencePermanentGenerationFailure(
    state: LiveMeetingState,
    generationBase: string | undefined,
    errorCode: string,
  ): void {
    if (generationBase === undefined) {
      this.deferSummaryGeneration(state, errorCode, true);
      return;
    }
    state.generationFailureCount = 0;
    state.generationRetryAtMs = Number.POSITIVE_INFINITY;
    state.permanentGenerationBase = generationBase;
    this.dependencies.logger.info(
      "Incremental meeting summary permanently fenced",
      {
        errorCode,
        meetingId: state.meetingId,
      },
    );
  }

  private reconcilePermanentGenerationFence(
    state: LiveMeetingState,
    generationBase: string | undefined,
  ): void {
    if (
      state.permanentGenerationBase === null ||
      generationBase === undefined ||
      generationBase === state.permanentGenerationBase
    ) {
      return;
    }
    state.generationFailureCount = 0;
    state.generationRetryAtMs = 0;
    state.permanentGenerationBase = null;
    this.dependencies.logger.info(
      "Incremental meeting summary fence cleared for new evidence",
      {
        meetingId: state.meetingId,
      },
    );
  }

  private async finish(
    state: LiveMeetingState,
    endedAtMs: number,
  ): Promise<void> {
    const finalizeTasks = [...state.speakers.entries()].map(
      async ([speakerId, stream]) => {
        this.cancelSpeakerIdleFinalization(stream);
        await stream.chain.catch(() => {});
        await this.finalizeSpeakerSession(
          state,
          speakerId,
          stream,
          "Derived live speaker finalize failed",
        );
      },
    );
    await Promise.allSettled(finalizeTasks);
    await state.generationPromise?.catch(() => {});
    this.enqueueDomain(state, async () => {
      const result = await this.dependencies.finishMeeting.execute(
        state.meetingId,
        endedAtMs,
      );
      if (result === "not-found") {
        throw new Error("Live meeting disappeared before finish");
      }
      // Craig acknowledgement is no longer coupled to this work. The final
      // publisher waits on this finish promise, so keep the terminal projection
      // fast and let the durable post-call summary reconcile every turn.
      await this.refreshProjection(state, endedAtMs);
    });
    try {
      await state.domainChain;
    } finally {
      this.meetings.delete(state.meetingId);
    }
  }

  private beginFinish(state: LiveMeetingState, endedAtMs: number): void {
    if (state.finishing) {
      return;
    }
    state.finishing = true;
    for (const stream of state.speakers.values()) {
      this.cancelSpeakerIdleFinalization(stream);
      stream.packetFlow.cancel();
      stream.openingAbortController?.abort();
    }
    const finishPromise = this.finish(state, endedAtMs);
    state.finishPromise = finishPromise;
    void finishPromise.catch((error: unknown) => {
      this.dependencies.logger.error(
        "Derived live meeting finalization failed",
        {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: state.meetingId,
        },
      );
    });
  }

  private scheduleSpeakerIdleFinalization(
    state: LiveMeetingState,
    speakerId: string,
    stream: SpeakerStream,
  ): void {
    this.cancelSpeakerIdleFinalization(stream);
    stream.inactivityTimer = setTimeout(() => {
      stream.inactivityTimer = null;
      const finalize = async () => {
        if (
          state.finishing ||
          stream.packetFlow.queuedPacketCount > 0 ||
          stream.session === null
        ) {
          return;
        }
        await this.finalizeSpeakerSession(
          state,
          speakerId,
          stream,
          "Derived live idle speaker finalize failed",
        );
      };
      stream.chain = stream.chain.then(finalize, finalize);
    }, this.speakerIdleFinalizeMs);
    stream.inactivityTimer.unref();
  }

  private cancelSpeakerIdleFinalization(stream: SpeakerStream): void {
    if (stream.inactivityTimer !== null) {
      clearTimeout(stream.inactivityTimer);
      stream.inactivityTimer = null;
    }
  }

  private enqueueDomain(
    state: LiveMeetingState,
    task: () => Promise<void>,
  ): void {
    const guarded = async () => {
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

function liveCaptionsSignature(
  captions: readonly LiveCaptionSnapshot[],
): string {
  return createHash("sha256")
    .update(renderRussianLiveCaptionsMarkdown(captions), "utf8")
    .digest("hex");
}

function restoreFinalCaptions(
  state: LiveMeetingState,
  turns: readonly TranscriptTurnSnapshot[],
): void {
  for (const turn of turns) {
    state.finalCaptions.set(turn.turnId, {
      endMs: turn.endMs,
      isFinal: true,
      speakerId: turn.speakerId,
      startMs: turn.startMs,
      text: turn.text,
    });
  }
  boundLiveFinalCaptionHistory(state.finalCaptions);
}

function scheduleFirstCaptionProjection(
  state: LiveMeetingState,
  captionText: string,
): void {
  if (
    state.finishing ||
    state.lastProjectedCaptionsSignature !== null ||
    captionText.trim().length === 0
  ) {
    return;
  }
  const dueAtMs =
    Date.now() +
    deterministicOffsetMs(
      "live-first-caption-projection:v1",
      state.meetingId,
      maximumInitialCaptionProjectionJitterMs,
    );
  state.nextRefreshAtMs = Math.min(state.nextRefreshAtMs, dueAtMs);
}

function nextRefreshAtMs(previousDueAtMs: number, nowMs: number): number {
  const scheduled = previousDueAtMs + refreshIntervalMs;
  return scheduled > nowMs ? scheduled : nowMs + refreshIntervalMs;
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
  return (
    baseDelayMs -
    deterministicOffsetMs(
      `live-projection-retry:v1:${failureCount}`,
      meetingId,
      jitterBudgetMs,
    )
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
    .update(`${namespace}\0${meetingId}`, "utf8")
    .digest();
  return digest.readUInt32BE(0) % (maximumOffsetMs + 1);
}

function collectLiveCaptions(
  state: LiveMeetingState,
  elapsedMs: number,
): readonly LiveCaptionSnapshot[] {
  const cutoffMs = elapsedMs - activeCaptionRetentionMs;
  for (const [speakerId, caption] of state.activeCaptions) {
    if (caption.endMs < cutoffMs) {
      state.activeCaptions.delete(speakerId);
    }
  }

  return [
    ...state.finalCaptions.values(),
    ...state.activeCaptions.values(),
  ].toSorted(compareLiveCaptionSnapshots);
}

function generationTelemetryLogFields(
  meetingId: string,
  telemetry: LiveGenerationTelemetrySnapshot,
): Record<string, unknown> {
  return {
    cacheWriteInputTokens: telemetryTokenLogValue(
      telemetry.cacheWriteInputTokens,
    ),
    cachedInputTokens: telemetryTokenLogValue(telemetry.cachedInputTokens),
    ...(telemetry.cost === undefined
      ? {}
      : {
          ...(telemetry.cost.exactUsd === undefined
            ? {}
            : { exactCostUsd: telemetry.cost.exactUsd }),
          maximumCostUsd: telemetry.cost.maximumUsd,
          minimumCostUsd: telemetry.cost.minimumUsd,
          priceCardId: telemetry.cost.priceCardId,
          priceCardSource: telemetry.cost.priceCardSource,
        }),
    inputTokens: telemetryTokenLogValue(telemetry.inputTokens),
    meetingId,
    model: telemetry.model,
    outputTokens: telemetryTokenLogValue(telemetry.outputTokens),
    reasoningOutputTokens: telemetryTokenLogValue(
      telemetry.reasoningOutputTokens,
    ),
    runId: telemetry.runId,
    source: telemetry.source,
    totalTokens: telemetryTokenLogValue(telemetry.totalTokens),
  };
}

function telemetryTokenLogValue(
  token: LiveGenerationTelemetrySnapshot["inputTokens"],
): Record<string, unknown> {
  if (token.availability === "unavailable") {
    return { availability: "unavailable" };
  }
  if (token.availability === "measured") {
    return { availability: "measured", value: token.value };
  }
  return {
    availability: "derived",
    derivedFrom: token.derivedFrom,
    value: token.value,
  };
}

function validateSpeakerIdleFinalizeMs(value: number | undefined): number {
  const resolved = value ?? defaultSpeakerIdleFinalizeMs;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 10_000) {
    throw new RangeError("speakerIdleFinalizeMs must be between 100 and 10000");
  }
  return resolved;
}

function rememberMeetingPacket(
  state: LiveMeetingState,
  packetId: string,
): void {
  state.packetIds.add(packetId);
  state.packetIdOrder.push(packetId);
  if (state.packetIdOrder.length > maximumRememberedMeetingPacketIds) {
    const evicted = state.packetIdOrder.shift();
    if (evicted !== undefined) {
      state.packetIds.delete(evicted);
    }
  }
}

function packetIdentity(packet: VoicePacketBatch["packets"][number]): string {
  return [
    packet.recordingId,
    packet.speakerId,
    packet.rtpTimestamp,
    packet.rtpSequence,
    packet.relativeTimeMs,
  ].join(":");
}

function stableTurnId(event: VoicetextLiveTranscriptEvent): string {
  const digest = createHash("sha256")
    .update(
      [
        event.meetingId,
        event.speakerId,
        event.startMs,
        event.endMs,
        event.text,
      ].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return `live-turn:v1:${digest}`;
}
