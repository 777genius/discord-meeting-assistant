import { describe, expect, it } from "vitest";

import { loadPlatformConfig } from "../src/config.js";
import { platformTestEnvironment as environment } from "./config-test-environment.js";

describe("synthetic human question actor configuration", () => {
  it("admits actors only behind the explicit E2E guard", async () => {
    const principalKeyPath = "/run/secrets/meeting-knowledge-principal-key";
    const actorIds = "1533227577286852649,1533228054724346087";
    const configured = await loadPlatformConfig({
      ...environment,
      E2E_TEST_ONLY_LABEL: "true",
      MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS: actorIds,
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
    }, async () => "value");
    expect(configured.meetingKnowledge).toMatchObject({
      e2eSyntheticHumanActorIds: actorIds.split(","),
      localFinalReply: true,
    });
    await expect(loadPlatformConfig({
      ...environment,
      MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS: actorIds,
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
    }, async () => "value")).rejects.toThrow("explicitly test-only");
    await expect(loadPlatformConfig({
      ...environment,
      E2E_TEST_ONLY_LABEL: "true",
      MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS: actorIds,
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "false",
    }, async () => "value")).rejects.toThrow(
      "synthetic human question actors require local final reply",
    );
    await expect(loadPlatformConfig({
      ...environment,
      E2E_TEST_ONLY_LABEL: "true",
      MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS:
        environment.DISCORD_APPLICATION_ID,
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
    }, async () => "value")).rejects.toThrow(
      "platform application identities cannot be synthetic human",
    );
    for (const invalidActorIds of [
      "not-a-snowflake",
      "1533227577286852649,1533227577286852649",
    ]) {
      await expect(loadPlatformConfig({
        ...environment,
        E2E_TEST_ONLY_LABEL: "true",
        MEETING_KNOWLEDGE_E2E_SYNTHETIC_HUMAN_ACTOR_IDS: invalidActorIds,
        MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
        MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
      }, async () => "value")).rejects.toThrow(
        "at most 128 unique Discord snowflakes",
      );
    }
  });

});

describe("grounded voice configuration", () => {
  it("keeps grounded voice independently disabled and requires a versioned epoch", async () => {
    const principalKeyPath = "/run/secrets/meeting-knowledge-principal-key";
    const rolloutStatePath = "/run/config/grounded-voice-rollout.json";
    const disabled = await loadPlatformConfig(environment, async () => "value");
    expect(disabled.meetingKnowledge?.groundedVoice).toBeUndefined();

    await expect(loadPlatformConfig({
      ...environment,
      CONVERSATION_ENABLED: "true",
      CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
      CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/conversation-runtime",
      TRANSCRIPTION_PROVIDER: "voicetext",
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
      VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
      MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED: "true",
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
    }, async () => "value")).rejects.toThrow(
      "grounded voice requires a versioned rollout epoch",
    );

    const enabled = await loadPlatformConfig({
      ...environment,
      CONVERSATION_ENABLED: "true",
      CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
      CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/conversation-runtime",
      TRANSCRIPTION_PROVIDER: "voicetext",
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
      VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
      MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED: "true",
      MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_EPOCH: "grounded-voice-v1",
      MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_STATE_FILE: rolloutStatePath,
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
    }, async () => "value");
    expect(enabled.meetingKnowledge?.groundedVoice).toEqual({
      rolloutEpoch: "grounded-voice-v1",
      rolloutStateFile: rolloutStatePath,
    });

    await expect(loadPlatformConfig({
      ...environment,
      MEETING_KNOWLEDGE_GROUNDED_VOICE_ENABLED: "true",
      MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_EPOCH: "grounded-voice-v1",
      MEETING_KNOWLEDGE_GROUNDED_VOICE_ROLLOUT_STATE_FILE: rolloutStatePath,
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
    }, async () => "value")).rejects.toThrow(
      "grounded voice requires conversation runtime",
    );
  });
});
