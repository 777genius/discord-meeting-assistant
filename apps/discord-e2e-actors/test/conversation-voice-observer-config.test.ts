import { describe, expect, it } from "vitest";

import { loadConversationVoiceObserverConfig } from "../src/conversation-voice-observer-config.js";

const requiredEnvironment = {
  DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID: "attempt-2026-08-04-01",
  DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID: "1533224474609057793",
  DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: "1000",
  DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID: "11111111111111111",
  DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID: "22222222222222222",
  DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: "/tmp/conversation-voice-observer.json",
  DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD: "private-test-guild",
  DISCORD_E2E_CONVERSATION_VOICE_PURPOSE: "addressed-answer",
  DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID: "recording-2026-08-04-01",
  DISCORD_E2E_CONVERSATION_VOICE_RUN_ID: "conversation-run-2026-08-04",
  DISCORD_E2E_CONVERSATION_VOICE_TURN_ID: "turn-2026-08-04-01",
  DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID: "33333333333333333",
} as const;

describe("loadConversationVoiceObserverConfig", () => {
  it("requires explicit private-test correlation and uses only safe secret coordinates", () => {
    expect(loadConversationVoiceObserverConfig(requiredEnvironment)).toEqual({
      additionalCaptures: [],
      attemptId: "attempt-2026-08-04-01",
      captureTimeoutMilliseconds: 60_000,
      craigBotId: "1533224474609057793",
      expectedDurationMilliseconds: 1_000,
      expectedDurationToleranceMilliseconds: 500,
      guildId: "11111111111111111",
      keychainService: "discord-voice-bot-e2e",
      maxPcmBytes: 11_520_000,
      observerAccount: "conversation-observer",
      observerApplicationId: "22222222222222222",
      outputPath: "/tmp/conversation-voice-observer.json",
      privateTestGuildConfirmed: true,
      purpose: "addressed-answer",
      readyTimeoutMilliseconds: 60_000,
      recordingId: "recording-2026-08-04-01",
      runId: "conversation-run-2026-08-04",
      secretDirectory: undefined,
      turnId: "turn-2026-08-04-01",
      voiceChannelId: "33333333333333333",
    });
  });

  it("accepts a private file-secret coordinate but never a token environment field", () => {
    const config = loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_ACCOUNT: "observer-test",
      DISCORD_E2E_CONVERSATION_VOICE_SECRET_DIRECTORY: "/run/secrets/discord-e2e",
    });

    expect(config.secretDirectory).toBe("/run/secrets/discord-e2e");
    expect(config.observerAccount).toBe("observer-test");
    expect("token" in config).toBe(false);
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_TOKEN: "must-not-be-consumed",
    })).toThrow("does not accept bot tokens");
  });

  it("allows a first-join capture to remain unbound until retained collection", () => {
    const {
      DISCORD_E2E_CONVERSATION_VOICE_RECORDING_ID: _,
      ...beforeRecordingId
    } = requiredEnvironment;

    expect(loadConversationVoiceObserverConfig(beforeRecordingId).recordingId).toBeNull();
  });

  it("allows a long playback readiness wait without widening the audio capture window", () => {
    const config = loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS: "2000",
      DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS: "120000",
    });

    expect(config.captureTimeoutMilliseconds).toBe(2_000);
    expect(config.readyTimeoutMilliseconds).toBe(120_000);
    expect(loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS: "1000",
    }).readyTimeoutMilliseconds).toBe(1_000);
  });

  it("accepts a create-only capture sequence and rejects ambiguous correlations", () => {
    const additionalCaptures = [
      {
        attemptId: "attempt-2026-08-04-02",
        outputPath: "/tmp/conversation-voice-observer-2.json",
        purpose: "farewell",
        turnId: "meeting-farewell:v1",
      },
    ];
    expect(loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON:
        JSON.stringify(additionalCaptures),
    }).additionalCaptures).toEqual(additionalCaptures);
    const dynamicCapture = {
      attemptId: "attempt-2026-08-04-03",
      outputPath: "/tmp/conversation-voice-observer-3.json",
      purpose: "addressed-answer",
      turnIdFile: "/tmp/conversation-voice-turn-3.txt",
    };
    expect(loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON:
        JSON.stringify([dynamicCapture]),
    }).additionalCaptures).toEqual([dynamicCapture]);
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: "not-json",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...additionalCaptures[0],
        turnIdFile: "/tmp/conversation-voice-turn-2.txt",
      }]),
    })).toThrow("exactly one of turnId or turnIdFile");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        attemptId: "attempt-2026-08-04-02",
        outputPath: "/tmp/conversation-voice-observer-2.json",
        purpose: "addressed-answer",
      }]),
    })).toThrow("exactly one of turnId or turnIdFile");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...dynamicCapture,
        turnIdFile: "conversation-voice-turn-3.txt",
      }]),
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([
        dynamicCapture,
        {
          ...dynamicCapture,
          attemptId: "attempt-2026-08-04-04",
          outputPath: "/tmp/conversation-voice-observer-4.json",
        },
      ]),
    })).toThrow("turn ID file paths must be unique");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([
        dynamicCapture,
        {
          ...dynamicCapture,
          attemptId: "attempt-2026-08-04-04",
          outputPath: "/tmp/conversation-voice-observer-4.json",
          turnIdFile: "/tmp/./conversation-voice-turn-3.txt",
        },
      ]),
    })).toThrow("turn ID file paths must be unique");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...dynamicCapture,
        turnIdFile: requiredEnvironment.DISCORD_E2E_CONVERSATION_VOICE_OUTPUT,
      }]),
    })).toThrow("distinct from evidence output paths");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...additionalCaptures[0],
        attemptId: requiredEnvironment.DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID,
      }]),
    })).toThrow("attempt IDs must be unique");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...additionalCaptures[0],
        outputPath: requiredEnvironment.DISCORD_E2E_CONVERSATION_VOICE_OUTPUT,
      }]),
    })).toThrow("output paths must be unique");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify(
        Array.from({ length: 16 }, (_unused, index) => ({
          ...additionalCaptures[0],
          attemptId: `attempt-extra-${index}`,
          outputPath: `/tmp/conversation-voice-observer-extra-${index}.json`,
        })),
      ),
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...additionalCaptures[0],
        outputPath: "conversation-voice-observer-2.json",
      }]),
    })).toThrow();
  });

  it("fails closed for non-private targets, missing correlations, and unsafe output paths", () => {
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD: "yes",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: "conversation-voice-observer.json",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: "/",
    })).toThrow();
  });

  it("rejects impossible duration, PCM, bot-identity, and secret-account combinations", () => {
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: "59900",
      DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_TOLERANCE_MS: "500",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS: "999",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS: "999",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_READY_TIMEOUT_MS: "120001",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS: "1000",
      DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: "2000",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_MAX_PCM_BYTES: "3840",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID: "22222222222222222",
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_ACCOUNT: "observer_token",
    })).toThrow();
  });
});
