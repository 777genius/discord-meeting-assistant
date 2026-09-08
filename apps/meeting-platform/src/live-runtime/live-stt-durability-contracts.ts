/** Consumer-owned boundary for durable admission of derived STT effects. */
export type LiveFenceReason =
  | "admission-rejected" | "provider-terminal" | "acceptance-unknown" | "legacy-unknown";
interface LiveOwner { readonly recordingId: string; readonly epoch: number }
export interface LiveSessionOwner {
  readonly owner: LiveOwner;
  readonly speakerId: string;
  readonly generation: number;
}
interface OperationIdentity { readonly session: LiveSessionOwner; readonly operation: number }
export type LiveOperation = OperationIdentity & (
  | { readonly kind: "open" }
  | { readonly kind: "finalize" }
  | { readonly kind: "send"; readonly packetId: string }
);
type LiveCompletion =
  | { readonly operation: LiveOperation; readonly outcome: "not-accepted" | LiveFenceReason }
  | { readonly operation: OperationIdentity & { readonly kind: "open" }; readonly outcome: "opened" }
  | { readonly operation: OperationIdentity & { readonly kind: "send"; readonly packetId: string }; readonly outcome: "accepted" }
  | { readonly operation: OperationIdentity & { readonly kind: "finalize" }; readonly outcome: "finalized" };
export type LiveDenied =
  | { readonly status: "fenced"; readonly reason: LiveFenceReason }
  | { readonly status: "recording-closed" };
export type LiveGrant = { readonly status: "granted"; readonly operation: LiveOperation };
export interface LiveRecovery {
  readonly owner: LiveOwner;
  readonly closed: boolean;
  readonly endedAtMs?: number;
  readonly legacy: boolean;
  readonly fences: readonly { readonly speakerId: string; readonly reason: LiveFenceReason }[];
}
export interface LiveSttDurabilityPort {
  recoverRecording(recordingId: string): Promise<LiveRecovery>;
  beginOpen(owner: LiveOwner, speakerId: string): Promise<LiveGrant | LiveDenied>;
  beginSend(session: LiveSessionOwner, packetId: string): Promise<LiveGrant | LiveDenied | { readonly status: "already-accepted" }>;
  beginFinalize(session: LiveSessionOwner): Promise<LiveGrant | LiveDenied>;
  complete(completion: LiveCompletion): Promise<void>;
  fence(session: LiveSessionOwner, reason: LiveFenceReason): Promise<void>;
  closeRecording(owner: LiveOwner, endedAtMs: number): Promise<void>;
}

export class LiveSttDurabilityUnavailable extends Error {
  public constructor(options?: ErrorOptions) { super("Live STT durability unavailable", options); this.name = "LiveSttDurabilityUnavailable"; }
}
export class LiveSttDurabilityConflict extends Error {
  public constructor(options?: ErrorOptions) { super("Live STT durability conflict", options); this.name = "LiveSttDurabilityConflict"; }
}
/** Positive evidence that an effect was not accepted, not an arbitrary retry hint. */
export class LiveTranscriptionNotAccepted extends Error {
  public constructor() { super("Live transcription effect was not accepted"); this.name = "LiveTranscriptionNotAccepted"; }
}
