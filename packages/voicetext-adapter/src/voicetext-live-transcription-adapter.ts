import { stableLiveSessionUuid } from "./voicetext-live-session-primitives.js";
import {
  createVoicetextLiveOperationSignal,
  validateVoicetextLiveIdentity,
  validateVoicetextLiveTranscriptionOptions,
  type OpenVoicetextLiveSessionRequest,
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
  public constructor(
    private readonly options: VoicetextLiveTranscriptionOptions,
    private readonly connector: VoicetextWebSocketConnector = new WsVoicetextWebSocketConnector(),
  ) {}

  public async openSession(
    request: OpenVoicetextLiveSessionRequest,
  ): Promise<VoicetextLiveSession> {
    const options = validateVoicetextLiveTranscriptionOptions(this.options);
    validateVoicetextLiveIdentity(request.meetingId, "meetingId");
    validateVoicetextLiveIdentity(request.speakerId, "speakerId");
    validateVoicetextLiveIdentity(request.idempotencyKey, "idempotencyKey");
    request.signal?.throwIfAborted();
    const connectSignal = createVoicetextLiveOperationSignal(
      request.signal,
      options.handshakeTimeoutMs,
    );
    const evidence = options.evidenceSink?.open();
    evidence?.record({ type: "opening", meetingId: request.meetingId, speakerId: request.speakerId,
      clientSessionId: stableLiveSessionUuid(request.idempotencyKey, request.meetingId, request.speakerId) });
    const socket = await this.connector.connect({
      authorization: options.authorization,
      endpoint: options.endpoint,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      maxInboundFrameBytes: options.maxInboundFrameBytes,
      signal: connectSignal,
    }).catch((error: unknown) => { evidence?.record({ type: "failure" }); throw error; });
    const session = new LiveSession(socket, request, options, evidence);
    try {
      await session.start();
      return session;
    } catch (error) {
      evidence?.record({ type: "failure" });
      socket.terminate();
      throw error;
    }
  }
}
