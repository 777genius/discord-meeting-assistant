import {
  LiveSessionAdmission,
  GlobalPacketFlowControl,
  SourceTimelinePacer,
  SpeakerPacketFlowControl,
  type LiveSessionRelease,
} from "./live-packet-flow-control.js";

import type {
  LivePacketInspector,
  LiveRuntimeClock,
  LiveRuntimeLogger,
  LiveRuntimeTimer,
  LiveRuntimeTimerHandle,
  LiveTranscriptionEvent,
  LiveTranscriptionPort,
  LiveTranscriptionSession,
  LiveVoicePacket,
} from "./contracts.js";
import {
  LivePacketDeliveryLedger,
  livePacketIdentity,
} from "./packet-delivery-ledger.js";

const maximumLivePacketDeliveryAttempts = 2;

export interface SpeakerTranscriptionSessionDependencies {
  readonly clock: LiveRuntimeClock;
  readonly isMeetingFinishing: () => boolean;
  readonly ledger: LivePacketDeliveryLedger;
  readonly logger: LiveRuntimeLogger;
  readonly maximumQueuedPackets: number;
  readonly meetingId: string;
  readonly onTranscript: (event: LiveTranscriptionEvent) => void;
  readonly packetAdmission: GlobalPacketFlowControl;
  readonly packetBackpressureTimeoutMs: number;
  readonly packetInspector: LivePacketInspector;
  readonly sessionAdmission: LiveSessionAdmission;
  readonly speakerId: string;
  readonly speakerIdleFinalizeMs: number;
  readonly startedAtMs: number;
  readonly timer: LiveRuntimeTimer;
  readonly transcriber: LiveTranscriptionPort;
}

/** Owns one speaker's provider session and its bounded packet delivery. */
export class SpeakerTranscriptionSession {
  private admissionChain: Promise<void> = Promise.resolve();
  private backpressureDegraded = false;
  private chain: Promise<void> = Promise.resolve();
  private inactivityTimer: LiveRuntimeTimerHandle | null = null;
  private lastRelativeTimeMs: number | null = null;
  private nextSegment = 1;
  private openingAbortController: AbortController | null = null;
  private readonly packetFlow: SpeakerPacketFlowControl;
  private readonly pacer: SourceTimelinePacer;
  private session: LiveTranscriptionSession | null = null;
  private sessionLease: LiveSessionRelease | null = null;

  public constructor(
    private readonly dependencies: SpeakerTranscriptionSessionDependencies,
  ) {
    this.packetFlow = new SpeakerPacketFlowControl(
      dependencies.maximumQueuedPackets,
      dependencies.clock,
      dependencies.timer,
    );
    this.pacer = new SourceTimelinePacer(dependencies.clock, dependencies.timer);
  }

  public async accept(
    packets: readonly LiveVoicePacket[],
    deadlineMs: number,
  ): Promise<void> {
    const globallyReserved = await this.dependencies.packetAdmission.reserve(
      packets.length,
      deadlineMs,
      this.packetFlow.signal,
    );
    if (!globallyReserved) {
      if (!this.dependencies.isMeetingFinishing()) {
        this.noteDegradation("LIVE_PACKET_GLOBAL_BACKLOG_FULL");
      }
      return;
    }
    if (!this.packetFlow.tryReserveAdmission(packets.length)) {
      this.dependencies.packetAdmission.release(packets.length);
      this.noteDegradation("LIVE_PACKET_ADMISSION_BACKLOG_FULL");
      return;
    }
    const admission = async (): Promise<void> => {
      try {
        for (const packet of packets) {
          await this.admit(packet, deadlineMs);
        }
      } finally {
        this.packetFlow.releaseAdmission(packets.length);
      }
    };
    const completion = this.admissionChain.then(admission, admission);
    this.admissionChain = completion.catch(() => {});
    await completion;
  }

  public beginFinish(): void {
    this.cancelIdleFinalization();
    this.packetFlow.cancel();
    this.openingAbortController?.abort();
  }

  public async finish(): Promise<void> {
    this.cancelIdleFinalization();
    await this.admissionChain.catch(() => {});
    await this.chain.catch(() => {});
    await this.finalize("Derived live speaker finalize failed");
  }

  private async admit(packet: LiveVoicePacket, deadlineMs: number): Promise<void> {
    let deliveryOwnsReservation = false;
    try {
      deliveryOwnsReservation = await this.reservePacketSlot(packet, deadlineMs);
    } catch (error) {
      this.logAdmissionFailure(error);
    } finally {
      if (!deliveryOwnsReservation) {
        this.dependencies.packetAdmission.release(1);
      }
    }
  }

