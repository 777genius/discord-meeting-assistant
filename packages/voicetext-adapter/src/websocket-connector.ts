export type VoicetextInboundFrame =
  | { readonly data: string; readonly type: "text" }
  | { readonly data: Uint8Array; readonly type: "binary" }
  | { readonly code: number; readonly reason: string; readonly type: "close" };

export interface VoicetextWebSocketConnection {
  close(code: number, reason: string): Promise<void>;
  receive(signal: AbortSignal): Promise<VoicetextInboundFrame>;
  sendBinary(data: Uint8Array, signal: AbortSignal): Promise<void>;
  sendText(data: string, signal: AbortSignal): Promise<void>;
  terminate(): void;
}

export interface VoicetextWebSocketConnectRequest {
  readonly authorization: string;
  readonly endpoint: URL;
  readonly handshakeTimeoutMs: number;
  readonly maxInboundFrameBytes: number;
  readonly signal: AbortSignal;
}

export interface VoicetextWebSocketConnector {
  connect(
    request: VoicetextWebSocketConnectRequest,
  ): Promise<VoicetextWebSocketConnection>;
}
