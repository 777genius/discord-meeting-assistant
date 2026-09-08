/** Storage-owned primitives; Platform translates these at composition. */
export type SttFenceReason =
  | "admission-rejected" | "provider-terminal" | "acceptance-unknown" | "legacy-unknown";
export interface SttOwner { readonly recordingId: string; readonly epoch: number }
export interface SttSession {
  readonly owner: SttOwner;
  readonly speakerId: string;
  readonly generation: number;
}
interface OperationIdentity { readonly session: SttSession; readonly operation: number }
export type SttOperation = OperationIdentity & (
  | { readonly kind: "open" }
  | { readonly kind: "finalize" }
  | { readonly kind: "send"; readonly packetId: string }
);
export type SttCompletion =
  | { readonly operation: SttOperation; readonly outcome: "not-accepted" | SttFenceReason }
  | { readonly operation: OperationIdentity & { readonly kind: "open" }; readonly outcome: "opened" }
  | { readonly operation: OperationIdentity & { readonly kind: "send"; readonly packetId: string }; readonly outcome: "accepted" }
  | { readonly operation: OperationIdentity & { readonly kind: "finalize" }; readonly outcome: "finalized" };
export type SttDenied =
  | { readonly status: "fenced"; readonly reason: SttFenceReason }
  | { readonly status: "recording-closed" };
export type SttGrant = { readonly status: "granted"; readonly operation: SttOperation };
export interface SttRecovery {
  readonly owner: SttOwner;
  readonly closed: boolean;
  readonly legacy: boolean;
  readonly fences: readonly { readonly speakerId: string; readonly reason: SttFenceReason }[];
}
export interface SttJournalPort {
  recoverRecording(recordingId: string): Promise<SttRecovery>;
  beginOpen(owner: SttOwner, speakerId: string): Promise<SttGrant | SttDenied>;
  beginSend(session: SttSession, packetId: string): Promise<SttGrant | SttDenied | { readonly status: "already-accepted" }>;
  beginFinalize(session: SttSession): Promise<SttGrant | SttDenied>;
  complete(completion: SttCompletion): Promise<void>;
  fence(session: SttSession, reason: SttFenceReason): Promise<void>;
  closeRecording(owner: SttOwner, endedAtMs: number): Promise<void>;
}

export type SttRecord = { readonly schemaVersion: 2; readonly recordingId: string } & (
  | { readonly type: "stt-init" }
  | { readonly type: "stt-epoch"; readonly epoch: number }
  | { readonly type: "stt-intent"; readonly operation: SttOperation }
  | { readonly type: "stt-outcome"; readonly completion: SttCompletion }
  | { readonly type: "stt-fence"; readonly speakerId: string; readonly reason: SttFenceReason }
  | { readonly type: "stt-close"; readonly endedAtMs: number }
);
export interface SttRecordingState {
  initialized: boolean;
  epoch: number;
  operation: number;
  endedAtMs?: number;
}
export interface SttSpeakerState {
  generation: number;
  opened: boolean;
  accepted?: boolean;
  failedAttempts?: number;
  pending?: SttOperation;
  fence?: SttFenceReason;
}
export function isSttFence(value: unknown): value is SttFenceReason {
  return value === "admission-rejected" || value === "provider-terminal" ||
    value === "acceptance-unknown" || value === "legacy-unknown";
}
