import { describe, expect, it } from "vitest";

import { loadPlatformConfig } from "../src/config.js";
import { platformTestEnvironment as environment } from "./config-test-environment.js";

function buildProvenance(releaseRevision = "c".repeat(40)) {
  return {
    releaseRevision,
    schemaVersion: 1 as const,
    sourceTree: "d".repeat(40),
    sourceTreeSha256: "e".repeat(64),
  };
}

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
