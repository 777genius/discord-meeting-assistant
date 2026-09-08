import { RecordingIngressError, type SttJournalPort } from "@discord-meeting/recording-ingress-adapter";
import {
  LiveSttDurabilityConflict, LiveSttDurabilityUnavailable, type LiveSttDurabilityPort,
} from "../live-runtime/contracts.js";

/** Structural boundary data is copied by storage; failures belong to the consumer. */
export function mapLiveSttDurability(storage: SttJournalPort): LiveSttDurabilityPort {
  return {
    recoverRecording: (id) => invoke(() => storage.recoverRecording(id)),
    beginOpen: (owner, speaker) => invoke(() => storage.beginOpen(owner, speaker)),
    beginSend: (session, packet) => invoke(() => storage.beginSend(session, packet)),
    beginFinalize: (session) => invoke(() => storage.beginFinalize(session)),
    complete: (completion) => invoke(() => storage.complete(completion)),
    fence: (session, reason) => invoke(() => storage.fence(session, reason)),
    closeRecording: (owner, endedAtMs) => invoke(() => storage.closeRecording(owner, endedAtMs)),
  };
}

async function invoke<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof RecordingIngressError &&
        (error.failure === "conflicting-duplicate" || error.failure === "invalid-input")) {
      throw new LiveSttDurabilityConflict({ cause: error });
    }
    throw new LiveSttDurabilityUnavailable({ cause: error });
  }
}