  private async reservePacketSlot(
    packet: LiveVoicePacket,
    deadlineMs: number,
  ): Promise<boolean> {
    if (this.isSuppressed(packet)) {
      return false;
    }
    const hasCapacity = await this.packetFlow.waitForQueueSlot(
      deadlineMs,
      this.dependencies.isMeetingFinishing,
    );
    if (!hasCapacity) {
      if (!this.dependencies.isMeetingFinishing()) {
        this.noteDegradation("LIVE_PACKET_BACKPRESSURE_TIMEOUT");
      }
      return false;
    }
    if (this.isSuppressed(packet)) {
      return false;
    }
    this.cancelIdleFinalization();
    this.packetFlow.reserveQueueSlot();
    const delivery = async (): Promise<void> => {
      try {
        await this.send(packet);
      } catch (error) {
        this.terminateSession();
        this.logPacketFailure(error);
      } finally {
        this.packetFlow.releaseQueueSlot();
        this.dependencies.packetAdmission.release(1);
        this.scheduleIdleFinalizationIfReady();
      }
    };
    this.chain = this.chain.then(delivery, delivery);
    return true;
  }

  private async send(packet: LiveVoicePacket): Promise<void> {
    const packetId = livePacketIdentity(packet);
    if (this.isSuppressed(packet, packetId)) {
      return;
    }
    const opus = Buffer.from(packet.opusBase64, "base64");
    const durationSamples48Khz = this.dependencies.packetInspector
      .durationSamples48Khz(opus);
    const earliestPacketAtMs = await this.pacer.waitForPacketTime(
      this.dependencies.startedAtMs,
      packet.relativeTimeMs,
      this.packetFlow.signal,
    );
    if (earliestPacketAtMs === null) {
      return;
    }
    await this.sendWithBoundedRetry({
      durationSamples48Khz,
      earliestPacketAtMs,
      opus,
      packet,
      packetId,
    });
  }

  private async sendWithBoundedRetry(input: {
    readonly durationSamples48Khz: number;
    readonly earliestPacketAtMs: number;
    readonly opus: Uint8Array;
    readonly packet: LiveVoicePacket;
    readonly packetId: string;
  }): Promise<void> {
    for (let attempt = 1; attempt <= maximumLivePacketDeliveryAttempts; attempt += 1) {
      try {
        const session = await this.openSession();
        if (session === null || this.packetFlow.signal.aborted) {
          return;
        }
        const sendStartedAtMs = this.dependencies.clock.nowMilliseconds();
        await session.sendPacket({
          durationSamples48Khz: input.durationSamples48Khz,
          opus: input.opus,
          packetId: input.packetId,
          relativeTimeMs: input.packet.relativeTimeMs,
        });
        this.commitDelivery(input, sendStartedAtMs);
        return;
      } catch (error) {
        this.terminateSession();
        if (this.dependencies.isMeetingFinishing() || this.packetFlow.signal.aborted) {
          return;
        }
        if (attempt === maximumLivePacketDeliveryAttempts) {
          this.rememberRetryablePacket(input.packet, input.packetId);
          throw error;
        }
      }
    }
  }

  private commitDelivery(
    input: {
      readonly durationSamples48Khz: number;
      readonly earliestPacketAtMs: number;
      readonly packet: LiveVoicePacket;
      readonly packetId: string;
    },
    sendStartedAtMs: number,
  ): void {
    this.pacer.recordPacketSent(
      input.earliestPacketAtMs,
      input.durationSamples48Khz,
      sendStartedAtMs,
    );
    const recovered = this.dependencies.ledger.markDelivered(input.packetId);
    this.lastRelativeTimeMs = Math.max(
      this.lastRelativeTimeMs ?? input.packet.relativeTimeMs,
      input.packet.relativeTimeMs,
    );
    if (recovered) {
      this.dependencies.logger.info(
        "Derived live transcription packet recovered after delivery failure",
        this.logFields(),
      );
    }
    if (this.backpressureDegraded) {
      this.backpressureDegraded = false;
      this.dependencies.logger.info(
        "Derived live transcription recovered from backpressure",
        this.logFields(),
      );
    }
  }

  private isSuppressed(packet: LiveVoicePacket, packetId?: string): boolean {
    if (this.dependencies.isMeetingFinishing()) {
      return true;
    }
    const identity = packetId ?? livePacketIdentity(packet);
    if (this.dependencies.ledger.isDelivered(identity)) {
      return true;
    }
    if (this.dependencies.ledger.isRetryable(identity)) {
      return false;
    }
    if (
      this.lastRelativeTimeMs === null ||
      packet.relativeTimeMs >= this.lastRelativeTimeMs
    ) {
      return false;
    }
    this.dependencies.logger.warn("Out-of-order live packet skipped", this.logFields());
    return true;
  }

