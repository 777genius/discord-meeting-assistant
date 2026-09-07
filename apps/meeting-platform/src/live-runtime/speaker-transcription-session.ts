import { LiveTranscriptionAdmissionRejected } from "./contracts.js";
import { superviseLiveWork, LiveSessionAdmission, GlobalPacketFlowControl, SourceTimelinePacer, SpeakerPacketFlowControl } from "./live-packet-flow-control.js";
import type { LivePacketInspector, LiveRuntimeClock, LiveRuntimeLogger, LiveRuntimeTimer, LiveRuntimeTimerHandle, LiveTranscriptionEvent, LiveTranscriptionPort, LiveVoicePacket } from "./contracts.js";
import { LivePacketDeliveryLedger, livePacketIdentity } from "./packet-delivery-ledger.js";
import { SpeakerTranscriptionProviderSession } from "./speaker-transcription-provider-session.js";

const maximumLivePacketDeliveryAttempts = 2;
// Independent from admission pressure; exceeds the current provider's 30s allowance.
const providerFinalizeTimeoutMs = 35_000;
const maximumDrainPacingWaitMs = 30_000;

export interface SpeakerTranscriptionSessionDependencies {
  readonly admissionRejection?: AbortController;
  readonly clock: LiveRuntimeClock;
  readonly isMeetingFinishing: () => boolean;
  readonly ledger: LivePacketDeliveryLedger;
  readonly logger: LiveRuntimeLogger;
  readonly markLivePacketDelivered?: (packetId: string) => Promise<void>;
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
  private admissionClosed = false;
  private finishing: Promise<void> | null = null;
  private deliveryDeadlineMs = 0;
  private readonly admissionRejection: AbortController;
  private deliveryFailed = false;
  private recoveryBlocked = false;
  private recovery: Promise<void> | null = null;
  private backpressureDegraded = false;
  private chain: Promise<void> = Promise.resolve();
  private inactivityTimer: LiveRuntimeTimerHandle | null = null;
  private lastRelativeTimeMs: number | null = null;
  private readonly packetFlow: SpeakerPacketFlowControl;
  private readonly pacer: SourceTimelinePacer;
  private readonly providerSession: SpeakerTranscriptionProviderSession;

  public constructor(private readonly dependencies: SpeakerTranscriptionSessionDependencies) {
    this.admissionRejection = dependencies.admissionRejection ?? new AbortController();
    this.packetFlow = new SpeakerPacketFlowControl(
      dependencies.maximumQueuedPackets,
      dependencies.clock,
      dependencies.timer,
    );
    this.pacer = new SourceTimelinePacer(dependencies.clock, dependencies.timer);
    this.providerSession = new SpeakerTranscriptionProviderSession({
      logger: dependencies.logger, meetingId: dependencies.meetingId,
      onTranscript: dependencies.onTranscript,
      sessionAdmission: dependencies.sessionAdmission,
      speakerId: dependencies.speakerId, transcriber: dependencies.transcriber,
    });
    // One permanent fence cancels reservations and openings in every generation.
    this.admissionRejection.signal.addEventListener("abort", this.onAdmissionRejected, { once: true });
    if (this.isAdmissionRejected()) { this.onAdmissionRejected(); }
  }

  private readonly onAdmissionRejected = (): void => { this.cancelIdleFinalization(); this.cancelDelivery(); };
  private isAdmissionRejected(): boolean { return this.admissionRejection.signal.aborted; }

