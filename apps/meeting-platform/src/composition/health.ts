import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import {
  HealthAggregator,
  type HealthProbe,
} from "@discord-meeting/observability-adapter";
import { GrpcPipecatConversationRuntime } from "@discord-meeting/pipecat-runtime-adapter";
import { SubscriptionRuntimeSummaryAdapter } from "@discord-meeting/subscription-runtime-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";

import type { PlatformConfig } from "../config.js";

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
  readonly runtime: SubscriptionRuntimeSummaryAdapter;
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
  readonly runtime: SubscriptionRuntimeSummaryAdapter;
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
  runtime: SubscriptionRuntimeSummaryAdapter,
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

function createTranscriptionHealthProbe(config: PlatformConfig): HealthProbe {
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
    if (!response.ok || !isVoicetextHealthy(body)) {
      throw new Error("STT dependency is not ready");
    }
  });
}

function isVoicetextHealthy(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "ok"
  );
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