  private async openSession(): Promise<LiveTranscriptionSession | null> {
    if (this.session !== null) {
      return this.session;
    }
    const lease = await this.dependencies.sessionAdmission.acquire(
      this.packetFlow.signal,
    );
    if (lease === null) {
      return null;
    }
    this.sessionLease = lease;
    const openingAbortController = new AbortController();
    this.openingAbortController = openingAbortController;
    try {
      const segment = this.nextSegment;
      this.nextSegment += 1;
      const session = await this.dependencies.transcriber.openSession({
        idempotencyKey: [
          "live-transcription:v2",
          this.dependencies.meetingId,
          this.dependencies.speakerId,
          segment,
        ].join("|"),
        meetingId: this.dependencies.meetingId,
        onTranscript: this.dependencies.onTranscript,
        signal: openingAbortController.signal,
        speakerId: this.dependencies.speakerId,
      });
      if (openingAbortController.signal.aborted || this.sessionLease !== lease) {
        session.terminate();
        this.releaseLease(lease);
        return null;
      }
      this.session = session;
      return session;
    } catch (error) {
      this.releaseLease(lease);
      throw error;
    } finally {
      if (this.openingAbortController === openingAbortController) {
        this.openingAbortController = null;
      }
    }
  }

  private releaseLease(lease: LiveSessionRelease): void {
    if (this.sessionLease === lease) {
      this.sessionLease = null;
      lease();
    }
  }

  private terminateSession(): void {
    const session = this.session;
    const lease = this.sessionLease;
    this.session = null;
    this.sessionLease = null;
    session?.terminate();
    lease?.();
  }

  private async finalize(failureMessage: string): Promise<void> {
    const session = this.session;
    const lease = this.sessionLease;
    this.session = null;
    this.sessionLease = null;
    if (session === null) {
      lease?.();
      return;
    }
    try {
      await session.finalize();
    } catch (error) {
      session.terminate();
      this.dependencies.logger.warn(failureMessage, {
        ...this.logFields(),
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    } finally {
      lease?.();
    }
  }

  private scheduleIdleFinalizationIfReady(): void {
    if (
      this.packetFlow.queuedPacketCount !== 0 ||
      this.session === null ||
      this.dependencies.isMeetingFinishing()
    ) {
      return;
    }
    this.cancelIdleFinalization();
    this.inactivityTimer = this.dependencies.timer.schedule(
      this.dependencies.speakerIdleFinalizeMs,
      () => {
        this.inactivityTimer = null;
        const finalize = async (): Promise<void> => {
          if (this.shouldSkipIdleFinalization()) {
            return;
          }
          await this.finalize("Derived live idle speaker finalize failed");
        };
        this.chain = this.chain.then(finalize, finalize);
      },
    );
  }

  private shouldSkipIdleFinalization(): boolean {
    return (
      this.dependencies.isMeetingFinishing() ||
      this.packetFlow.queuedPacketCount > 0 ||
      this.session === null
    );
  }

  private cancelIdleFinalization(): void {
    if (this.inactivityTimer !== null) {
      this.dependencies.timer.cancel(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private rememberRetryablePacket(
    packet: LiveVoicePacket,
    packetId: string,
  ): void {
    if (!this.dependencies.ledger.markRetryable(packetId)) {
      return;
    }
    this.dependencies.logger.warn(
      "Derived live transcription packet exhausted bounded delivery retries",
      {
        ...this.logFields(),
        errorCode: "LIVE_PACKET_DELIVERY_RETRY_EXHAUSTED",
        relativeTimeMs: packet.relativeTimeMs,
      },
    );
  }

  private noteDegradation(
    errorCode:
      | "LIVE_PACKET_ADMISSION_BACKLOG_FULL"
      | "LIVE_PACKET_GLOBAL_BACKLOG_FULL"
      | "LIVE_PACKET_BACKPRESSURE_TIMEOUT",
  ): void {
    if (this.backpressureDegraded) {
      return;
    }
    this.backpressureDegraded = true;
    this.dependencies.logger.warn(
      "Derived live transcription degraded after packet backpressure",
      {
        ...this.logFields(),
        errorCode,
        maximumQueuedPacketsPerSpeaker: this.packetFlow.maximumQueuedPackets,
        maximumQueuedPacketsGlobally:
          this.dependencies.packetAdmission.maximumPackets,
        packetBackpressureTimeoutMs:
          this.dependencies.packetBackpressureTimeoutMs,
        pendingAdmissionPackets: this.packetFlow.pendingAdmissionPacketCount,
        queuedPackets: this.packetFlow.queuedPacketCount,
      },
    );
  }

  private logAdmissionFailure(error: unknown): void {
    this.dependencies.logger.warn("Derived live packet admission failed", {
      ...this.logFields(),
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  private logPacketFailure(error: unknown): void {
    if (this.dependencies.isMeetingFinishing() || this.packetFlow.signal.aborted) {
      return;
    }
    this.dependencies.logger.warn("Derived live transcription packet failed", {
      ...this.logFields(),
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  private logFields(): Readonly<Record<string, unknown>> {
    return {
      meetingId: this.dependencies.meetingId,
      speakerId: this.dependencies.speakerId,
    };
  }
}
