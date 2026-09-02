import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  HealthAggregator,
  type HealthProbe,
} from "@discord-meeting/observability-adapter";
import { GrpcPipecatConversationRuntime } from "@discord-meeting/pipecat-runtime-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";
import type { SummaryProviderHealth } from "../adapters/outbound/transcript-outline-summary-adapter.js";

interface SummaryProviderHealthPort {
  checkHealth(): Promise<SummaryProviderHealth>;
}

export interface PostCallDurabilityHealthPort {
  assertPostCallDurability(): void | Promise<void>;
}

export interface RedisPolicyReadinessPort {
  assertReady(): Promise<void>;
}

export interface SchemaReadinessPort {
  assertReady(): Promise<void>;
}

export function createPlatformHealth(input: {
  readonly config: PlatformConfig;
  readonly conversationRuntime?: GrpcPipecatConversationRuntime;
  readonly discord: Client;
  readonly pool: Pool;
  readonly postCallDurability: PostCallDurabilityHealthPort;
  readonly queue: { waitUntilReady(): Promise<unknown> };
  readonly redisPolicyReadiness: RedisPolicyReadinessPort;
  readonly runtime: SummaryProviderHealthPort;
  readonly schemaReadiness: SchemaReadinessPort;
  readonly s3: S3Client;
}): HealthAggregator {
  return new HealthAggregator(createHealthProbes(input), { timeoutMs: 5_000 });
}

function createHealthProbes(input: {
  readonly config: PlatformConfig;
  readonly conversationRuntime?: GrpcPipecatConversationRuntime;
  readonly discord: Client;
  readonly pool: Pool;
  readonly postCallDurability: PostCallDurabilityHealthPort;
  readonly queue: { waitUntilReady(): Promise<unknown> };
  readonly redisPolicyReadiness: RedisPolicyReadinessPort;
  readonly runtime: SummaryProviderHealthPort;
  readonly schemaReadiness: SchemaReadinessPort;
  readonly s3: S3Client;
}): readonly HealthProbe[] {
  return [
    probe("database", true, async () => {
      await input.pool.query("SELECT 1");
    }),
    probe("database-schema", true, async () => input.schemaReadiness.assertReady()),
    probe("discord", true, async () => {
      if (!input.discord.isReady()) {
        throw new Error("Discord client is not ready");
      }
    }),
    probe("object-storage", true, async () => {
      await input.s3.send(
        new HeadBucketCommand({ Bucket: input.config.s3.bucket }),
      );
    }),
    probe("queue", true, async () => input.queue.waitUntilReady()),
    createRedisPolicyHealthProbe(input.redisPolicyReadiness),
    createPostCallDurabilityHealthProbe(input.postCallDurability),
    createTranscriptionHealthProbe(input.config),
    ...(input.conversationRuntime === undefined
      ? []
      : [createConversationHealthProbe(input.conversationRuntime)]),
    createSummaryProviderHealthProbe(input.runtime),
  ];
}

function createRedisPolicyHealthProbe(
  readiness: RedisPolicyReadinessPort,
): HealthProbe {
  return probe("queue-policy", true, async () => readiness.assertReady());
}

export function createPostCallDurabilityHealthProbe(
  durability: PostCallDurabilityHealthPort,
): HealthProbe {
  return probe("post-call-durability", false, async () => {
    await durability.assertPostCallDurability();
  });
}

function createConversationHealthProbe(
  runtime: GrpcPipecatConversationRuntime,
): HealthProbe {
  return {
    check: async () => {
      const result = await runtime.checkHealth();
      return {
        code: result.status.toUpperCase().replaceAll("-", "_"),
        status:
          result.status === "serving"
            ? "healthy"
            : result.status === "degraded"
              ? "degraded"
              : "unhealthy",
      };
    },
    critical: true,
    name: "conversation-runtime",
  };
}

function createSummaryProviderHealthProbe(
  runtime: SummaryProviderHealthPort,
): HealthProbe {
  return {
    check: async () => {
      const result = await runtime.checkHealth();
      return {
        code: result.status === "serving" ? "SERVING" : "NOT_SERVING",
        status: result.status === "serving" ? "healthy" : "unhealthy",
      };
    },
    critical: true,
    name: "summary-provider",
  };
}

