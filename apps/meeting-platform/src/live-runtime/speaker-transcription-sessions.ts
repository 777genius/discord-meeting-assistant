import { LiveTranscriptionAcceptanceUnknown, LiveTranscriptionTerminalFailure } from "./contracts.js";
import type {
  GlobalPacketFlowControl,
  LiveSessionAdmission,
} from "./live-packet-flow-control.js";

import type {
  LivePacketInspector,
  LiveRuntimeClock,
  LiveRuntimeLogger,
  LiveRuntimeTimer,
  LiveTranscriptionEvent,
  LiveTranscriptionPort,
  LiveVoicePacket,
  LiveVoicePacketBatch,
} from "./contracts.js";
import { LivePacketDeliveryLedger } from "./packet-delivery-ledger.js";
import { SpeakerTranscriptionSession } from "./speaker-transcription-session.js";

export interface SpeakerTranscriptionSessionsDependencies {
  readonly clock: LiveRuntimeClock;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
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
