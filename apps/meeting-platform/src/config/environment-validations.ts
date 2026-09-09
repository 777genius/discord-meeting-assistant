import type { RefinementCtx } from "zod";

interface ConversationReadinessEnvironment {
  readonly CONVERSATION_E2E_GREETING_OBSERVER_PARTICIPANT_ID?: string | undefined;
  readonly CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT?: string | undefined;
  readonly CONVERSATION_E2E_PLAYBACK_READINESS_ROOT?: string | undefined;
  readonly CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID?: string | undefined;
  readonly CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS?: number | undefined;
}

interface ConversationEnvironment extends ConversationReadinessEnvironment {
  readonly CONVERSATION_ENABLED: boolean;
  readonly CONVERSATION_RUNTIME_ADDRESS?: string | undefined;
  readonly CONVERSATION_RUNTIME_TOKEN_FILE?: string | undefined;
  readonly CONVERSATION_VOICE_PROFILE_ID: string;
  readonly E2E_TEST_ONLY_LABEL: boolean;
  readonly MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: boolean;
  readonly NODE_ENV: "development" | "production" | "test";
  readonly PARTICIPANT_GREETING_PROFILES_JSON: Readonly<Record<string, unknown>>;
  readonly TRANSCRIPTION_PROVIDER: "speaches" | "voicetext";
}

interface DiscordApplicationEnvironment {
  readonly DISCORD_APPLICATION_ID: string;
  readonly DISCORD_BOTIK_APPLICATION_ID?: string | undefined;
  readonly DISCORD_CRAIG_APPLICATION_ID: string;
}

