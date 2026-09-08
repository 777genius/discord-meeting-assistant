import { VoicetextAdapterError } from "@discord-meeting/voicetext-adapter";

import {
  LiveTranscriptionAcceptanceUnknown,
  LiveTranscriptionAdmissionRejected,
  LiveTranscriptionTerminalFailure,
  LiveTranscriptionNotAccepted,
  type LiveTranscriptionPort,
} from "../live-runtime/contracts.js";

function translate(error: unknown, opening = false): never {
  if (error instanceof VoicetextAdapterError) {
    if (error.code === "live_admission_rejected") {
      throw new LiveTranscriptionAdmissionRejected();
    }
    if (error.code === "live_provider_terminal") {
      throw new LiveTranscriptionTerminalFailure();
    }
    if (error.code === "live_acceptance_unknown") {
      throw new LiveTranscriptionAcceptanceUnknown();
    }
    if (error.code === "provider_error" && error.gatewayCode === "PROVIDER_UNAVAILABLE") {
      if (!opening) { throw new LiveTranscriptionAcceptanceUnknown(); }
      throw new LiveTranscriptionNotAccepted();
    }
  }
  throw error;
}

export function mapLiveAdmission(adapter: LiveTranscriptionPort): LiveTranscriptionPort {
  return {
    openSession: async (request) => {
      try {
        const session = await adapter.openSession(request);
        return {
          sendPacket: async (packet) => {
            try {
              return await session.sendPacket(packet);
            } catch (error) {
              return translate(error);
            }
          },
          finalize: async () => {
            try {
              await session.finalize();
            } catch (error) {
              translate(error);
            }
          },
          terminate: () => { session.terminate(); },
        };
      } catch (error) {
        return translate(error, true);
      }
    },
  };
}
