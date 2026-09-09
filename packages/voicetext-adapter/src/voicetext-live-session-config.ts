import type { VoicetextConfigMessage } from "./protocol.js";
import { stableLiveSessionUuid } from "./voicetext-live-session-primitives.js";
import type { OpenVoicetextLiveSessionRequest, ValidatedVoicetextLiveTranscriptionOptions } from "./voicetext-live-transcription-configuration.js";

export function createLiveSessionConfig(
  request: OpenVoicetextLiveSessionRequest,
  options: ValidatedVoicetextLiveTranscriptionOptions,
): VoicetextConfigMessage {
  return {
    capabilities: ["finalize_ack"],
    channels: 1,
    client_session_id: stableLiveSessionUuid(request.idempotencyKey, request.meetingId, request.speakerId),
    encoding: "opus",
    ...(options.keyterms.length === 0 ? {} : { keyterms: options.keyterms }),
    language: options.language,
    model: options.identity.model,
    protocol_v: 2,
    provider: options.identity.provider,
    sample_rate: 48_000,
    type: "config",
  };
}
