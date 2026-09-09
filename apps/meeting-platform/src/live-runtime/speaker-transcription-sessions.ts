import type { ActiveLiveMeeting } from "./live-meeting-state.js";
import type {
  GlobalPacketFlowControl,
  LiveSessionAdmission,
} from "./live-packet-flow-control.js";

import {
  LiveTranscriptionAcceptanceUnknown, LiveTranscriptionAdmissionRejected, LiveTranscriptionTerminalFailure,
  type LiveMeetingRuntimeDependencies, type LiveRuntimeTimerHandle, type LiveRecovery, type LiveSttDurabilityPort,
  type LivePacketInspector,
  type LiveRuntimeClock,
  type LiveRuntimeLogger,
  type LiveRuntimeTimer,
  type LiveTranscriptionEvent,
  type LiveTranscriptionPort,
  type LiveVoicePacket,
  type LiveVoicePacketBatch,
} from "./contracts.js";
import { livePacketIdentity, LivePacketDeliveryLedger } from "./packet-delivery-ledger.js";
import { SpeakerTranscriptionSession } from "./speaker-transcription-session.js";

export interface SpeakerTranscriptionSessionDependencies extends SpeakerTranscriptionSessionsDependencies {
  readonly isDurableDrainPending?: () => boolean;
  readonly admissionRejection?: AbortController;
  readonly ledger: LivePacketDeliveryLedger;
  readonly speakerId: string;
}

export interface SpeakerTranscriptionSessionsDependencies {
  readonly pendingLiveSpeakerPackets?: import("./contracts.js").LiveSpeakerPendingReader;
  readonly clock: LiveRuntimeClock;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly liveSttDurability?: LiveSttDurabilityPort;
  readonly markLivePacketDelivered?: (packetId: string) => Promise<void>;
  readonly maximumQueuedPackets: number;
  readonly meetingId: string;
  readonly onTranscript: (event: LiveTranscriptionEvent) => void;
  readonly packetAdmission: GlobalPacketFlowControl;
  readonly packetBackpressureTimeoutMs: number;
  readonly packetInspector: LivePacketInspector;
  readonly sessionAdmission: LiveSessionAdmission;
  readonly speakerIdleFinalizeMs: number;
  readonly startedAtMs: number;
  readonly timer: LiveRuntimeTimer;
  readonly transcriber: LiveTranscriptionPort;
}

/** Meeting-local registry of independent speaker transcription sessions. */
export class SpeakerTranscriptionSessions {
  // Abort reasons distinguish admission, terminal provider and unresolved acceptance.
  // Survives speaker deletion/disconnect; restart durability requires separate storage.
  private readonly lifecycleFences = new Map<string, AbortController>();
  private cancelled = false;
  private readonly drainingSpeakers = new Set<string>();
  private readonly durableWakeups = new Set<string>();
  private readonly durableWorkers = new Map<string, Promise<void>>();
  private readonly retiredSpeakers = new Set<SpeakerTranscriptionSession>();
  private readonly ledger = new LivePacketDeliveryLedger();
  private readonly speakers = new Map<string, SpeakerTranscriptionSession>();

  public constructor(
    private readonly dependencies: SpeakerTranscriptionSessionsDependencies,
  ) {}

  public async accept(
    batch: LiveVoicePacketBatch,
    deadlineMs = this.dependencies.clock.nowMilliseconds() + this.dependencies.packetBackpressureTimeoutMs,
  ): Promise<void> {
    const packetsBySpeaker = groupPacketsBySpeaker(batch.packets);
    await Promise.all(
      [...packetsBySpeaker].map(([speakerId, packets]) =>
        this.speaker(speakerId).accept(packets, deadlineMs),
      ),
    );
  }

  public async recover(packets: readonly LiveVoicePacket[]): Promise<void> {
    await Promise.all([...groupPacketsBySpeaker(packets)].map(([speakerId, speakerPackets]) =>
      this.speaker(speakerId).recover(speakerPackets),
    ));
  }

