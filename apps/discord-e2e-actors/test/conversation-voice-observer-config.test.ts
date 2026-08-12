import { describe, expect, it } from "vitest";

import { loadConversationVoiceObserverConfig } from "../src/conversation-voice-observer-config.js";

const requiredEnvironment = {
  DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID: "attempt-2026-08-04-01",
  DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID: "1533224474609057793",
  DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: "1000",
  DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID: "11111111111111111",
  DISCORD_E2E_CONVERSATION_VOICE_MEETING_ID: "meeting-2026-08-04-01",
  DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID: "22222222222222222",
  DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: "/tmp/conversation-voice-observer.json",
  DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT: "/tmp/conversation-answer-handshake",
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
      meetingId: "meeting-2026-08-04-01",
      observerAccount: "conversation-observer",
      observerApplicationId: "22222222222222222",
      outputPath: "/tmp/conversation-voice-observer.json",
      playbackHandshakeRoot: "/tmp/conversation-answer-handshake",
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
        expectedDuration: { maximumMilliseconds: 2_500, minimumMilliseconds: 2_000 },
        outputPath: "/tmp/conversation-voice-observer-2.json",
        purpose: "farewell",
        turnId: "meeting-farewell:v1",
      },
    ];
    const dynamicCapture = {
      expectedDuration: { maximumMilliseconds: 3_500, minimumMilliseconds: 3_000 },
      outputPath: "/tmp/conversation-voice-observer-3.json",
      playbackHandshakeRoot: "/tmp/conversation-answer-handshake-3",
      purpose: "addressed-answer",
    };
    const campaignCaptures = [
      {
        attemptId: "attempt-2",
        expectedDuration: { maximumMilliseconds: 2_500, minimumMilliseconds: 2_000 },
        outputPath: "/tmp/capture-2.json",
        purpose: "greeting",
        turnId: "participant-greeting:1533227577286852649",
      },
      {
        attemptId: "attempt-3",
        expectedDuration: { maximumMilliseconds: 3_500, minimumMilliseconds: 3_000 },
        outputPath: "/tmp/capture-3.json",
        purpose: "greeting",
        turnId: "participant-greeting:1533228054724346087",
      },
      {
        attemptId: "attempt-4",
        expectedDuration: { maximumMilliseconds: 4_500, minimumMilliseconds: 4_000 },
        outputPath: "/tmp/capture-4.json",
        purpose: "greeting",
        turnId: "participant-greeting:1533873978417086474",
      },
      dynamicCapture,
      {
        attemptId: "attempt-6",
        expectedDuration: { maximumMilliseconds: 6_500, minimumMilliseconds: 6_000 },
        outputPath: "/tmp/capture-6.json",
        purpose: "farewell",
        turnId: "meeting-farewell:v1",
      },
    ];
    expect(loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID: "attempt-1",
      DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID: "1534231284467896512",
      DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: "1000",
      DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID: "1533228590643155034",
      DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID: "1533867700575670282",
      DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: "/tmp/capture-1.json",
      DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT: undefined,
      DISCORD_E2E_CONVERSATION_VOICE_PURPOSE: "greeting",
      DISCORD_E2E_CONVERSATION_VOICE_TURN_ID:
        "participant-greeting:1533867700575670282",
      DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID: "1533228823045214398",
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON:
        JSON.stringify(campaignCaptures),
      DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT: "/tmp/campaign-proof.json",
    }).additionalCaptures).toEqual(campaignCaptures);
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...additionalCaptures[0],
        playbackHandshakeRoot: "/tmp/conversation-answer-handshake-2",
      }]),
    })).toThrow();
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([
        dynamicCapture,
        {
          ...dynamicCapture,
          outputPath: "/tmp/conversation-voice-observer-4.json",
          playbackHandshakeRoot: "/tmp/conversation-answer-handshake-3",
        },
      ]),
    })).toThrow("handshake roots must be unique");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...dynamicCapture,
        playbackHandshakeRoot:
          requiredEnvironment.DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT,
      }]),
    })).toThrow("handshake roots must be unique");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_OUTPUT:
        requiredEnvironment.DISCORD_E2E_CONVERSATION_VOICE_PLAYBACK_HANDSHAKE_ROOT,
    })).toThrow("distinct from evidence output paths");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([
        dynamicCapture,
        {
          ...dynamicCapture,
          outputPath: "/tmp/conversation-voice-observer-4.json",
          playbackHandshakeRoot: "/tmp/parent/../conversation-answer-handshake-3",
        },
      ]),
    })).toThrow("handshake roots must be unique");
    expect(() => loadConversationVoiceObserverConfig({
      ...requiredEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([{
        ...dynamicCapture,
        playbackHandshakeRoot: requiredEnvironment.DISCORD_E2E_CONVERSATION_VOICE_OUTPUT,
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
