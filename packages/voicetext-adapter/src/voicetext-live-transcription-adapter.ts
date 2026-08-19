import {
  createVoicetextLiveOperationSignal,
  validateVoicetextLiveIdentity,
  validateVoicetextLiveTranscriptionOptions,
  type OpenVoicetextLiveSessionRequest,
  type ValidatedVoicetextLiveTranscriptionOptions,
  type VoicetextLiveSession,
  type VoicetextLiveTranscriptionOptions,
} from "./voicetext-live-transcription-configuration.js";
import { LiveSession } from "./voicetext-live-session.js";
import type { VoicetextWebSocketConnector } from "./websocket-connector.js";
import { WsVoicetextWebSocketConnector } from "./ws-websocket-connector.js";

export type {
  OpenVoicetextLiveSessionRequest,
  VoicetextLivePacket,
  VoicetextLiveProfile,
  VoicetextLiveSession,
  VoicetextLiveTranscriptEvent,
  VoicetextLiveTranscriptionOptions,
} from "./voicetext-live-transcription-configuration.js";

export class VoicetextLiveTranscriptionAdapter {
  private readonly options: ValidatedVoicetextLiveTranscriptionOptions;

  public constructor(
    options: VoicetextLiveTranscriptionOptions,
    private readonly connector: VoicetextWebSocketConnector = new WsVoicetextWebSocketConnector(),
  ) {
    this.options = validateVoicetextLiveTranscriptionOptions(options);
  }

  public async openSession(
    request: OpenVoicetextLiveSessionRequest,
  ): Promise<VoicetextLiveSession> {
    validateVoicetextLiveIdentity(request.meetingId, "meetingId");
    validateVoicetextLiveIdentity(request.speakerId, "speakerId");
    validateVoicetextLiveIdentity(request.idempotencyKey, "idempotencyKey");
    request.signal?.throwIfAborted();
    const connectSignal = createVoicetextLiveOperationSignal(
      request.signal,
      this.options.handshakeTimeoutMs,
    );
    const socket = await this.connector.connect({
      authorization: this.options.authorization,
      endpoint: this.options.endpoint,
      handshakeTimeoutMs: this.options.handshakeTimeoutMs,
      maxInboundFrameBytes: this.options.maxInboundFrameBytes,
      signal: connectSignal,
    });
    const session = new LiveSession(socket, request, this.options);
    try {
      await session.start();
      return session;
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }
}
