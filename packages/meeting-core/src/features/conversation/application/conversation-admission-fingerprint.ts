import { DomainInvariantError } from "../domain/errors.js";
import type { PreparedConversation } from "./conversation-coordinator-types.js";

export function normalizedLiteralSpeech(text: string): string {
  const normalized = text.normalize("NFKC").trim();
  if (normalized.length === 0) {
    throw new DomainInvariantError(
      "EMPTY_VALUE",
      "conversation.literalSpeech must not be empty",
    );
  }
  return normalized;
}

export function preparedConversationFingerprint(
  prepared: PreparedConversation,
): string {
  return JSON.stringify([
    "prepared-conversation:v1",
    prepared.interruptible,
    prepared.preemptive,
    prepared.playbackNotAfterMs ?? null,
    prepared.groundedKnowledgeRequest?.meetingId ?? null,
    prepared.groundedKnowledgeRequest?.roomId ?? null,
    prepared.groundedKnowledgeRequest?.participantId ?? null,
    prepared.groundedKnowledgeRequest?.question ?? null,
    prepared.groundedKnowledgeRequest?.locale ?? null,
    prepared.request.idempotencyKey,
    prepared.request.locale,
    prepared.request.literalSpeech ?? null,
    prepared.request.meetingId,
    prepared.request.prompt,
    prepared.request.recordingId,
    prepared.request.speakerId,
    prepared.request.systemPrompt,
    prepared.request.turnId,
    prepared.request.voiceProfileId,
    prepared.thinkingCueLocale,
    prepared.thinkingCuesEnabled,
    prepared.cue?.cueId ?? null,
    prepared.cue?.assetSha256 ?? null,
    prepared.cue?.playbackAttemptId ?? null,
  ]);
}
