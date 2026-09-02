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
  private readonly ledger = new LivePacketDeliveryLedger();
  private readonly speakers = new Map<string, SpeakerTranscriptionSession>();

  public constructor(
    private readonly dependencies: SpeakerTranscriptionSessionsDependencies,
  ) {}

  public async accept(batch: LiveVoicePacketBatch): Promise<void> {
    const deadlineMs = this.dependencies.clock.nowMilliseconds() +
      this.dependencies.packetBackpressureTimeoutMs;
    const packetsBySpeaker = groupPacketsBySpeaker(batch.packets);
    await Promise.all(
      [...packetsBySpeaker].map(([speakerId, packets]) =>
        this.speaker(speakerId).accept(packets, deadlineMs),
      ),
    );
  }

  public beginFinish(): void {
    for (const speaker of this.speakers.values()) {
      speaker.beginFinish();
    }
  }

  public async finish(): Promise<void> {
    await Promise.allSettled(
      [...this.speakers.values()].map((speaker) => speaker.finish()),
    );
  }

  private speaker(speakerId: string): SpeakerTranscriptionSession {
    const existing = this.speakers.get(speakerId);
    if (existing !== undefined) {
      return existing;
    }
    const created = new SpeakerTranscriptionSession({
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