interface MeetingKnowledgeEnvironment {
  readonly CONVERSATION_ENABLED: boolean;
  readonly DISCORD_APPLICATION_ID: string;
  readonly DISCORD_BOTIK_APPLICATION_ID?: string | undefined;
  readonly DISCORD_CRAIG_APPLICATION_ID: string;
  readonly DISCORD_PUBLICATION_MODE: string;
  readonly E2E_TEST_ONLY_LABEL: boolean;
  readonly MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS: readonly string[];
  readonly MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_ROOT?: string | undefined;
  readonly MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_WORKER_ID?: string | undefined;
  readonly MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED: boolean;
  readonly MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_EPOCH?: string | undefined;
  readonly MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_STATE_FILE?: string | undefined;
  readonly MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: boolean;
  readonly MEETING_KNOWLEDGE_ACTOR_KEYRING_FILE?: string | undefined;
  readonly MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE?: string | undefined;
  readonly MEETING_KNOWLEDGE_RETRIEVAL_V2_PROVIDER_BINDING_JSON?: object | undefined;
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

export function validateConversationEnvironment(
  environment: ConversationEnvironment,
  context: RefinementCtx,
): void {
  const playbackReadinessParts = [
    environment.CONVERSATION_E2E_PLAYBACK_READINESS_ROOT,
    environment.CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID,
    environment.CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS,
  ];
  const configuredPlaybackReadinessParts = playbackReadinessParts
    .filter((value) => value !== undefined).length;
  if (configuredPlaybackReadinessParts !== 0 && configuredPlaybackReadinessParts !== 3) {
    context.addIssue({
      code: "custom",
      message: "conversation E2E playback readiness root, run ID and timeout must be configured together",
      path: ["CONVERSATION_E2E_PLAYBACK_READINESS_ROOT"],
    });
  }
  if (configuredPlaybackReadinessParts > 0 && !environment.E2E_TEST_ONLY_LABEL) {
    context.addIssue({
      code: "custom",
      message: "conversation playback readiness is permitted only in an explicitly test-only deployment",
      path: ["E2E_TEST_ONLY_LABEL"],
    });
  }
  if (configuredPlaybackReadinessParts > 0 && !environment.CONVERSATION_ENABLED) {
    context.addIssue({
      code: "custom",
      message: "conversation playback readiness requires live conversation to be enabled",
      path: ["CONVERSATION_ENABLED"],
    });
  }
  if (
    Object.keys(environment.PARTICIPANT_GREETING_PROFILES_JSON).length > 0 &&
    !environment.CONVERSATION_ENABLED &&
    !environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED
  ) {
    context.addIssue({
      code: "custom",
      message:
        "participant greeting profiles require live conversation or local final reply to be enabled",
      path: ["PARTICIPANT_GREETING_PROFILES_JSON"],
    });
  }
  if (!environment.CONVERSATION_ENABLED) {
    return;
  }
  if (environment.TRANSCRIPTION_PROVIDER !== "voicetext") {
    context.addIssue({
      code: "custom",
      message: "live conversation requires Voicetext streaming transcription",
      path: ["TRANSCRIPTION_PROVIDER"],
    });
  }
  if (environment.CONVERSATION_RUNTIME_ADDRESS === undefined) {
    context.addIssue({
      code: "custom",
      message: "CONVERSATION_RUNTIME_ADDRESS is required when conversation is enabled",
      path: ["CONVERSATION_RUNTIME_ADDRESS"],
    });
  }
  if (environment.CONVERSATION_RUNTIME_TOKEN_FILE === undefined) {
    context.addIssue({
      code: "custom",
      message: "CONVERSATION_RUNTIME_TOKEN_FILE is required when conversation is enabled",
      path: ["CONVERSATION_RUNTIME_TOKEN_FILE"],
    });
  }
  if (
    environment.NODE_ENV === "production" &&
    environment.CONVERSATION_VOICE_PROFILE_ID.startsWith("deterministic-e2e")
  ) {
    context.addIssue({
      code: "custom",
      message: "deterministic E2E voice profiles are forbidden in production",
      path: ["CONVERSATION_VOICE_PROFILE_ID"],
    });
  }
}

export function validateDiscordApplicationEnvironment(
  environment: DiscordApplicationEnvironment,
  context: RefinementCtx,
): void {
  if (
    environment.DISCORD_APPLICATION_ID === environment.DISCORD_CRAIG_APPLICATION_ID
  ) {
    context.addIssue({
      code: "custom",
      message: "publication and Craig application IDs must be distinct",
      path: ["DISCORD_CRAIG_APPLICATION_ID"],
    });
  }
}

export function validateMeetingKnowledgeEnvironment(
  environment: MeetingKnowledgeEnvironment,
  context: RefinementCtx,
): void {
  if (
    environment.MEETING_KNOWLEDGE_RETRIEVAL_V2_PROVIDER_BINDING_JSON !== undefined &&
    environment.MEETING_KNOWLEDGE_ACTOR_KEYRING_FILE === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Retrieval V2 requires Discord actor-key mapping authority",
      path: ["MEETING_KNOWLEDGE_ACTOR_KEYRING_FILE"],
    });
  }
  const crashValues = [environment.MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_ROOT,
    environment.MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_WORKER_ID];
  if (crashValues.filter((value) => value !== undefined).length === 1) {
    context.addIssue({ code: "custom",
      message: "public-reply crash root and worker ID must be configured together",
      path: ["MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_ROOT"] });
  }
  if (crashValues[0] !== undefined &&
    (!environment.E2E_TEST_ONLY_LABEL || !environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED)) {
    context.addIssue({ code: "custom",
      message: "public-reply crash injection requires the test-only local-final-reply profile",
      path: ["MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_ROOT"] });
  }
  if (
    environment.MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS.length > 0 &&
    !environment.E2E_TEST_ONLY_LABEL
  ) {
    context.addIssue({
      code: "custom",
      message: "synthetic human question actors are permitted only in an explicitly test-only deployment",
      path: ["E2E_TEST_ONLY_LABEL"],
    });
  }
  if (environment.MEETING_KNOWLEDGE_RETRIEVAL_V2_PROVIDER_BINDING_JSON !== undefined &&
    !environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED) {
    context.addIssue({ code: "custom",
      message: "Retrieval V2 provider binding requires local final reply",
      path: ["MEETING_KNOWLEDGE_RETRIEVAL_V2_PROVIDER_BINDING_JSON"] });
  }
  if (
    environment.MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS.length > 0 &&
    !environment.MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED
  ) {
    context.addIssue({
      code: "custom",
      message: "synthetic human question actors require local final reply",
      path: ["MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED"],
    });
  }
  const protectedApplicationIds = new Set([
    environment.DISCORD_APPLICATION_ID,
    environment.DISCORD_CRAIG_APPLICATION_ID,
    ...(environment.DISCORD_BOTIK_APPLICATION_ID === undefined
      ? []
      : [environment.DISCORD_BOTIK_APPLICATION_ID]),
  ]);
  if (environment.MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS.some(
    (actorId) => protectedApplicationIds.has(actorId),
  )) {
    context.addIssue({
      code: "custom",
      message: "platform application identities cannot be synthetic human question actors",
      path: ["MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS"],
    });
  }
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
    environment.MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED &&
    environment.MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_STATE_FILE === undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "grounded voice requires a runtime-readable rollout state file",
      path: ["MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_STATE_FILE"],
    });
  }
  if (
    environment.MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED &&
    !environment.CONVERSATION_ENABLED
  ) {
    context.addIssue({
      code: "custom",
      message: "grounded voice requires conversation runtime",
      path: ["CONVERSATION_ENABLED"],
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
