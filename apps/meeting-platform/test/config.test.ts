import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { INFINITY_CONTEXT_SDK_PROVENANCE } from "@discord-meeting/infinity-context-adapter";

import { loadPlatformConfig } from "../src/config.js";

const environment = {
  BIND_ADDRESS: "127.0.0.1",
  CRAIG_BEARER_TOKEN_FILE: "/run/secrets/craig",
  DISCORD_APPLICATION_ID: "1533224474609057793",
  DISCORD_BOTIK_APPLICATION_ID: "1533224474609057798",
  DISCORD_CRAIG_APPLICATION_ID: "1533224474609057794",
  DISCORD_LEGACY_GUILD_ID: "1533224474609057795",
  DISCORD_LEGACY_VOICE_CHANNEL_ID: "1533224474609057796",
  DISCORD_RESULTS_CHANNEL_ID: "1533228891827736657",
  DISCORD_TOKEN_FILE: "/run/secrets/discord",
  MEETING_KNOWLEDGE_PRINCIPAL_KEY_FILE:
    "/run/secrets/meeting-knowledge-principal-key",
  NODE_ENV: "test",
  PORT: "4310",
  POSTGRES_URL_FILE: "/run/secrets/postgres",
  RECORDING_SPOOL_ROOT: "/var/lib/discord-meeting/spool",
  REDIS_URL_FILE: "/run/secrets/redis",
  S3_ACCESS_KEY_ID_FILE: "/run/secrets/s3-access",
  S3_BUCKET: "discord-meeting",
  S3_ENDPOINT: "http://object-storage:8333",
  S3_PREFIX: "recordings/",
  S3_REGION: "us-east-1",
  S3_SECRET_ACCESS_KEY_FILE: "/run/secrets/s3-secret",
  SPEACHES_BASE_URL: "http://speaches:8000",
  SPEACHES_MODEL: "Systran/faster-whisper-small",
  SUBSCRIPTION_RUNTIME_ADDRESS: "subscription-runtime-sidecar:50052",
  SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: "a".repeat(64),
  SUBSCRIPTION_RUNTIME_TOKEN_FILE: "/run/secrets/runtime",
  TRANSCRIPTION_PROVIDER: "speaches",
} as const;

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
    async () => "c".repeat(40));

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

  it("loads production search only with the nested retained r79 semantic attestation", async () => {
    const activation = JSON.stringify({
      apiVersion: "v1",
      archiveSha256: INFINITY_CONTEXT_SDK_PROVENANCE.archiveSha256,
      environment: "production",
      immutablePackageIntegrity: INFINITY_CONTEXT_SDK_PROVENANCE.immutablePackageIntegrity,
      indexingEnabled: true,
      packageSource: "immutable_package",
      productionEmbeddingProfileAttestation: {
        embeddingProfile:
          "local-open-source-paraphrase-multilingual-minilm-l12-v2-hybrid-bm25.r73",
        embeddingProfileDigestSha256:
          "sha256:5ecd36edd098940cd8a6540509f90815ddc1802b4410ced2bf063c0f8c650cac",
        productionSemanticQualification: true,
        qualificationManifestSha256:
          INFINITY_CONTEXT_SDK_PROVENANCE
            .retainedProductionSemanticQualificationManifestSha256,
        releaseRevision:
          INFINITY_CONTEXT_SDK_PROVENANCE.retainedProductionSemanticReleaseRevision,
        schemaVersion: 1,
      },
      qualificationManifestSha256:
        INFINITY_CONTEXT_SDK_PROVENANCE.retainedLiveQualificationManifestSha256,
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
    async () => "c".repeat(40));

    expect(configured.infinityContext?.activation).toMatchObject({
      environment: "production",
      productionEmbeddingProfileAttestation: {
        productionSemanticQualification: true,
        qualificationManifestSha256:
          INFINITY_CONTEXT_SDK_PROVENANCE
            .retainedProductionSemanticQualificationManifestSha256,
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
      async () => "c".repeat(40),
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
    }, async () => "value", async () => actualRevision);

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
    expect(config.voicetext?.liveMaxConcurrentSessions).toBe(10);
    expect(config.voicetext?.livePacketBackpressureTimeoutMs).toBe(2_000);

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

describe("platform conversation and provider configuration", () => {
  it("does not read a conversation secret while conversation is disabled", async () => {
    const readPaths: string[] = [];
    const config = await loadPlatformConfig(
      {
        ...environment,
        CONVERSATION_ENABLED: "false",
        CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
        CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/not-mounted",
        CONVERSATION_THINKING_CUE_ROOT: "/unused/thinking-cues",
        CONVERSATION_VOICE_PROFILE_ID: "local-russian",
      },
      async (path) => {
        readPaths.push(path);
        return `value-for:${path}`;
      },
    );

    expect(config.conversation).toBeUndefined();
    expect(config.secrets.conversationRuntimeToken).toBeUndefined();
    expect(readPaths).not.toContain("/run/secrets/not-mounted");
  });

  it("fails closed on incomplete or production fake conversation profiles", async () => {
    await expect(
      loadPlatformConfig(
        { ...environment, CONVERSATION_ENABLED: "true" },
        async () => "value",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          CONVERSATION_ENABLED: "true",
          CONVERSATION_RUNTIME_ADDRESS: "pipecat-runtime:50053",
          CONVERSATION_RUNTIME_TOKEN_FILE: "/run/secrets/conversation-runtime",
          NODE_ENV: "production",
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "value",
      ),
    ).rejects.toThrow("deterministic E2E voice profiles are forbidden in production");
  });

  it("requires secure complete Voicetext configuration", async () => {
    await expect(
      loadPlatformConfig(
        { ...environment, TRANSCRIPTION_PROVIDER: "voicetext" },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS: "0",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_LIVE_MAX_CONCURRENT_SESSIONS: "11",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_LIVE_PACKET_BACKPRESSURE_TIMEOUT_MS: "99",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_CONCURRENT_MEETINGS: "3",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "ws://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
  });

  it("rejects unknown environment input and credential-bearing endpoints", async () => {
    await expect(
      loadPlatformConfig(
        { ...environment, OPENAI_API_KEY: "forbidden" },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        { ...environment, SPEACHES_BASE_URL: "http://user:pass@speaches:8000" },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_ARTIFACT_BYTES: String(64 * 1_024 * 1_024 + 1),
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_CONCURRENCY: "0",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
    await expect(
      loadPlatformConfig(
        {
          ...environment,
          TRANSCRIPTION_PROVIDER: "voicetext",
          VOICETEXT_BATCH_MAX_CONCURRENCY: "11",
          VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
          VOICETEXT_WS_URL: "wss://api.voicetext.site/api/v1/transcribe/stream",
        },
        async () => "x",
      ),
    ).rejects.toThrow();
  });
});