export function createTranscriptionHealthProbe(config: PlatformConfig): HealthProbe {
  if (config.transcriptionProvider === "speaches") {
    return probe("stt", true, async (signal) => {
      const response = await fetch(
        new URL("/v1/models", config.speaches.baseUrl),
        { signal },
      );
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error("STT dependency is not ready");
      }
    });
  }
  return probe("stt", true, async (signal) => {
    const response = await fetch(voicetextHealthUrl(config), { signal });
    const body = await response.json();
    if (!response.ok || !isVoicetextHealthy(body, config)) {
      throw new Error("STT dependency is not ready");
    }
  });
}

function isVoicetextHealthy(value: unknown, config: PlatformConfig): boolean {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    value.status !== "ok" ||
    !("provider_profiles" in value) ||
    !Array.isArray(value.provider_profiles) ||
    config.voicetext === undefined
  ) {
    return false;
  }
  const expectedProfiles = [
    batchHealthIdentity(config.voicetext.batchProfile),
    ...(config.voicetext.liveEnabled === true
      ? [liveHealthIdentity(config.voicetext.liveProfile)]
      : []),
  ];
  const providerProfiles: readonly unknown[] = value.provider_profiles;
  return expectedProfiles.every((identity) => {
    const matching = providerProfiles.filter((profile) =>
      matchesVoicetextProfile(profile, identity)
    );
    return matching.length === 1 && matching[0]?.ready === true;
  });
}

function matchesVoicetextProfile(
  value: unknown,
  identity: VoicetextHealthIdentity,
): value is { readonly ready?: unknown } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const profile = value as Readonly<Record<string, unknown>>;
  return (
    profile.mode === identity.mode &&
    profile.profile === identity.profile &&
    profile.provider === identity.provider &&
    profile.model === identity.model &&
    profile[identity.versionField] === identity.version
  );
}

interface VoicetextHealthIdentity {
  readonly mode: "batch" | "live";
  readonly model: "nova-3" | "scribe_v2" | "scribe_v2_realtime";
  readonly profile: "deepgram-nova-3" | "elevenlabs-scribe-v2" | "elevenlabs-scribe-v2-realtime";
  readonly provider: "deepgram" | "elevenlabs";
  readonly version: 2 | 3;
  readonly versionField: "contract_version" | "protocol_version";
}

function liveHealthIdentity(
  profile: NonNullable<PlatformConfig["voicetext"]>["liveProfile"],
): VoicetextHealthIdentity {
  return profile === "deepgram-nova-3"
    ? {
        mode: "live",
        model: "nova-3",
        profile,
        provider: "deepgram",
        version: 2,
        versionField: "protocol_version",
      }
    : {
        mode: "live",
        model: "scribe_v2_realtime",
        profile,
        provider: "elevenlabs",
        version: 2,
        versionField: "protocol_version",
      };
}

function batchHealthIdentity(
  profile: NonNullable<PlatformConfig["voicetext"]>["batchProfile"],
): VoicetextHealthIdentity {
  return profile === "deepgram-nova-3"
    ? {
        mode: "batch",
        model: "nova-3",
        profile,
        provider: "deepgram",
        version: 2,
        versionField: "contract_version",
      }
    : {
        mode: "batch",
        model: "scribe_v2",
        profile,
        provider: "elevenlabs",
        version: 3,
        versionField: "contract_version",
      };
}

function voicetextHealthUrl(config: PlatformConfig): URL {
  if (config.voicetext === undefined) {
    throw new Error("Voicetext transcription configuration is incomplete");
  }
  const endpoint = new URL(config.voicetext.webSocketUrl);
  endpoint.protocol = "https:";
  endpoint.pathname = "/health";
  return endpoint;
}

function probe(
  name: string,
  critical: boolean,
  check: (signal: AbortSignal) => Promise<unknown>,
): HealthProbe {
  return {
    check: async (signal) => {
      await check(signal);
      return { status: "healthy" };
    },
    critical,
    name,
  };
}