  public async recoverDurableSpeakers(speakerIds: readonly string[], active: () => boolean): Promise<void> {
    // Discovery retains at most one global page. Each independent worker holds
    // only one additional payload, regardless of the other speakers' backlogs.
    const ids = new Set([...this.speakers.keys(), ...speakerIds]);
    const results = await Promise.allSettled([...ids].map(id => this.recoverDurableSpeaker(id, active)));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
    if (failures.length > 0) { throw new AggregateError(failures, "Live speaker drain incomplete"); }
  }

  public wakeDurableSpeakers(speakerIds: readonly string[], active: () => boolean): void {
    for (const id of new Set(speakerIds)) {
      if (this.durableWorkers.has(id)) { this.durableWakeups.add(id); continue; }
      void this.recoverDurableSpeaker(id, active).catch(() => {
        // A wakeup owns no upstream receipt. The main drain/terminal barrier
        // re-reads eligibility and retries settlement before releasing ownership.
        this.dependencies.logger.warn("Derived live speaker wakeup failed", { meetingId: this.dependencies.meetingId, speakerId: id });
      });
    }
  }

  private recoverDurableSpeaker(speakerId: string, active: () => boolean): Promise<void> {
    const existing = this.durableWorkers.get(speakerId);
    if (existing !== undefined) { this.durableWakeups.add(speakerId); return existing; }
    const work = (async () => {
      do {
        this.durableWakeups.delete(speakerId);
        await this.drainDurableSpeaker(speakerId, active);
      } while (active() && this.durableWakeups.has(speakerId));
    })().finally(() => { this.durableWorkers.delete(speakerId); this.durableWakeups.delete(speakerId); });
    this.durableWorkers.set(speakerId, work);
    return work;
  }

  private isCancelled(): boolean { return this.cancelled; }

  private async drainDurableSpeaker(speakerId: string, active: () => boolean): Promise<void> {
    const read = this.dependencies.pendingLiveSpeakerPackets;
    if (read === undefined || this.isCancelled() || this.lifecycleFences.get(speakerId)?.signal.aborted === true) { return; }
    const speaker = this.speaker(speakerId);
    this.drainingSpeakers.add(speakerId);
    try {
      while (active() && !this.isCancelled()) {
        const page = await read(this.dependencies.meetingId, speakerId);
        if (!active() || this.isCancelled() || this.lifecycleFences.get(speakerId)?.signal.aborted === true) { return; }
        if (page.packets.length === 0) {
          // ACK and synced receipt precede this read. Only closed durable
          // eligibility permits independent terminal settlement.
          if (page.closed) { this.drainingSpeakers.delete(speakerId); await speaker.settle(); }
          return;
        }
        await speaker.recover(page.packets);
        if (page.packets.some(packet => !this.ledger.isDelivered(livePacketIdentity(packet)))) { return; }
      }
    } finally {
      this.drainingSpeakers.delete(speakerId);
      speaker.scheduleIdleFinalizationIfReady();
    }
  }

  public restoreDurability(recovery: LiveRecovery): void {
    for (const fence of recovery.fences) {
      if (this.lifecycleFences.get(fence.speakerId)?.signal.aborted === true) { continue; }
      const cancellation = this.lifecycleFences.get(fence.speakerId) ?? new AbortController();
      this.lifecycleFences.set(fence.speakerId, cancellation);
      cancellation.abort(fence.reason === "admission-rejected" ? new LiveTranscriptionAdmissionRejected() :
        fence.reason === "provider-terminal" ? new LiveTranscriptionTerminalFailure() : new LiveTranscriptionAcceptanceUnknown());
      this.dependencies.logger.warn("Derived live transcription degraded after durable recovery", {
        meetingId: this.dependencies.meetingId, speakerId: fence.speakerId, reason: fence.reason,
      });
    }
    if (recovery.legacy) {
      this.dependencies.logger.warn("Derived live transcription degraded: legacy ownership is unknown", {
        meetingId: this.dependencies.meetingId,
      });
    }
  }

  public cancelRecovery(): boolean {
    let cancelled = false;
    for (const [speakerId, speaker] of this.speakers) {
      if (speaker.cancelRecovery()) {
        this.retiredSpeakers.add(speaker);
        this.speakers.delete(speakerId);
        cancelled = true;
      }
    }
    return cancelled;
  }