  public async accept(packets: readonly LiveVoicePacket[], deadlineMs: number): Promise<void> {
    if (this.admissionClosed || this.recoveryBlocked || this.isAdmissionRejected()) {return;}
    // Keep one global slot available for the recovery that deferred live work awaits.
    const recoveryHeadroom = this.recovery === null ? 0 : 1;
    const globallyReserved = await this.dependencies.packetAdmission.reserve(
      packets.length + recoveryHeadroom,
      deadlineMs,
      this.packetFlow.signal,
    );
    if (!globallyReserved) {
      if (!this.dependencies.isMeetingFinishing()) {
        this.noteDegradation("LIVE_PACKET_GLOBAL_BACKLOG_FULL");
      }
      return;
    }
    if (this.isAdmissionClosed()) {
      this.dependencies.packetAdmission.release(packets.length + recoveryHeadroom);
      return;
    }
    if (recoveryHeadroom > 0) { this.dependencies.packetAdmission.release(recoveryHeadroom); }
    if (!this.packetFlow.tryReserveAdmission(packets.length)) {
      this.dependencies.packetAdmission.release(packets.length);
      this.noteDegradation("LIVE_PACKET_ADMISSION_BACKLOG_FULL");
      return;
    }
    const recovery = this.recovery;
    const admission = async (): Promise<void> => {
      try {
        if (recovery !== null) { await this.untilCancelled(recovery); }
        for (const packet of packets) {
          await this.admit(packet, deadlineMs);
        }
      } finally {
        this.packetFlow.releaseAdmission(packets.length);
      }
    };
    const completion = this.admissionChain.then(admission, admission);
    this.admissionChain = completion.catch(() => {});
    if (recovery === null) { await completion; }
  }

  /** Single-packet batches preserve order even across delivery failure/restart. */
  public recover(packets: readonly LiveVoicePacket[]): Promise<void> {
    if (this.recovery !== null) { return this.recovery; }
    const recovery = this.drainRecovery(packets).finally(() => {
      if (this.recovery === recovery) { this.recovery = null; }
    });
    this.recovery = recovery;
    return recovery;
  }

  public cancelRecovery(): boolean {
    if (this.recovery === null) { return false; }
    this.cancelDelivery();
    return true;
  }

  private cancelDelivery(): void {
    this.admissionClosed = true;
    this.admissionRejection.signal.removeEventListener("abort", this.onAdmissionRejected);
    this.packetFlow.cancel();
    this.providerSession.abortOpening();
    this.providerSession.terminate();
  }

