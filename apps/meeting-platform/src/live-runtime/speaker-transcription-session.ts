import type { SpeakerTranscriptionSessionDependencies } from "./speaker-transcription-sessions.js";
export type { SpeakerTranscriptionSessionDependencies } from "./speaker-transcription-sessions.js";
import { LiveSttAttemptController, awaitLiveCancellation } from "./live-stt-attempt-controller.js";
import { superviseLiveWork, SourceTimelinePacer, SpeakerPacketFlowControl } from "./live-packet-flow-control.js";
import {
  LiveTranscriptionNotAccepted, LiveTranscriptionAcceptanceUnknown,
  LiveTranscriptionTerminalFailure, LiveTranscriptionAdmissionRejected,
  type LiveRuntimeTimerHandle, type LiveVoicePacket,
} from "./contracts.js";
import { livePacketIdentity } from "./packet-delivery-ledger.js";
import { SpeakerTranscriptionProviderSession } from "./speaker-transcription-provider-session.js";

const maximumLivePacketDeliveryAttempts = 2;
// Independent from admission pressure; exceeds the current provider's 30s allowance.
const providerFinalizeTimeoutMs = 35_000;
const maximumDrainPacingWaitMs = 30_000;

/** Owns one speaker's provider session and its bounded packet delivery. */
export class SpeakerTranscriptionSession {
  private admissionChain: Promise<void> = Promise.resolve();
  private admissionClosed = false;
  private finishing: Promise<void> | null = null;
  private settling: Promise<void> | null = null;
  private terminalFailure: LiveTranscriptionTerminalFailure | LiveTranscriptionAcceptanceUnknown | null = null;
  private readonly reportedFailures = new Set<string>();
  private providerFinalization: Promise<void> | null = null;
  private deliveryBudgetMs = 0;
  private pendingReceipt = false;
  private providerSendPending = false;
  private readonly deliveryWatchdogs = new Set<(budgetMs: number) => void>();
  private readonly admissionCancellation = new AbortController();
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
  private readonly durableAttempts: LiveSttAttemptController | undefined;
  private readonly providerSession: SpeakerTranscriptionProviderSession;

  public constructor(private readonly dependencies: SpeakerTranscriptionSessionDependencies) {
    this.admissionRejection = dependencies.admissionRejection ?? new AbortController();
    this.packetFlow = new SpeakerPacketFlowControl(dependencies.maximumQueuedPackets, dependencies.clock, dependencies.timer);
    this.pacer = new SourceTimelinePacer(dependencies.clock, dependencies.timer);
    this.durableAttempts = dependencies.liveSttDurability === undefined ? undefined : new LiveSttAttemptController({
      durability: dependencies.liveSttDurability, onFailure: (error) => this.latchFailure(error),
      signal: this.packetFlow.signal, transcriber: dependencies.transcriber,
    });
    this.providerSession = new SpeakerTranscriptionProviderSession({
      logger: dependencies.logger, meetingId: dependencies.meetingId,
      onFailure: (error) => this.latchFailure(error),
      onTranscript: (event) => { if (!this.isDeliveryCancelled()) { dependencies.onTranscript(event); } },
      sessionAdmission: dependencies.sessionAdmission,
      speakerId: dependencies.speakerId, transcriber: this.durableAttempts ?? dependencies.transcriber,
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
      packets.length + recoveryHeadroom, deadlineMs, this.admissionCancellation.signal,
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
        for (const packet of packets) { await this.admit(packet, deadlineMs); }
      } finally {
        this.packetFlow.releaseAdmission(packets.length);
        this.scheduleIdleFinalizationIfReady();
      }
    };
    const completion = this.admissionChain.then(admission, admission);
    this.admissionChain = completion.catch(() => {});
    if (recovery === null) { await completion; }
  }