  public cancel(): void {
    this.cancelled = true;
    for (const rejection of this.lifecycleFences.values()) { rejection.abort(); }
  }

  public async drainPending(): Promise<void> {
    await Promise.all([...this.speakers.values()].map((speaker) => speaker.drainPending()));
  }

  public beginFinish(): void {
    for (const speaker of this.speakers.values()) {
      speaker.beginFinish();
    }
  }

  /** Settles local ownership without claiming successful live transcription. */
  public settle(): Promise<void> { return this.finishSpeakers(true); }

  public finish(): Promise<void> { return this.finishSpeakers(false); }

  private async finishSpeakers(ownershipOnly: boolean): Promise<void> {
    const results = await Promise.allSettled(
      [...this.retiredSpeakers, ...this.speakers.values()].map((speaker) => ownershipOnly ? speaker.settle() : speaker.finish()),
    );
    const failures: unknown[] = results.flatMap((result) => result.status === "rejected" ? [result.reason as unknown] : []);
    // A cancelled recovery may have deleted the speaker while retaining its fence.
    for (const fence of ownershipOnly ? [] : this.lifecycleFences.values()) {
      const reason: unknown = fence.signal.reason;
      if ((reason instanceof LiveTranscriptionTerminalFailure || reason instanceof LiveTranscriptionAcceptanceUnknown) &&
          !failures.includes(reason)) { failures.push(reason); }
    }
    if (failures.length > 0) { throw new AggregateError(failures, "Live speaker shutdown incomplete"); }
  }

  private speaker(speakerId: string): SpeakerTranscriptionSession {
    const existing = this.speakers.get(speakerId);
    if (existing !== undefined) {
      return existing;
    }
    const admissionRejection = this.lifecycleFences.get(speakerId) ?? new AbortController();
    this.lifecycleFences.set(speakerId, admissionRejection);
    if (this.cancelled) { admissionRejection.abort(); }
    const created = new SpeakerTranscriptionSession({
      admissionRejection,
      ...this.dependencies,
      ledger: this.ledger,
      isDurableDrainPending: () => this.drainingSpeakers.has(speakerId),
      speakerId,
    });
    this.speakers.set(speakerId, created);
    return created;
  }
}

function groupPacketsBySpeaker(
  packets: readonly LiveVoicePacket[],
): ReadonlyMap<string, readonly LiveVoicePacket[]> {
  const grouped = new Map<string, LiveVoicePacket[]>();
  for (const packet of packets) {
    const speakerPackets = grouped.get(packet.speakerId);
    if (speakerPackets === undefined) {
      grouped.set(packet.speakerId, [packet]);
    } else {
      speakerPackets.push(packet);
    }
  }
  return grouped;
}

// Read mutable ownership again after I/O; finishing can change while a page is pending.
function isPacketRecoveryActive(state: ActiveLiveMeeting, initialization: Promise<void>): boolean {
  return state.packetRecovery === initialization && !state.finishing;
}