  private async untilCancelled(work: Promise<void>): Promise<void> {
    const signal = this.packetFlow.signal;
    let onAbort!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) { resolve(); }
    });
    try { await Promise.race([work, cancelled]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  private isAdmissionClosed(): boolean { return this.admissionClosed || this.isAdmissionRejected(); }

  private hasDeliveryFailed(): boolean { return this.deliveryFailed; }

  private isDeliveryCancelled(): boolean { return this.packetFlow.signal.aborted; }

  private isPacketDeliveryBlocked(): boolean { return this.isDeliveryCancelled() || this.recoveryBlocked || this.isAdmissionRejected(); }

  private async drainRecovery(packets: readonly LiveVoicePacket[]): Promise<void> {
    this.recoveryBlocked = false;
    for (const packet of packets) {
      if (this.isAdmissionClosed()) { return; }
      await this.untilCancelled(this.chain);
      this.deliveryFailed = false;
      if (this.isAdmissionClosed()) { return; }
      const deadline = this.dependencies.clock.nowMilliseconds() + this.dependencies.packetBackpressureTimeoutMs;
      if (!await this.dependencies.packetAdmission.reserve(1, deadline, this.packetFlow.signal)) {
        this.recoveryBlocked = true;
        return;
      }
      await this.admit(packet, deadline);
      await this.untilCancelled(this.chain);
      // Do not let a failed send/ack or admission timeout advance the backlog.
      if (this.hasDeliveryFailed() || !this.dependencies.ledger.isDelivered(livePacketIdentity(packet))) {
        this.recoveryBlocked = true;
        return;
      }
    }
  }

  public beginFinish(): void {
    this.cancelIdleFinalization();
    this.admissionClosed = true;
    this.packetFlow.wakeAdmissionWaiters();
    this.cancelRecovery();
  }

  public finish(): Promise<void> {
    this.beginFinish();
    this.finishing ??= this.finishAdmittedPackets();
    return this.finishing;
  }

  private async finishAdmittedPackets(): Promise<void> {
    await this.supervise(this.admissionChain, this.dependencies.packetBackpressureTimeoutMs);
    const stallMs = this.dependencies.packetBackpressureTimeoutMs;
    this.deliveryDeadlineMs = Math.max(this.deliveryDeadlineMs, this.dependencies.clock.nowMilliseconds() + stallMs);
    await this.supervise(this.chain, stallMs, () => this.deliveryDeadlineMs);
    if (!this.isDeliveryCancelled()) { await this.finalize("Derived live speaker finalize failed"); }
  }

  private supervise(work: Promise<void>, budgetMs: number, deadline?: () => number): Promise<void> {
    return superviseLiveWork(this.untilCancelled(work), budgetMs, this.dependencies.timer,
      { clock: this.dependencies.clock, cancel: () => { this.cancelDelivery(); }, deadline });
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

  private async reservePacketSlot(packet: LiveVoicePacket, deadlineMs: number): Promise<boolean> {
    if (this.isPacketDeliveryBlocked() || this.isSuppressed(packet)) { return false; }
    const hasCapacity = await this.packetFlow.waitForQueueSlot(deadlineMs, () => this.isAdmissionClosed() || this.dependencies.isMeetingFinishing());
    if (!hasCapacity) {
      if (!this.dependencies.isMeetingFinishing()) {
        this.noteDegradation("LIVE_PACKET_BACKPRESSURE_TIMEOUT");
      }
      return false;
    }
    if (this.isPacketDeliveryBlocked() || this.isSuppressed(packet)) { return false; }
    this.cancelIdleFinalization();
    this.packetFlow.reserveQueueSlot();
    const delivery = async (): Promise<void> => {
      try {
        const pacingMs = this.pacer.packetWaitMs(this.dependencies.startedAtMs, packet.relativeTimeMs);
        this.deliveryDeadlineMs = this.dependencies.clock.nowMilliseconds()
          + Math.min(pacingMs, maximumDrainPacingWaitMs) + this.dependencies.packetBackpressureTimeoutMs;
        await this.untilCancelled(this.send(packet));
      } catch (error) {
        this.deliveryFailed = true;
        this.providerSession.terminate();
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
    if (this.isAdmissionRejected() || this.isSuppressed(packet, packetId)) { return; }
    const opus = Buffer.from(packet.payloadBase64, "base64");
    const durationSamples48Khz = this.dependencies.packetInspector
      .durationSamples48Khz(opus);
    const earliestPacketAtMs = await this.pacer.waitForPacketTime(
      this.dependencies.startedAtMs,
      packet.relativeTimeMs,
      this.packetFlow.signal,
    );
    if (earliestPacketAtMs === null) { return; }
    await this.sendWithBoundedRetry({
      durationSamples48Khz,
      earliestPacketAtMs,
      opus,
      packet,
      packetId,
    });
  }

  private async sendWithBoundedRetry(input: {
    readonly durationSamples48Khz: number; readonly earliestPacketAtMs: number;
    readonly opus: Uint8Array; readonly packet: LiveVoicePacket; readonly packetId: string;
  }): Promise<void> {
    for (let attempt = 1; attempt <= maximumLivePacketDeliveryAttempts; attempt += 1) {
      if (this.isAdmissionRejected()) { return; }
      let sendStartedAtMs: number;
      try {
        const session = await this.providerSession.open(this.packetFlow.signal);
        if (session === null || this.isDeliveryCancelled() || this.isAdmissionRejected()) { return; }
        sendStartedAtMs = this.dependencies.clock.nowMilliseconds();
        await session.sendPacket({
          durationSamples48Khz: input.durationSamples48Khz,
          opus: input.opus,
          packetId: input.packetId,
          relativeTimeMs: input.packet.relativeTimeMs,
        });
      } catch (error) {
        this.providerSession.terminate();
        if (error instanceof LiveTranscriptionAdmissionRejected) {
          if (!this.isAdmissionRejected()) {
            this.admissionRejection.abort();
            this.dependencies.logger.warn("Derived live transcription degraded: configuration admission rejected", {
              ...this.logFields(), errorCode: "LIVE_TRANSCRIPTION_ADMISSION_REJECTED",
            });
          }
          return;
        }
        if (this.isDeliveryCancelled()) { return; }
        if (attempt === maximumLivePacketDeliveryAttempts) {
          this.rememberRetryablePacket(input.packet, input.packetId);
          throw error;
        }
        continue;
      }
      if (this.isDeliveryCancelled()) { return; }
      // A durable acknowledgement failure must not repeat the provider send.
      await this.commitDelivery(input, sendStartedAtMs);
      return;
    }
  }

  private async commitDelivery(
    input: {
      readonly durationSamples48Khz: number; readonly earliestPacketAtMs: number;
      readonly packet: LiveVoicePacket; readonly packetId: string;
    },
    sendStartedAtMs: number,
  ): Promise<void> {
    this.pacer.recordPacketSent(
      input.earliestPacketAtMs,
      input.durationSamples48Khz,
      sendStartedAtMs,
    );
    const recovered = this.dependencies.ledger.markDelivered(input.packetId);
    this.lastRelativeTimeMs = Math.max(this.lastRelativeTimeMs ?? input.packet.relativeTimeMs, input.packet.relativeTimeMs);
    if (recovered) {
      this.dependencies.logger.info("Derived live transcription packet recovered after delivery failure", this.logFields());
    }
    if (this.backpressureDegraded) {
      this.backpressureDegraded = false;
      this.dependencies.logger.info("Derived live transcription recovered from backpressure", this.logFields());
    }
    await this.dependencies.markLivePacketDelivered?.(input.packetId);
  }

  private isSuppressed(packet: LiveVoicePacket, packetId?: string): boolean {
    const identity = packetId ?? livePacketIdentity(packet);
    if (this.dependencies.ledger.isDelivered(identity)) { return true; }
    if (this.dependencies.ledger.isRetryable(identity)) { return false; }
    if (this.lastRelativeTimeMs === null || packet.relativeTimeMs >= this.lastRelativeTimeMs) { return false; }
    this.dependencies.logger.warn("Out-of-order live packet skipped", this.logFields());
    return true;
  }

  private async finalize(failureMessage: string): Promise<void> {
    this.deliveryDeadlineMs = this.dependencies.clock.nowMilliseconds() + providerFinalizeTimeoutMs;
    await this.supervise(this.providerSession.finalize(failureMessage), providerFinalizeTimeoutMs);
  }

  private scheduleIdleFinalizationIfReady(): void {
    if (
      this.admissionClosed ||
      this.packetFlow.queuedPacketCount !== 0 ||
      !this.providerSession.isOpen ||
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
          if (this.shouldSkipIdleFinalization()) { return; }
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
      !this.providerSession.isOpen
    );
  }

  private cancelIdleFinalization(): void {
    if (this.inactivityTimer !== null) { this.dependencies.timer.cancel(this.inactivityTimer); }
    this.inactivityTimer = null;
  }

  private rememberRetryablePacket(packet: LiveVoicePacket, packetId: string): void {
    if (!this.dependencies.ledger.markRetryable(packetId)) { return; }
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
    if (this.backpressureDegraded) { return; }
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
      ...this.logFields(), errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  private logPacketFailure(error: unknown): void {
    if (this.dependencies.isMeetingFinishing() || this.packetFlow.signal.aborted) { return; }
    this.dependencies.logger.warn("Derived live transcription packet failed", {
      ...this.logFields(), errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }

  private logFields(): Readonly<Record<string, unknown>> {
    return { meetingId: this.dependencies.meetingId, speakerId: this.dependencies.speakerId };
  }
}