  /** Single-packet batches preserve order even across delivery failure/restart. */
  public recover(packets: readonly LiveVoicePacket[]): Promise<void> {
    return this.recovery ??= this.drainRecovery(packets).finally(() => {
      this.recovery = null;
    });
  }

  public cancelRecovery(): boolean {
    if (this.recovery === null) { return false; }
    this.cancelDelivery();
    return true;
  }

  private cancelDelivery(): void {
    if (this.providerSendPending) {
      this.latchFailure(new LiveTranscriptionAcceptanceUnknown());
    }
    this.admissionClosed = true; this.admissionCancellation.abort();
    this.admissionRejection.signal.removeEventListener("abort", this.onAdmissionRejected);
    this.packetFlow.cancel();
    this.providerSession.abortOpening(); this.providerSession.terminate();
  }

  private untilCancelled(work: Promise<void>): Promise<void> {
    return awaitLiveCancellation(work, this.packetFlow.signal);
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
      if (!await this.dependencies.packetAdmission.reserve(1, deadline, this.admissionCancellation.signal)) {
        this.recoveryBlocked = true;
        return;
      }
      await this.admit(packet, deadline);
      await (this.dependencies.liveSttDurability !== undefined && this.dependencies.isMeetingFinishing()
        ? this.drainPending(this.chain) : this.untilCancelled(this.chain));
      // Do not let a failed send/ack or admission timeout advance the backlog.
      if (this.hasDeliveryFailed() || !this.dependencies.ledger.isDelivered(livePacketIdentity(packet))) {
        this.recoveryBlocked = true;
        return;
      }
    }
  }

  public drainPending(work = this.recovery ?? this.chain): Promise<void> {
    return this.supervise(work, Math.max(this.deliveryBudgetMs, this.dependencies.packetBackpressureTimeoutMs), true);
  }

  public beginFinish(): void {
    this.cancelIdleFinalization(); this.admissionClosed = true;
    this.admissionCancellation.abort();
    this.packetFlow.wakeAdmissionWaiters();
    this.cancelRecovery();
  }

  public finish(): Promise<void> {
    this.beginFinish();
    if (this.finishing === null) {
      const finishing = this.settle().then(() => {
        if (this.hasTerminalFence()) { throw this.terminalFailure ?? this.admissionRejection.signal.reason; }
        return;
      }).catch((error: unknown) => {
        // Retry settlement after a pending receipt completes; admission stays closed.
        if (this.finishing === finishing) { this.finishing = null; }
        throw error;
      });
      this.finishing = finishing;
    }
    return this.finishing;
  }

  /** Ownership barrier only: a fenced, terminated live path is not successful speech. */
  public settle(): Promise<void> {
    this.beginFinish();
    this.settling ??= this.finishAdmittedPackets().catch((error: unknown) => {
      this.settling = null;
      throw error;
    });
    return this.settling;
  }

  private async finishAdmittedPackets(): Promise<void> {
    await this.supervise(this.admissionChain, Math.max(this.deliveryBudgetMs, this.dependencies.packetBackpressureTimeoutMs), true);
    // Idle finalization owns its original provider timer, including while joined.
    if (this.providerFinalization !== null) { await this.providerFinalization; }
    await this.supervise(this.chain, Math.max(this.deliveryBudgetMs, this.dependencies.packetBackpressureTimeoutMs), true);
    if (!this.isDeliveryCancelled()) { await this.finalize("Derived live speaker finalize failed"); }
    await this.durableAttempts?.settle();
    if (this.pendingReceipt) { throw new Error("Live packet durable receipt is still pending"); }
    if (this.providerSendPending && this.durableAttempts === undefined) { throw new LiveTranscriptionAcceptanceUnknown(); }
  }

  private supervise(work: Promise<void>, budgetMs: number, renewOnDelivery = false): Promise<void> {
    // Admission and finish may watch different snapshots of the delivery chain.
    // Each supervisor owns its renewal registration and removes only that entry.
    let ownedRenewal: ((budgetMs: number) => void) | undefined;
    return superviseLiveWork(this.untilCancelled(work), budgetMs, this.dependencies.timer,
      { cancel: () => { this.cancelDelivery(); },
        ...(renewOnDelivery ? { setRenewal: (renew: ((budgetMs: number) => void) | undefined) => {
          if (ownedRenewal !== undefined) { this.deliveryWatchdogs.delete(ownedRenewal); }
          ownedRenewal = renew;
          if (renew !== undefined) { this.deliveryWatchdogs.add(renew); }
        } } : {}) });
  }

  private renewDeliveryWatchdogs(budgetMs: number): void {
    for (const renew of this.deliveryWatchdogs) { renew(budgetMs); }
  }

  private async admit(packet: LiveVoicePacket, deadlineMs: number): Promise<void> {
    let deliveryOwnsReservation = false;
    try {
      deliveryOwnsReservation = await this.reservePacketSlot(packet, deadlineMs);
    } catch (error) {
      this.failDurableAdmission();
      this.logAdmissionFailure(error);
    } finally {
      if (!deliveryOwnsReservation) { this.dependencies.packetAdmission.release(1); }
    }
  }

  private async reservePacketSlot(packet: LiveVoicePacket, deadlineMs: number): Promise<boolean> {
    // These packets already hold bounded global and speaker admission reservations.
    // A batch deadline limits ingress waiting, not ownership of durable pending audio.
    const admissionStopped = (): boolean => this.isPacketDeliveryBlocked() ||
      (!this.hasDurablePackets() &&
        (this.isAdmissionClosed() || this.dependencies.isMeetingFinishing()));
    if (admissionStopped() || this.isSuppressed(packet)) { return false; }
    const hasCapacity = await this.packetFlow.waitForQueueSlot(deadlineMs, admissionStopped);
    if (!hasCapacity) {
      if (!this.dependencies.isMeetingFinishing()) {
        this.noteDegradation("LIVE_PACKET_BACKPRESSURE_TIMEOUT");
      }
      if (!this.hasDurablePackets() || admissionStopped()) { return false; }
      // Keep the reservation and source order while the already scheduled delivery
      // drains. Only actual delivery progress renews this existing bounded watchdog.
      await this.supervise(this.chain, Math.max(this.deliveryBudgetMs, this.dependencies.packetBackpressureTimeoutMs), true);
      if (admissionStopped()) { this.failDurableAdmission(); return false; }
    }
    if (admissionStopped() || this.isSuppressed(packet)) { return false; }
    this.cancelIdleFinalization();
    this.packetFlow.reserveQueueSlot();
    const delivery = async (): Promise<void> => {
      try {
        const pacingMs = this.pacer.packetWaitMs(this.dependencies.startedAtMs, packet.relativeTimeMs);
        this.deliveryBudgetMs = Math.min(pacingMs, maximumDrainPacingWaitMs) + this.dependencies.packetBackpressureTimeoutMs;
        this.renewDeliveryWatchdogs(this.deliveryBudgetMs);
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
    const durationSamples48Khz = this.dependencies.packetInspector.durationSamples48Khz(opus);
    const earliestPacketAtMs = await this.pacer.waitForPacketTime(
      this.dependencies.startedAtMs, packet.relativeTimeMs, this.packetFlow.signal,
    );
    if (earliestPacketAtMs === null) { return; }
    await this.sendWithBoundedRetry({ durationSamples48Khz, earliestPacketAtMs, opus, packet, packetId });
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
        this.providerSendPending = true;
        await session.sendPacket({
          durationSamples48Khz: input.durationSamples48Khz,
          opus: input.opus,
          packetId: input.packetId,
          relativeTimeMs: input.packet.relativeTimeMs,
        });
      } catch (error) {
        this.providerSendPending = false;
        if (this.latchFailure(error)) { return; }
        if (!(error instanceof LiveTranscriptionNotAccepted)) {
          this.latchFailure(new LiveTranscriptionAcceptanceUnknown());
          return;
        }
        this.providerSession.terminate();
        if (this.isDeliveryCancelled()) { return; }
        if (attempt === maximumLivePacketDeliveryAttempts) {
          this.rememberRetryablePacket(input.packet, input.packetId);
          throw error;
        }
        continue;
      } finally {
        this.providerSendPending = false;
      }
      if (this.isDeliveryCancelled() && !this.hasTerminalFence()) { return; }
      // A durable acknowledgement failure must not repeat the provider send.
      await this.commitDelivery(input, sendStartedAtMs);
      return;
    }
  }

  private hasTerminalFence(): boolean {
    return this.terminalFailure !== null || this.admissionRejection.signal.reason instanceof LiveTranscriptionTerminalFailure ||
      this.admissionRejection.signal.reason instanceof LiveTranscriptionAcceptanceUnknown;
  }

  private latchFailure(error: unknown): boolean {
    if (!(error instanceof LiveTranscriptionAdmissionRejected) &&
        !(error instanceof LiveTranscriptionTerminalFailure) &&
        !(error instanceof LiveTranscriptionAcceptanceUnknown)) { return false; }
    if (error instanceof LiveTranscriptionTerminalFailure || error instanceof LiveTranscriptionAcceptanceUnknown) {
      this.terminalFailure = error; this.finishing = null;
    }
    // Abort is immutable: retain and diagnose late evidence even after shutdown cancellation.
    this.admissionRejection.abort(error);
    const errorCode = error instanceof LiveTranscriptionAdmissionRejected
      ? "LIVE_TRANSCRIPTION_ADMISSION_REJECTED"
      : error instanceof LiveTranscriptionTerminalFailure
        ? "LIVE_TRANSCRIPTION_PROVIDER_TERMINAL" : "LIVE_TRANSCRIPTION_ACCEPTANCE_UNKNOWN";
    if (!this.reportedFailures.has(errorCode)) {
      this.reportedFailures.add(errorCode);
      this.dependencies.logger.warn("Derived live transcription degraded: lifecycle fenced", { ...this.logFields(), errorCode });
    }
    return true;
  }

  private async commitDelivery(
    input: {
      readonly durationSamples48Khz: number; readonly earliestPacketAtMs: number;
      readonly packet: LiveVoicePacket; readonly packetId: string;
    },
    sendStartedAtMs: number,
  ): Promise<void> {
    this.pacer.recordPacketSent(input.earliestPacketAtMs, input.durationSamples48Khz, sendStartedAtMs);
    this.pendingReceipt = true;
    try { await this.dependencies.markLivePacketDelivered?.(input.packetId); }
    catch (error) { this.latchFailure(new LiveTranscriptionAcceptanceUnknown()); throw error; }
    finally { this.pendingReceipt = false; }
    const recovered = this.dependencies.ledger.markDelivered(input.packetId);
    this.lastRelativeTimeMs = Math.max(this.lastRelativeTimeMs ?? input.packet.relativeTimeMs, input.packet.relativeTimeMs);
    if (recovered) {
      this.dependencies.logger.info("Derived live transcription packet recovered after delivery failure", this.logFields());
    }
    if (this.backpressureDegraded) {
      this.backpressureDegraded = false;
      this.dependencies.logger.info("Derived live transcription recovered from backpressure", this.logFields());
    }
  }

  private isSuppressed(packet: LiveVoicePacket, identity = livePacketIdentity(packet)): boolean {
    if (this.dependencies.ledger.isDelivered(identity)) { return true; }
    if (this.dependencies.ledger.isRetryable(identity)) { return false; }
    if (this.lastRelativeTimeMs === null || packet.relativeTimeMs >= this.lastRelativeTimeMs) { return false; }
    this.dependencies.logger.warn("Out-of-order live packet skipped", this.logFields());
    return true;
  }

  private finalize(failureMessage: string): Promise<void> {
    this.renewDeliveryWatchdogs(providerFinalizeTimeoutMs);
    this.providerFinalization ??= this.supervise(this.providerSession.finalize(failureMessage), providerFinalizeTimeoutMs)
      .finally(() => { this.providerFinalization = null; });
    return this.providerFinalization;
  }

  private scheduleIdleFinalizationIfReady(): void {
    if (this.admissionClosed || this.shouldSkipIdleFinalization()) { return; }
    this.cancelIdleFinalization();
    this.inactivityTimer = this.dependencies.timer.schedule(this.dependencies.speakerIdleFinalizeMs, () => {
      this.inactivityTimer = null;
      const finalize = async (): Promise<void> => {
        if (this.shouldSkipIdleFinalization()) { return; }
        await this.finalize("Derived live idle speaker finalize failed");
      };
      this.chain = this.chain.then(finalize, finalize);
    });
  }

  private shouldSkipIdleFinalization(): boolean {
    return this.dependencies.isMeetingFinishing() || this.packetFlow.queuedPacketCount > 0 || this.packetFlow.pendingAdmissionPacketCount > 0 || !this.providerSession.isOpen;
  }

  private cancelIdleFinalization(): void {
    if (this.inactivityTimer !== null) { this.dependencies.timer.cancel(this.inactivityTimer); }
    this.inactivityTimer = null;
  }

  private rememberRetryablePacket(packet: LiveVoicePacket, packetId: string): void {
    if (!this.dependencies.ledger.markRetryable(packetId)) { return; }
    this.dependencies.logger.warn("Derived live transcription packet exhausted bounded delivery retries", {
      ...this.logFields(), errorCode: "LIVE_PACKET_DELIVERY_RETRY_EXHAUSTED", relativeTimeMs: packet.relativeTimeMs,
    });
  }

  private hasDurablePackets(): boolean { return this.dependencies.liveSttDurability !== undefined || this.dependencies.markLivePacketDelivered !== undefined; }

  private failDurableAdmission(): void {
    if (this.hasDurablePackets() && !this.hasTerminalFence()) { this.latchFailure(new LiveTranscriptionTerminalFailure()); }
  }

  private noteDegradation(errorCode: "LIVE_PACKET_ADMISSION_BACKLOG_FULL" | "LIVE_PACKET_GLOBAL_BACKLOG_FULL" | "LIVE_PACKET_BACKPRESSURE_TIMEOUT"): void {
    if (this.backpressureDegraded) { return; }
    this.backpressureDegraded = true;
    this.dependencies.logger.warn("Derived live transcription degraded after packet backpressure", {
      ...this.logFields(), errorCode,
      maximumQueuedPacketsPerSpeaker: this.packetFlow.maximumQueuedPackets,
      maximumQueuedPacketsGlobally: this.dependencies.packetAdmission.maximumPackets,
      packetBackpressureTimeoutMs: this.dependencies.packetBackpressureTimeoutMs,
      pendingAdmissionPackets: this.packetFlow.pendingAdmissionPacketCount,
      queuedPackets: this.packetFlow.queuedPacketCount,
    });
  }

  private logAdmissionFailure(error: unknown): void {
    this.dependencies.logger.warn("Derived live packet admission failed", { ...this.logFields(), errorName: error instanceof Error ? error.name : "UnknownError" });
  }

  private logPacketFailure(error: unknown): void {
    if (this.dependencies.isMeetingFinishing() || this.packetFlow.signal.aborted) { return; }
    this.dependencies.logger.warn("Derived live transcription packet failed", { ...this.logFields(), errorName: error instanceof Error ? error.name : "UnknownError" });
  }

  private logFields(): Readonly<Record<string, unknown>> { return { meetingId: this.dependencies.meetingId, speakerId: this.dependencies.speakerId }; }
}
