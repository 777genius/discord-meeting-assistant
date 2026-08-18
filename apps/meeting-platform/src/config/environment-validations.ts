import type { RefinementCtx } from "zod";

interface ConversationReadinessEnvironment {
  readonly CONVERSATION_E2E_GREETING_OBSERVER_PARTICIPANT_ID?: string | undefined;
  readonly CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT?: string | undefined;
  readonly CONVERSATION_E2E_PLAYBACK_READINESS_ROOT?: string | undefined;
  readonly CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID?: string | undefined;
  readonly CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS?: number | undefined;
}

interface MeetingKnowledgeEnvironment {
  readonly CONVERSATION_ENABLED: boolean;
  readonly DISCORD_PUBLICATION_MODE: string;
  readonly MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED: boolean;
  readonly MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_EPOCH?: string | undefined;
  readonly MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: boolean;
  readonly MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE?: string | undefined;
}

export function validateConversationReadinessEnvironment(
  environment: ConversationReadinessEnvironment,
  context: RefinementCtx,
): void {
  const playbackCount = [
    environment.CONVERSATION_E2E_PLAYBACK_READINESS_ROOT,
    environment.CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID,
    environment.CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS,
  ].filter((value) => value !== undefined).length;
  const greetingCount = [
    environment.CONVERSATION_E2E_GREETING_OBSERVER_PARTICIPANT_ID,
    environment.CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT,
  ].filter((value) => value !== undefined).length;
  if (greetingCount !== 0 && (greetingCount !== 2 || playbackCount !== 3)) {
    context.addIssue({
      code: "custom",
      message:
        "conversation E2E greeting readiness requires observer ID, greeting root and playback readiness",
      path: ["CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT"],
    });
  }
}

export function validateMeetingKnowledgeEnvironment(
  environment: MeetingKnowledgeEnvironment,
  context: RefinementCtx,
): void {
  if (
    environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED &&
    environment.MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "local final reply requires MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE",
      path: ["MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE"],
    });
  }
  if (
    environment.MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED &&
    environment.MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "grounded voice requires MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE",
      path: ["MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE"],
    });
  }
  if (
    environment.MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED &&
    environment.MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_EPOCH === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "grounded voice requires a versioned rollout epoch",
      path: ["MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_EPOCH"],
    });
  }
  if (
    environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED &&
    environment.DISCORD_PUBLICATION_MODE !== "message"
  ) {
    context.addIssue({
      code: "custom",
      message: "local final reply currently requires direct-message publication mode",
      path: ["DISCORD_PUBLICATION_MODE"],
    });
  }
}
