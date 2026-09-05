import { describe, expect, it } from "vitest";

import { loadPlatformConfig } from "../src/config.js";
import { createPlatformSubscriptionRuntimeResources } from
  "../src/composition/core-resources.js";
import { platformTestEnvironment as environment } from "./config-test-environment.js";

describe("platform conversation and provider configuration", () => {
  it("keeps providerless core composition explicitly free of a runtime transport", async () => {
    const configured = await loadPlatformConfig({
      ...environment,
      SUBSCRIPTION_RUNTIME_ADDRESS: undefined,
      SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: undefined,
      SUBSCRIPTION_RUNTIME_TOKEN_FILE: undefined,
    }, async () => "fixture");

    expect(
      createPlatformSubscriptionRuntimeResources(configured, {} as never),
    ).toBeUndefined();
  });

  it("constructs the hosted transport only from a complete validated custody set", async () => {
    const configured = await loadPlatformConfig({
      ...environment,
      SUMMARY_PROVIDER: "subscription-runtime",
    }, async () => "subscription-runtime-service-token");

    const runtime = createPlatformSubscriptionRuntimeResources(
      configured,
      { info() {} } as never,
    );
    expect(runtime).toBeDefined();
    runtime?.rawTransport.close();
  });

  it("admits ordinary Voicetext live captions without hosted runtime custody", async () => {
    const configured = await loadPlatformConfig({
      ...environment,
      SUBSCRIPTION_RUNTIME_ADDRESS: undefined,
      SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: undefined,
      SUBSCRIPTION_RUNTIME_TOKEN_FILE: undefined,
      TRANSCRIPTION_PROVIDER: "voicetext",
      TRANSCRIPTION_LEGACY_EXECUTION_BINDING: "voicetext-batch-v2:deepgram-nova-3",
      VOICETEXT_LIVE_ENABLED: "true",
      VOICETEXT_SERVICE_TOKEN_FILE: "/run/secrets/voicetext",
      VOICETEXT_WS_URL: "wss://voicetext.test/api/v1/transcribe/stream",
    }, async (path) => `fixture:${path}`);

    expect(configured.voicetext?.liveEnabled).toBe(true);
    expect(configured.subscriptionRuntime).toBeUndefined();
    expect(configured.secrets.subscriptionRuntimeToken).toBeUndefined();
  });

  it("requires the complete runtime custody set only for hosted summaries", async () => {
    await expect(loadPlatformConfig({
      ...environment,
      SUMMARY_PROVIDER: "subscription-runtime",
      SUBSCRIPTION_RUNTIME_ADDRESS: undefined,
      SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: undefined,
      SUBSCRIPTION_RUNTIME_TOKEN_FILE: undefined,
    }, async () => "fixture")).rejects.toThrow(
      "SUBSCRIPTION_RUNTIME_ADDRESS is required",
    );
  });

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
