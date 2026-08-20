import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { INFINITY_CONTEXT_SDK_PROVENANCE } from "@discord-meeting/infinity-context-adapter";

import { loadPlatformConfig } from "../src/config.js";
import { participantSpeakerAliases } from
  "../src/config/participant-greeting-profiles.js";
import { platformTestEnvironment as environment } from "./config-test-environment.js";

function buildProvenance(releaseRevision = "c".repeat(40)) {
  return {
    releaseRevision,
    schemaVersion: 1 as const,
    sourceTree: "d".repeat(40),
    sourceTreeSha256: "e".repeat(64),
  };
}

describe("platform configuration", () => {
  it("keeps the standard deployment wired to the complete fail-closed Infinity contract", async () => {
    const compose = await readFile(
      new URL("../../../infra/deployment/compose.yaml", import.meta.url),
      "utf8",
    );

    expect(compose).toContain(
      "INFINITY_CONTEXT_ACTIVATION: ${INFINITY_CONTEXT_ACTIVATION:?set reviewed Infinity Context activation JSON}",
    );
    expect(compose).toContain(
      "INFINITY_CONTEXT_URL: ${INFINITY_CONTEXT_URL:?set reachable Infinity Context service URL}",
    );
    expect(compose).toContain(
      "INFINITY_CONTEXT_TOKEN_FILE: /run/secrets/infinity-context-token",
    );
    expect(compose).toContain(
      "INFINITY_CONTEXT_TOPOLOGY_KEY_FILE: /run/secrets/infinity-context-topology-key",
    );
    expect(compose).toContain(
      "INFINITY_CONTEXT_REQUEST_TIMEOUT_MS: ${INFINITY_CONTEXT_REQUEST_TIMEOUT_MS:-10000}",
    );
    expect(compose).toContain(
      "INFINITY_CONTEXT_OPERATION_TIMEOUT_MS: ${INFINITY_CONTEXT_OPERATION_TIMEOUT_MS:-300000}",
    );
    expect(compose).not.toContain("MEETING_KNOWLEDGE_TWO_HOUR_HISTORICAL_ENABLED");
  });

  it("loads Infinity activation only as a complete versioned provenance-bound set", async () => {
    const activation = JSON.stringify({
      apiVersion: "v1",
      archiveSha256: INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256,
      environment: "test",
      immutablePackageIntegrity: null,
      indexingEnabled: true,
      packageSource: "reviewed_source_workspace",
      qualificationManifestSha256: null,
      schemaVersion: 1,
      sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
      sdkTree: INFINITY_CONTEXT_SDK_PROVENANCE.tree,
      searchEnabled: true,
      serviceName: "disposable-infinity-context",
      servingProfile: "same_room_retrieval",
    });
    const configured = await loadPlatformConfig({
      ...environment,
      INFINITY_CONTEXT_ACTIVATION: activation,
      INFINITY_CONTEXT_TOKEN_FILE: "/run/secrets/infinity-token",
      INFINITY_CONTEXT_TOPOLOGY_KEY_FILE: "/run/secrets/infinity-topology",
      INFINITY_CONTEXT_URL: "http://infinity-context:7788",
    }, async (path) => path.endsWith("topology") ? "t".repeat(32) : `fixture:${path}`,
    async () => buildProvenance());

    expect(configured.infinityContext?.activation).toMatchObject({
      indexingEnabled: true,
      sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
    });
    expect(configured.secrets.infinityContextTopologyKey).toBe("t".repeat(32));
    await expect(loadPlatformConfig({
      ...environment,
      INFINITY_CONTEXT_ACTIVATION: activation,
    }, async () => "fixture-value" )).rejects.toThrow("configured together");
  });

  it("loads production search only with the source-pinned profile and instance echo", async () => {
    const activation = JSON.stringify({
      apiVersion: "v1",
      archiveSha256: INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256,
      environment: "production",
      immutablePackageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
      indexingEnabled: true,
      packageSource: "immutable_package",
      embeddingProfileAttestation: {
        embeddingProfile:
          INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId,
        embeddingProfileDigestSha256:
          `sha256:${"a".repeat(64)}`,
        schemaVersion: 1,
      },
      qualificationManifestSha256:
        INFINITY_CONTEXT_SDK_PROVENANCE.retainedExactHeadQualificationManifestSha256,
      schemaVersion: 1,
      sdkCommit: INFINITY_CONTEXT_SDK_PROVENANCE.commit,
      sdkTree: INFINITY_CONTEXT_SDK_PROVENANCE.tree,
      searchEnabled: true,
      serviceName: "infinity-context",
      servingProfile: "same_room_retrieval",
    });
    const configured = await loadPlatformConfig({
      ...environment,
      INFINITY_CONTEXT_ACTIVATION: activation,
      INFINITY_CONTEXT_TOKEN_FILE: "/run/secrets/infinity-token",
      INFINITY_CONTEXT_TOPOLOGY_KEY_FILE: "/run/secrets/infinity-topology",
      INFINITY_CONTEXT_URL: "http://infinity-context:7788",
      NODE_ENV: "production",
    }, async (path) => path.endsWith("topology") ? "t".repeat(32) : `fixture:${path}`,
    async () => buildProvenance());

    expect(configured.infinityContext?.activation).toMatchObject({
      environment: "production",
      embeddingProfileAttestation: {
        embeddingProfile: INFINITY_CONTEXT_SDK_PROVENANCE.sourcePinnedEmbeddingProfileId,
      },
      searchEnabled: true,
    });
  });

  it("enables playback readiness only for a complete explicit test-only deployment", async () => {
    const conversationEnvironment = {
      ...environment,
      CONVERSATION_ENABLED: "true",
      CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
      CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/conversation-runtime",
      CONVERSATION_VOICE_PROFILE_ID: "qualified-test-voice",
      TRANSCRIPTION_PROVIDER: "voicetext",
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
      VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
    } as const;
    const configured = await loadPlatformConfig({
      ...conversationEnvironment,
      CONVERSATION_E2E_PLAYBACK_READINESS_ROOT: "/var/lib/e2e/answer-run",
      CONVERSATION_E2E_GREETING_OBSERVER_PARTICIPANT_ID: "1533867700575670282",
      CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT: "/var/lib/e2e/greeting-run",
      CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID: "run-1",
      CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS: "30000",
      E2E_TEST_ONLY_LABEL: "true",
    }, async () => "value");
    expect(configured.conversation?.playbackReadiness).toEqual({
      greetingObserverParticipantId: "1533867700575670282",
      greetingRoot: "/var/lib/e2e/greeting-run",
      root: "/var/lib/e2e/answer-run", runId: "run-1", timeoutMilliseconds: 30_000,
    });
    await expect(loadPlatformConfig({
      ...conversationEnvironment,
      CONVERSATION_E2E_PLAYBACK_READINESS_ROOT: "/var/lib/e2e/answer-run",
      CONVERSATION_E2E_PLAYBACK_READINESS_RUN_ID: "run-1",
      CONVERSATION_E2E_PLAYBACK_READINESS_TIMEOUT_MS: "30000",
    }, async () => "value")).rejects.toThrow("explicitly test-only");
    await expect(loadPlatformConfig({
      ...conversationEnvironment,
      CONVERSATION_E2E_PLAYBACK_READINESS_ROOT: "/var/lib/e2e/answer-run",
      E2E_TEST_ONLY_LABEL: "true",
    }, async () => "value")).rejects.toThrow("configured together");
  });

  it("loads every secret through the file reader and never requires an API key", async () => {
    const paths: string[] = [];
    const config = await loadPlatformConfig(environment, async (path) => {
      paths.push(path);
      return `value-for:${path}`;
    });

    expect(paths).toHaveLength(7);
    expect(config.secrets.discordToken).toBe("value-for:/run/secrets/discord");
    expect(config.discordFinalPublicationMode).toBe("separate-message");
    expect(config.discordPublicationMode).toBe("message");
    expect(config.discordBotikApplicationId).toBe("1533224474609057798");
    expect(Object.keys(environment)).not.toContain("OPENAI_API_KEY");
  });

  it("requires explicit historical transcription provenance", async () => {
    const { TRANSCRIPTION_LEGACY_EXECUTION_BINDING: _, ...withoutLegacyBinding } = environment;
    await expect(loadPlatformConfig(withoutLegacyBinding, async () => "value"))
      .rejects.toThrow("TRANSCRIPTION_LEGACY_EXECUTION_BINDING");
  });

  it("falls back to the Craig identity when playback uses the same Discord bot", async () => {
    const legacyEnvironment = {
      ...environment,
      DISCORD_BOTIK_APPLICATION_ID: undefined,
    };
    const config = await loadPlatformConfig(legacyEnvironment, async () => "value");

    expect(config.discordBotikApplicationId).toBe(
      legacyEnvironment.DISCORD_CRAIG_APPLICATION_ID,
    );
  });

  it("publishes final summaries separately by default and accepts live replacement opt-in", async () => {
    const separate = await loadPlatformConfig(environment, async () => "value");
    const replacement = await loadPlatformConfig(
      { ...environment, DISCORD_FINAL_PUBLICATION_MODE: "replace-live" },
      async () => "value",
    );

    expect(separate.discordFinalPublicationMode).toBe("separate-message");
    expect(replacement.discordFinalPublicationMode).toBe("replace-live");
    await expect(
      loadPlatformConfig(
        { ...environment, DISCORD_FINAL_PUBLICATION_MODE: "append" },
        async () => "value",
      ),
    ).rejects.toThrow();
  });

  it("keeps Local Final Reply disabled unless direct publication and its secret are explicit", async () => {
    const principalKeyPath = "/run/secrets/meeting-knowledge-principal-key";
    const maintenanceOnly = await loadPlatformConfig({
      ...environment,
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "false",
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: undefined,
    }, async () => "value");
    expect(maintenanceOnly.meetingKnowledge).toBeUndefined();
    expect(maintenanceOnly.secrets.meetingKnowledgePrincipalKey).toBeUndefined();
    const config = await loadPlatformConfig({
      ...environment,
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
    }, async (path) => `value-for:${path}`);

    expect(config.meetingKnowledge).toEqual({ localFinalReply: true });
    expect(config.secrets.meetingKnowledgePrincipalKey)
      .toBe(`value-for:${principalKeyPath}`);
    await expect(loadPlatformConfig({
      ...environment,
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: undefined,
    }, async () => "value")).rejects.toThrow(
      "local final reply requires MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE",
    );
    await expect(loadPlatformConfig({
      ...environment,
      DISCORD_PUBLICATION_MODE: "thread",
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE: principalKeyPath,
    }, async () => "value")).rejects.toThrow(
      "local final reply currently requires direct-message publication mode",
    );
  });

});

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

  it("rejects configured greeting profiles while live conversation is disabled", async () => {
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
      "participant greeting profiles require live conversation to be enabled",
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

describe("platform configuration routing and conversation", () => {
  it("uses direct channel publication by default and accepts explicit legacy threads", async () => {
    const direct = await loadPlatformConfig(environment, async () => "value");
    const thread = await loadPlatformConfig(
      { ...environment, DISCORD_PUBLICATION_MODE: "thread" },
      async () => "value",
    );

    expect(direct.discordPublicationMode).toBe("message");
    expect(thread.discordPublicationMode).toBe("thread");
    await expect(
      loadPlatformConfig(
        { ...environment, DISCORD_PUBLICATION_MODE: "channel" },
        async () => "value",
      ),
    ).rejects.toThrow();
  });

  it("accepts only a guild-bound legacy publication fallback", async () => {
    const config = await loadPlatformConfig(
      {
        ...environment,
        DISCORD_LEGACY_GUILD_ID: "1533224474609057795",
        DISCORD_LEGACY_VOICE_CHANNEL_ID: "1533224474609057796",
      },
      async () => "value",
    );
    expect(config.discordLegacyRoute).toEqual({
      guildId: "1533224474609057795",
      publicationTargetId: "1533228891827736657",
      voiceChannelId: "1533224474609057796",
    });
    const selfService = await loadPlatformConfig(
      {
        ...environment,
        DISCORD_LEGACY_GUILD_ID: "",
        DISCORD_LEGACY_VOICE_CHANNEL_ID: "",
        DISCORD_RESULTS_CHANNEL_ID: "",
      },
      async () => "value",
    );
    expect(selfService.discordLegacyRoute).toBeUndefined();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          DISCORD_LEGACY_VOICE_CHANNEL_ID: "",
          DISCORD_RESULTS_CHANNEL_ID: "",
        },
        async () => "value",
      ),
    ).rejects.toThrow();
  });

  it("loads recording playback only from a complete secret-backed HTTPS configuration", async () => {
    const paths: string[] = [];
    const config = await loadPlatformConfig(
      {
        ...environment,
        NODE_ENV: "production",
        RECORDING_PLAYBACK_PUBLIC_BASE_URL: "https://recordings.example.com",
        RECORDING_PLAYBACK_SIGNING_SECRET_FILE: "/run/secrets/recording-playback",
      },
      async (path) => {
        paths.push(path);
        return `value-for:${path}`;
      },
      async () => buildProvenance(),
    );

    expect(config.recordingPlayback).toEqual({
      publicBaseUrl: "https://recordings.example.com",
    });
    expect(config.secrets.recordingPlaybackSigningSecret).toBe(
      "value-for:/run/secrets/recording-playback",
    );
    expect(paths).toContain("/run/secrets/recording-playback");

    await expect(loadPlatformConfig({
      ...environment,
      RECORDING_PLAYBACK_PUBLIC_BASE_URL: "https://recordings.example.com",
    }, async () => "value")).rejects.toThrow("configured together");
    await expect(loadPlatformConfig({
      ...environment,
      RECORDING_PLAYBACK_SIGNING_SECRET_FILE: "/run/secrets/recording-playback",
    }, async () => "value")).rejects.toThrow("configured together");
    await expect(loadPlatformConfig({
      ...environment,
      NODE_ENV: "production",
      RECORDING_PLAYBACK_PUBLIC_BASE_URL: "http://recordings.example.com",
      RECORDING_PLAYBACK_SIGNING_SECRET_FILE: "/run/secrets/recording-playback",
    }, async () => "value")).rejects.toThrow("requires HTTPS");
  });

  it("uses the immutable build artifact even when runtime environment spoofs SOURCE_REVISION", async () => {
    const actualRevision = "c".repeat(40);
    const config = await loadPlatformConfig({
      ...environment,
      NODE_ENV: "production",
      SOURCE_REVISION: "a".repeat(40),
    }, async () => "value", async () => buildProvenance(actualRevision));

    expect(config.sourceRevision).toBe(actualRevision);
  });

  it("loads a Voicetext machine bearer only from a secret file", async () => {
    const config = await loadPlatformConfig(
      {
        ...environment,
        TRANSCRIPTION_PROVIDER: "voicetext",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
        VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        VOICETEXT_BATCH_MAX_CONCURRENCY: "6",
        VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS: "2",
        VOICETEXT_LIVE_MAX_CONCURRENT_SESSIONS: "10",
        VOICETEXT_LIVE_PACKET_BACKPRESSURE_TIMEOUT_MS: "2000",
      },
      async (path) => `value-for:${path}`,
    );

    expect(config.transcriptionProvider).toBe("voicetext");
    expect(config.secrets.voicetextServiceToken).toBe(
      "value-for:/run/secrets/voicetext",
    );
    expect(config.voicetext?.webSocketUrl).toBe(
      "wss://api.voicetext.site/api/v1/transcribe/stream",
    );
    expect(config.voicetext?.batchMaxArtifactBytes).toBe(64 * 1_024 * 1_024);
    expect(config.voicetext?.batchMaxConcurrency).toBe(6);
    expect(config.voicetext?.batchMaxConcurrentMeetings).toBe(2);
    expect(config.voicetext?.batchProfile).toBe("deepgram-nova-3");
    expect(config.voicetext?.liveMaxConcurrentSessions).toBe(10);
    expect(config.voicetext?.livePacketBackpressureTimeoutMs).toBe(2_000);
    expect(config.voicetext?.liveProfile).toBe("deepgram-nova-3");

    const defaults = await loadPlatformConfig(
      {
        ...environment,
        TRANSCRIPTION_PROVIDER: "voicetext",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
        VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
      },
      async () => "value",
    );
    expect(defaults.voicetext?.batchMaxConcurrentMeetings).toBe(1);
    expect(defaults.voicetext?.liveMaxConcurrentSessions).toBe(3);
  });

  it("validates independent batch and live VoiceText profile selectors", async () => {
    const base = {
      ...environment,
      TRANSCRIPTION_PROVIDER: "voicetext",
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
      VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
    } as const;
    const batchProfiles = ["deepgram-nova-3", "elevenlabs-scribe-v2"] as const;
    const liveProfiles = ["deepgram-nova-3", "elevenlabs-scribe-v2-realtime"] as const;

    for (const batchProfile of batchProfiles) {
      for (const liveProfile of liveProfiles) {
        const config = await loadPlatformConfig({
          ...base,
          VOICETEXT_BATCH_PROFILE: batchProfile,
          VOICETEXT_LIVE_PROFILE: liveProfile,
        }, async () => "value");
        expect(config.voicetext).toMatchObject({ batchProfile, liveProfile });
      }
    }

    await expect(loadPlatformConfig({
      ...base,
      VOICETEXT_BATCH_PROFILE: "elevenlabs-scribe-v2-realtime",
    }, async () => "value")).rejects.toThrow();
    await expect(loadPlatformConfig({
      ...base,
      VOICETEXT_LIVE_PROFILE: "elevenlabs-scribe-v2",
    }, async () => "value")).rejects.toThrow();
  });

  it("loads provider-neutral live conversation config only from complete secret-backed input", async () => {
    const config = await loadPlatformConfig(
      {
        ...environment,
        CONVERSATION_ENABLED: "true",
        CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
        CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/conversation-runtime",
        CONVERSATION_THINKING_CUE_ROOT: "/test/thinking-cues",
        CONVERSATION_VOICE_ID: "test-voice-id",
        CONVERSATION_VOICE_PROFILE_ID: "deterministic-e2e-ru",
        TRANSCRIPTION_PROVIDER: "voicetext",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
        VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
      },
      async (path) => `value-for:${path}`,
    );

    expect(config.conversation).toEqual({
      farewellCueRoot: "/app/apps/meeting-platform/assets/farewell-cues",
      greetingCueRoot: "/app/apps/meeting-platform/assets/greeting-cues",
      runtimeAddress: "pipecat-runtime:50053",
      systemPrompt:
        "You are Botik, a concise voice assistant. Answer in the participant's language. When that language uses grammatical gender, refer to yourself using feminine forms. Never claim to remember earlier turns.",
      thinkingCueRoot: "/test/thinking-cues",
      voiceId: "test-voice-id",
      voiceProfileId: "deterministic-e2e-ru",
    });
    expect(config.secrets.conversationRuntimeToken).toBe(
      "value-for:/run/secrets/conversation-runtime",
    );
  });

  it("defaults an absolute cue root only for enabled conversation", async () => {
    const config = await loadPlatformConfig(
      {
        ...environment,
        CONVERSATION_ENABLED: "true",
        CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
        CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/conversation-runtime",
        TRANSCRIPTION_PROVIDER: "voicetext",
        VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
        VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
      },
      async () => "value",
    );

    expect(config.conversation?.thinkingCueRoot).toBe(
      "/app/apps/meeting-platform/assets/thinking-cues",
    );
    expect(config.conversation?.greetingCueRoot).toBe(
      "/app/apps/meeting-platform/assets/greeting-cues",
    );
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          CONVERSATION_ENABLED: "true",
          CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
          CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/conversation-runtime",
          CONVERSATION_THINKING_CUE_ROOT: "relative/cues",
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "value",
      ),
    ).rejects.toThrow();
  });
});
