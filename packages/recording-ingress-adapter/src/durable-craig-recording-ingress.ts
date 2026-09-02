import type {
  AuthoritativeTrackUploadMetadata,
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";

import type {
  AuthoritativeTrackIngressResult,
  DurableCraigRecordingIngressOptions,
  LifecycleIngressResult,
  PacketBatchIngressResult,
} from "./contracts.js";
import { ingestAuthoritativeTrack } from "./recording-ingress-authoritative.js";
import { ingestLifecycleEvent } from "./recording-ingress-lifecycle.js";
import { ingestPacketBatch } from "./recording-ingress-packet-ingest.js";
import {
  markLivePacketDelivered,
  pendingLivePackets,
  type DurableLiveVoicePacket,
} from "./live-delivery-outbox.js";
import { RecordingIngressRuntime } from "./recording-ingress-runtime.js";

export { DEFAULT_RECORDING_INGRESS_LIMITS } from "./recording-ingress-invariants.js";

/**
 * Durable boundary for derived live packets and Craig's authoritative original.
 * Only the `recording.authoritative_ready` lifecycle fact can finalize the
 * original recording; the packet journal remains derived ingress evidence.
 */
export class DurableCraigRecordingIngress {
  readonly #runtime: RecordingIngressRuntime;

  public constructor(options: DurableCraigRecordingIngressOptions) {
    this.#runtime = new RecordingIngressRuntime(options);
  }

  public ingestAuthoritativeTrack(
    metadata: AuthoritativeTrackUploadMetadata,
    body: AsyncIterable<Uint8Array>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AuthoritativeTrackIngressResult> {
    return this.#runtime.withExclusiveSpoolOwnership(
      () => ingestAuthoritativeTrack(this.#runtime, metadata, body, options),
      options.signal,
    );
  }

  public ingestPacketBatch(
    batch: VoicePacketBatch,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PacketBatchIngressResult> {
    return this.#runtime.withExclusiveSpoolOwnership(
      () => ingestPacketBatch(this.#runtime, batch, options),
      options.signal,
    );
  }

  public pendingLivePackets(recordingId: string): Promise<readonly DurableLiveVoicePacket[]> {
    return pendingLivePackets(this.#runtime, recordingId);
  }

  public markLivePacketDelivered(packetId: string): Promise<"marked" | "reused"> {
    return markLivePacketDelivered(this.#runtime, packetId);
  }

  public ingestLifecycleEvent(
    event: CraigLifecycleEvent,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LifecycleIngressResult> {
    return this.#runtime.withExclusiveSpoolOwnership(
      () => ingestLifecycleEvent(this.#runtime, event, options),
      options.signal,
    );
  }

  /** Release the local spool marker after HTTP admission and in-flight work stop. */
  public close(): Promise<void> {
    return this.#runtime.close();
  }

  /** Claim the singleton spool before this process begins accepting HTTP work. */
  public acquireExclusiveSpoolOwnership(): Promise<void> {
    return this.#runtime.acquireExclusiveSpoolOwnership();
  }
}
