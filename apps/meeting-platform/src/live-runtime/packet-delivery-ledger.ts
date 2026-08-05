import type { LiveVoicePacket } from "./contracts.js";

const maximumRememberedPacketIds = 65_536;

export function livePacketIdentity(packet: LiveVoicePacket): string {
  return [
    packet.recordingId,
    packet.speakerId,
    packet.rtpTimestamp,
    packet.rtpSequence,
    packet.relativeTimeMs,
  ].join(":");
}

/**
 * Bounded meeting-local deduplication state. It records a packet only after a
 * transcription session accepted it, so a failed packet remains eligible for
 * its durable replay.
 */
export class LivePacketDeliveryLedger {
  private readonly deliveredIds = new Set<string>();
  private readonly deliveryOrder: string[] = [];
  private readonly retryableIds = new Map<string, true>();

  public isDelivered(packetId: string): boolean {
    return this.deliveredIds.has(packetId);
  }

  public isRetryable(packetId: string): boolean {
    return this.retryableIds.has(packetId);
  }

  public markDelivered(packetId: string): boolean {
    const recovered = this.retryableIds.delete(packetId);
    this.deliveredIds.add(packetId);
    this.deliveryOrder.push(packetId);
    if (this.deliveryOrder.length > maximumRememberedPacketIds) {
      const evicted = this.deliveryOrder.shift();
      if (evicted !== undefined) {
        this.deliveredIds.delete(evicted);
      }
    }
    return recovered;
  }

  public markRetryable(packetId: string): boolean {
    if (this.retryableIds.has(packetId)) {
      return false;
    }
    this.retryableIds.set(packetId, true);
    if (this.retryableIds.size > maximumRememberedPacketIds) {
      const oldestPacketId = this.retryableIds.keys().next().value;
      if (oldestPacketId !== undefined) {
        this.retryableIds.delete(oldestPacketId);
      }
    }
    return true;
  }
}