export function initializeLivePacketRecovery(dependencies: LiveMeetingRuntimeDependencies, state: ActiveLiveMeeting): Promise<void> {
  let initialization!: Promise<void>;
  initialization = (async () => {
    await state.packetDrain;
    const durability = await dependencies.liveSttDurability?.recoverRecording(state.meetingId);
    if (durability !== undefined) { state.transcription.restoreDurability(durability); }
    if (durability !== undefined) {
      if (!durability.closed && !durability.legacy && state.packetRecovery === initialization) {
        state.packetDrainReady = true;
        await scheduleDurableLivePacketDrain(dependencies, state);
      }
      return;
    }
    const pending = await dependencies.pendingLivePackets?.(state.meetingId);
    if (isPacketRecoveryActive(state, initialization) && pending !== undefined) {
      void state.transcription.recover(pending).catch((error: unknown) => {
        dependencies.logger.warn("Derived live packet recovery failed", {
          meetingId: state.meetingId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      });
    }
  })();
  state.packetRecovery = initialization;
  void initialization.catch(() => {
    if (state.packetRecovery === initialization) { state.packetRecovery = null; }
  });
  return initialization;
}

/** Coalesces ingress notifications into one bounded outbox page, never a heap batch queue. */
export function scheduleDurableLivePacketDrain(
  dependencies: LiveMeetingRuntimeDependencies, state: ActiveLiveMeeting, speakerIds: readonly string[] = [],
): Promise<void> {
  state.packetDrainRequested = true;
  const ownership = state.packetRecovery;
  const active = (): boolean => state.packetRecovery === ownership && ownership !== null;
  if (dependencies.pendingLiveSpeakerPackets !== undefined) { state.transcription.wakeDurableSpeakers(speakerIds, active); }
  if (state.packetDrain !== null) { return state.packetDrain; }
  // Notifications can mutate this flag while page reads or recovery are awaited.
  const drainRequested = (): boolean => state.packetDrainRequested;
  const drain = (async () => {
    do {
      state.packetDrainRequested = false;
      let after = "";
      while (active()) {
        const page = await dependencies.pendingLivePackets?.(state.meetingId, after);
        if (!active() || page === undefined) { break; }
        if (dependencies.pendingLiveSpeakerPackets !== undefined) {
          // Discover later speakers without retaining pages or waiting for an
          // earlier speaker's backlog. Wakeups coalesce in the speaker registry.
          state.transcription.wakeDurableSpeakers(page.map(packet => packet.speakerId), active);
          if (page.length === 0) { await state.transcription.recoverDurableSpeakers([], active); }
        } else if (page.length > 0) { await state.transcription.recover(page); }
        if (page.length === 0) { break; }
        after = drainRequested() ? "" : livePacketIdentity(page[page.length - 1]!);
        state.packetDrainRequested = false;
      }
      // A notification during a read or drain may precede the cursor. Rescan
      // durable eligibility; accepted receipts and speaker fences exclude replay.
    } while (active() && drainRequested());
  })().finally(() => {
    state.packetDrain = null;
    // Cover a wakeup queued between the last empty read and this settlement.
    if (active() && drainRequested()) { void scheduleDurableLivePacketDrain(dependencies, state); }
  });
  state.packetDrain = drain;
  void drain.catch((error: unknown) => {
    dependencies.logger.warn("Derived live outbox drain failed", {
      meetingId: state.meetingId, errorName: error instanceof Error ? error.name : "UnknownError",
    });
  });
  return drain;
}

export async function waitForLivePacketRecovery(
  initialization: Promise<void> | null | undefined, deadlineMs: number,
  clock: LiveRuntimeClock, timer: LiveRuntimeTimer,
): Promise<boolean> {
  if (initialization === null || initialization === undefined) { return false; }
  let timeout!: LiveRuntimeTimerHandle;
  const expired = new Promise<boolean>((resolve) => {
    timeout = timer.schedule(Math.max(0, deadlineMs - clock.nowMilliseconds()), () => { resolve(false); });
  });
  try { return await Promise.race([initialization.then(() => true), expired]); }
  finally { timer.cancel(timeout); }
}

export async function acceptLivePackets(
  state: ActiveLiveMeeting | undefined,
  packets: readonly LiveVoicePacket[],
  deadlineMs: number,
  logger: LiveRuntimeLogger,
): Promise<void> {
  if (state === undefined || state.finishing || state.packetRecovery === null) {
    for (const packet of packets) {
      logger.debug("Live packet skipped without active derived meeting", {
        meetingId: packet.recordingId,
        speakerId: packet.speakerId,
      });
    }
    return;
  }
  await state.transcription.accept({
    format: { channelCount: 1, codec: "opus", sampleRateHz: 48_000 },
    packets,
  }, deadlineMs);
}

export function groupPacketsByMeeting(packets: readonly LiveVoicePacket[]): ReadonlyMap<string, readonly LiveVoicePacket[]> {
  const packetsByMeeting = new Map<string, LiveVoicePacket[]>();
  for (const packet of packets) {
    const meetingPackets = packetsByMeeting.get(packet.recordingId);
    if (meetingPackets === undefined) {
      packetsByMeeting.set(packet.recordingId, [packet]);
    } else {
      meetingPackets.push(packet);
    }
  }
  return packetsByMeeting;
}
