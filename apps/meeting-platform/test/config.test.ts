import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { INFINITY_CONTEXT_SDK_PROVENANCE } from "@discord-meeting/infinity-context-adapter";

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

describe("platform configuration", () => {
  it("admits public-reply crash injection only in the complete test-only local-reply profile", async () => {
    const root = "/run/e2e-campaign/campaign-1/run-3";
    const configured = await loadPlatformConfig({
      ...environment, E2E_TEST_ONLY_LABEL: "true",
      MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_ROOT: root,
      MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_WORKER_ID: "worker_before_crash",
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
    }, async (path) => `fixture:${path}`);
    expect(configured.testOnly?.publicReplyCrashInjection).toEqual({
      root, workerId: "worker_before_crash",
    });
    await expect(loadPlatformConfig({
      ...environment,
      MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_ROOT: root,
      MEETING_KNOWLEDGE_E2E_PUBLIC_REPLY_CRASH_WORKER_ID: "worker_before_crash",
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
    }, async (path) => `fixture:${path}`)).rejects.toThrow("test-only local-final-reply");
  });

  it("loads an exact future-canary V2 provider binding without enabling serving", async () => {
    const binding = {
      capabilityFingerprint: "a".repeat(64), contractVersion: "context-retrieval.v2",
      indexProfileDigest: "b".repeat(64), profileId: "meeting-knowledge-v2",
      rankingPolicy: "weighted_rrf_canonical_preferences.v1",
      requiredProviderLanes: ["postgres_keyword", "qdrant_dense"],
      serviceRevision: "c".repeat(40),
    };
    const configured = await loadPlatformConfig({
      ...environment, MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_RETRIEVAL_V2_PROVIDER_BINDING_JSON: JSON.stringify(binding),
    }, async (path) => `fixture:${path}`);
    expect(configured.meetingKnowledge?.retrievalV2ProviderBinding).toEqual(binding);
    await expect(loadPlatformConfig({
      ...environment,
      MEETING_KNOWLEDGE_ACTOR_KEYRING_FILE: undefined,
      MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_RETRIEVAL_V2_PROVIDER_BINDING_JSON: JSON.stringify(binding),
    }, async (path) => `fixture:${path}`)).rejects.toThrow(
      "Discord actor-key mapping authority",
    );
    await expect(loadPlatformConfig({
      ...environment, MEETING_KNOWLEDGE_LOCAL_FINAL_REPLY_ENABLED: "true",
      MEETING_KNOWLEDGE_RETRIEVAL_V2_PROVIDER_BINDING_JSON: JSON.stringify({
        ...binding, requiredProviderLanes: ["qdrant_dense", "postgres_keyword"],
      }),
    }, async (path) => `fixture:${path}`)).rejects.toThrow();
  });
  it("keeps the optional Infinity overlay wired to the complete fail-closed contract", async () => {
    const [compose, baseCompose] = await Promise.all([
      readFile(
        new URL("../../../infra/deployment/compose.infinity-context.yaml", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../../infra/deployment/compose.yaml", import.meta.url),
        "utf8",
      ),
    ]);

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
    expect(baseCompose).toContain(
      "MEETING_KNOWLEDGE_ACTOR_KEYRING_FILE: /run/secrets/meeting-knowledge-actor-keyring.json",
    );
    expect(compose).toContain(
      "INFINITY_CONTEXT_REQUEST_TIMEOUT_MS: ${INFINITY_CONTEXT_REQUEST_TIMEOUT_MS:-10000}",
    );
    expect(compose).toContain(
      "INFINITY_CONTEXT_OPERATION_TIMEOUT_MS: ${INFINITY_CONTEXT_OPERATION_TIMEOUT_MS:-300000}",
    );
    expect(compose).not.toContain("MEETING_KNOWLEDGE_TWO_HOUR_HISTORICAL_ENABLED");
  });

  it("loads the providerless summary profile without a subscription-runtime secret", async () => {
    const paths: string[] = [];
    const configured = await loadPlatformConfig({
      ...environment,
      SUBSCRIPTION_RUNTIME_ADDRESS: undefined,
      SUBSCRIPTION_RUNTIME_LAUNCHER_SHA256: undefined,
      SUBSCRIPTION_RUNTIME_TOKEN_FILE: undefined,
    }, async (path) => {
      paths.push(path);
      return `fixture:${path}`;
    });

    expect(configured.summaryProvider).toBe("transcript-outline");
    expect(configured.secrets.subscriptionRuntimeToken).toBeUndefined();
    expect(configured.subscriptionRuntime).toBeUndefined();
    expect(paths).not.toContain("/run/secrets/runtime");
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
});

describe("platform configuration defaults and publication", () => {
  it("loads every secret through the file reader and never requires an API key", async () => {
    const paths: string[] = [];
    const config = await loadPlatformConfig(environment, async (path) => {
      paths.push(path);
      return `value-for:${path}`;
    });

    expect(paths).toHaveLength(8);
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

  it("rejects one application identity for the canonical publication and Craig bots", async () => {
    await expect(loadPlatformConfig({
      ...environment,
      DISCORD_CRAIG_APPLICATION_ID: environment.DISCORD_APPLICATION_ID,
    }, async () => "value")).rejects.toThrow(
      "publication and Craig application IDs must be distinct",
    );
  });

  it("rejects one publication and Craig identity when the Botik override is omitted", async () => {
    await expect(loadPlatformConfig({
      ...environment,
      DISCORD_BOTIK_APPLICATION_ID: undefined,
      DISCORD_CRAIG_APPLICATION_ID: environment.DISCORD_APPLICATION_ID,
    }, async () => "value")).rejects.toThrow(
      "publication and Craig application IDs must be distinct",
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
