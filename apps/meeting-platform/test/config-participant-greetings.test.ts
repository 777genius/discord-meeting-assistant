import { describe, expect, it } from "vitest";

import { loadPlatformConfig } from "../src/config.js";
import { participantSpeakerAliases } from
  "../src/config/participant-greeting-profiles.js";
import { platformTestEnvironment as environment } from "./config-test-environment.js";

describe("participant greeting profile configuration", () => {
  it("defaults anonymous greetings to Russian and accepts English override", async () => {
    const defaultConfig = await loadPlatformConfig(environment, async () => "value");
    const englishConfig = await loadPlatformConfig(
      { ...environment, PARTICIPANT_GREETING_DEFAULT_LOCALE: "en" },
      async () => "value",
    );

    expect(defaultConfig.participantGreetingDefaultLocale).toBe("ru");
    expect(englishConfig.participantGreetingDefaultLocale).toBe("en");
    await expect(
      loadPlatformConfig(
        { ...environment, PARTICIPANT_GREETING_DEFAULT_LOCALE: "de" },
        async () => "value",
      ),
    ).rejects.toThrow();
  });

  it("loads canonical immutable participant greeting profiles keyed by Discord ID", async () => {
    const config = await loadPlatformConfig(
      {
        ...environment,
        CONVERSATION_ENABLED: "true",
        CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
        CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/conversation-runtime",
        PARTICIPANT_GREETING_PROFILES_JSON: JSON.stringify({
          "2533224474609057795": {
            displayName: "  Елена  ",
            greetingLocale: "ru",
            spokenName: "Лена",
          },
          "1533224474609057795": {
            displayName: "Alex",
            greetingLocale: "en",
            spokenName: "Alexander",
          },
        }),
        TRANSCRIPTION_PROVIDER: "voicetext",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
        VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
      },
      async () => "value",
    );

    expect(Object.keys(config.participantGreetingProfiles)).toEqual([
      "1533224474609057795",
      "2533224474609057795",
    ]);
    expect(config.participantGreetingProfiles["2533224474609057795"]).toEqual({
      displayName: "Елена",
      greetingLocale: "ru",
      spokenName: "Лена",
    });
    expect(participantSpeakerAliases(config.participantGreetingProfiles)).toEqual({
      "1533224474609057795": ["Alex", "Alexander"],
      "2533224474609057795": ["Елена", "Лена"],
    });
    expect(Object.isFrozen(config.participantGreetingProfiles)).toBe(true);
    expect(
      Object.isFrozen(
        config.participantGreetingProfiles["1533224474609057795"],
      ),
    ).toBe(true);
  });

  it("uses no participant greeting profiles when the optional JSON is missing or empty", async () => {
    const missing = await loadPlatformConfig(environment, async () => "value");
    const empty = await loadPlatformConfig(
      { ...environment, PARTICIPANT_GREETING_PROFILES_JSON: "  " },
      async () => "value",
    );

    expect(missing.participantGreetingProfiles).toEqual({});
    expect(empty.participantGreetingProfiles).toEqual({});
  });

  it("shares participant profiles with reply-only meeting knowledge", async () => {
    const principalKeyPath = "/run/secrets/meeting-knowledge-principal-key";
    const config = await loadPlatformConfig(
      {
        ...environment,
        MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
        MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
        PARTICIPANT_GREETING_PROFILES_JSON: JSON.stringify({
          "1533224474609057795": {
            displayName: "Alex",
            greetingLocale: "en",
            spokenName: "Alexander",
          },
        }),
      },
      async () => "value",
    );

    expect(participantSpeakerAliases(config.participantGreetingProfiles)).toEqual({
      "1533224474609057795": ["Alex", "Alexander"],
    });
    expect(config.conversation).toBeUndefined();
    expect(config.meetingKnowledge?.localFinalReply).toBe(true);
  });

  it("rejects configured profiles when neither consumer is enabled", async () => {
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          PARTICIPANT_GREETING_PROFILES_JSON: JSON.stringify({
            "1533224474609057795": {
              displayName: "Alex",
              greetingLocale: "en",
              spokenName: "Alexander",
            },
          }),
        },
        async () => "value",
      ),
    ).rejects.toThrow(
      "participant greeting profiles require live conversation or local final reply to be enabled",
    );
  });

  it.each([
    ["malformed JSON", '{"private-person-name"'],
    [
      "invalid Discord ID",
      JSON.stringify({
        "not-a-discord-id": {
          displayName: "Private Person",
          greetingLocale: "en",
          spokenName: "Private",
        },
      }),
    ],
    [
      "empty name",
      JSON.stringify({
        "1533224474609057795": {
          displayName: " ",
          greetingLocale: "en",
          spokenName: "Private",
        },
      }),
    ],
    [
      "unsupported locale",
      JSON.stringify({
        "1533224474609057795": {
          displayName: "Private Person",
          greetingLocale: "de",
          spokenName: "Private",
        },
      }),
    ],
    [
      "unknown profile field",
      JSON.stringify({
        "1533224474609057795": {
          displayName: "Private Person",
          greetingLocale: "en",
          nickname: "must-not-be-accepted",
          spokenName: "Private",
        },
      }),
    ],
  ])("rejects %s without exposing profile contents", async (_case, profiles) => {
    let failure: unknown;
    try {
      await loadPlatformConfig(
        { ...environment, PARTICIPANT_GREETING_PROFILES_JSON: profiles },
        async () => "value",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toMatch(
      /Private|not-a-discord-id|private-person-name|must-not-be-accepted/iu,
    );
  });
});
