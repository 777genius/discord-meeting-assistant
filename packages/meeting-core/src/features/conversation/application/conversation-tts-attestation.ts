import type {
  ConversationRuntimeEvent,
} from "./ports/conversation.js";
import type {
  ActiveConversationRun,
} from "./conversation-coordinator-types.js";

export function acceptConversationTtsAttestation(
  run: ActiveConversationRun,
  event: Extract<ConversationRuntimeEvent, { readonly type: "tts-attestation" }>,
  onRejected: () => Promise<void>,
): Promise<void> {
  if (
    run.ttsAttestation !== null ||
    event.attestation.turnId !== run.prepared.turn.turnId ||
    event.attestation.voiceProfileId !== run.prepared.request.voiceProfileId
  ) {
    return onRejected();
  }
  run.ttsAttestation = event.attestation;
  return Promise.resolve();
}
