import { EventEmitter } from "node:events";

import type { DisposableInfinityHttpService } from
  "@discord-meeting/infinity-context-adapter/test-support";
import { GuildConfiguration } from "@discord-meeting/guild-configuration-core";
import {
  GroundedMeetingAnswer,
  LiveFinalizedMemoryWorker,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import {
  PostgresGuildConfigurationRepository,
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryStore,
  PostgresLiveMeetingRepository,
  canonicalFinalReplyTurnHash,
} from "@discord-meeting/postgres-adapter";
import type { SubscriptionRuntimeTransportPort } from
  "@discord-meeting/subscription-runtime-adapter";
import type { Client } from "discord.js";
import type { Pool } from "pg";
import { expect } from "vitest";

import type { PlatformHistoricalMemoryRuntime } from
  "../src/composition/historical-memory.js";
import {
  createMeetingKnowledgeLocalFinalReply,
  localFinalReplyPolicy,
} from "../src/composition/meeting-knowledge.js";
import {
  platformConfig,
  resultsContainerId,
  roomId,
  scopeId,
  silentLogger,
} from "./meeting-knowledge-production-composition-fixtures.js";

export async function qualifyLiveProjectionReply(input: {
  readonly infinity: DisposableInfinityHttpService;
  readonly pool: Pool;
  readonly runtime: PlatformHistoricalMemoryRuntime;
  readonly signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  const meetingId = "synthetic-live-reply-meeting";
  const participantId = "555555555555555555";
  const liveMessageId = "666666666666666666";
  const questionId = "777777777777777777";
  const liveReceipt =
    `discord:v2:channel:${resultsContainerId}:message:${liveMessageId}`;
  const liveMeetings = new PostgresLiveMeetingRepository(input.pool);
  const live = LiveMeeting.start({
    meetingId,
    publicationTargetId: resultsContainerId,
    startedAtMs: 1_000,
  });
  live.completeProjection(liveReceipt, live.revision);
  await liveMeetings.save(live.toSnapshot(), null);
  const lifecycle = new PostgresLiveFinalizedMemoryLifecycle(input.pool);
  await expect(lifecycle.registerMeeting({
    actors: [{ actorId: participantId, kind: "human" }],
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "f".repeat(40),
      rosterState: "unsealed",
    },
    lifecycleGeneration: 3,
    meetingId,
    roomId,
    scopeId,
  })).resolves.toBe("accepted");
  await appendLiveTurns(liveMeetings, meetingId, participantId);
  await projectLiveTurns(input.pool, meetingId);

  const guildConfigurations = new PostgresGuildConfigurationRepository(input.pool);
  await guildConfigurations.save(GuildConfiguration.configure({
    configuredByUserId: participantId,
    guildId: scopeId,
    resultsChannelId: resultsContainerId,
    voiceChannelId: roomId,
  }).toSnapshot(), null);
  const permissionSet = { bitfield: 3n, has: () => true };
  const channel = { permissionsFor: () => permissionSet };
  const guild = {
    channels: { fetch: () => Promise.resolve(channel) },
    members: { fetch: () => Promise.resolve({}) },
    roles: { fetch: () => Promise.resolve() },
  };
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    guilds: { fetch: () => Promise.resolve(guild) },
  }) as unknown as Client;
  const delivered: string[] = [];
  const generator = createGroundedAnswer();
  const baseConfig = platformConfig(input.infinity.baseUrl, true, true, "test");
  const config = {
    ...baseConfig,
    meetingKnowledge: { localFinalReply: true as const },
    secrets: {
      ...baseConfig.secrets,
      meetingKnowledgePrincipalKey: "ab".repeat(32),
    },
  };
  const runtime = createMeetingKnowledgeLocalFinalReply({
    answerDelivery: {
      create: async ({ payloadBytes }) => {
        delivered.push(payloadBytes);
        return "888888888888888888";
      },
      inspect: async () => ({ status: "unconfirmed" as const }),
    },
    answers: generator,
    client,
    config,
    guildConfigurations,
    historicalMemory: input.runtime,
    logger: silentLogger,
    pool: input.pool,
    runtimeTransport: unusedRuntimeTransport,
  });
  if (runtime === undefined) {
    throw new Error("live projection reply composition was disabled");
  }
  const emitQuestion = (overrides: Record<string, unknown> = {}): void => {
    emitter.emit("messageCreate", {
      author: { bot: false, id: participantId },
      channelId: resultsContainerId,
      content: "How does EARLY-COMET connect to PINE-GOLF?",
      guildId: scopeId,
      id: questionId,
      reference: { channelId: resultsContainerId, messageId: liveMessageId },
      webhookId: null,
      ...overrides,
    });
  };
  runtime.start();
  try {
    emitRejectedQuestions(emitQuestion, participantId, liveMessageId);
    emitQuestion();
    emitQuestion();
    await waitForDelivery(delivered);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("Ana owns the active release");
    expect(delivered[0]).not.toContain("Ongoing live ingestion detail 19");
    await finalizeAndProveRejection({
      delivered,
      emitQuestion,
      lifecycle,
      liveMeetings,
      meetingId,
    });
  } finally {
    await runtime.close();
  }
}

async function appendLiveTurns(
  meetings: PostgresLiveMeetingRepository,
  meetingId: string,
  participantId: string,
): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await meetings.appendFinalizedTurn(meetingId, {
      endMs: 2_500 + index * 1_000,
      speakerId: participantId,
      startMs: 2_000 + index * 1_000,
      text: index === 0
        ? "EARLY-COMET confirms Ana owns the active release."
        : `Ongoing live ingestion detail ${index}.`,
      turnId: `live-reply-turn-${String(index).padStart(2, "0")}`,
    });
  }
}

async function projectLiveTurns(pool: Pool, meetingId: string): Promise<void> {
  const worker = new LiveFinalizedMemoryWorker(
    new PostgresLiveFinalizedMemoryStore(pool),
    { hash: canonicalFinalReplyTurnHash },
  );
  for (;;) {
    const projected = await worker.executeOnce({ meetingId });
    if (projected.status === "idle") {
      return;
    }
    expect(projected.status).toBe("applied");
  }
}

function createGroundedAnswer(): GroundedMeetingAnswer {
  return new GroundedMeetingAnswer({
    generate: async (request) => {
      const early = request.plan.evidence.find(({ text }) => text.includes("EARLY-COMET"));
      const historical = request.plan.evidence.find(({ text }) => text.includes("PINE-GOLF"));
      expect(request.plan.mode).toBe("focused_retrieval");
      expect(request.plan.evidence.length).toBeLessThanOrEqual(24);
      expect(early).toBeDefined();
      expect(historical).toBeDefined();
      return {
        answer: {
          claims: [{
            evidenceIds: [early, historical]
              .filter((item) => item !== undefined)
              .map(({ evidenceId }) => evidenceId),
            text: "Ana owns the active release; PINE-GOLF supplies prior room context.",
          }],
          locale: "en" as const,
          status: "answered" as const,
        },
        status: "completed" as const,
      };
    },
    measure: async (request) => ({
      inputTokens: Math.ceil(JSON.stringify(request).length / 4),
      requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
      runtimeProfile: "synthetic-live-projection-reply.v1",
    }),
  }, localFinalReplyPolicy.groundingSafety);
}

function emitRejectedQuestions(
  emit: (overrides?: Record<string, unknown>) => void,
  participantId: string,
  liveMessageId: string,
): void {
  emit({ guildId: "999999999999999998", id: "777777777777777770" });
  emit({
    author: { bot: false, id: "999999999999999997" },
    id: "777777777777777771",
  });
  emit({
    id: "777777777777777772",
    reference: {
      channelId: resultsContainerId,
      messageId: "999999999999999996",
    },
  });
  emit({
    author: { bot: true, id: participantId },
    id: "777777777777777775",
  });
  emit({
    id: "777777777777777773",
    reference: { channelId: roomId, messageId: liveMessageId },
  });
}

async function waitForDelivery(delivered: readonly string[]): Promise<void> {
  for (let attempt = 0; attempt < 100 && delivered.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

async function finalizeAndProveRejection(input: {
  readonly delivered: readonly string[];
  readonly emitQuestion: (overrides?: Record<string, unknown>) => void;
  readonly lifecycle: PostgresLiveFinalizedMemoryLifecycle;
  readonly liveMeetings: PostgresLiveMeetingRepository;
  readonly meetingId: string;
}): Promise<void> {
  const current = await input.liveMeetings.findById(input.meetingId);
  if (current === null) {
    throw new Error("live reply meeting disappeared before finalization");
  }
  const ended = LiveMeeting.restore(current);
  ended.end(30_000);
  await input.liveMeetings.save(ended.toSnapshot(), current.revision);
  await input.lifecycle.finishMeeting(input.meetingId);
  input.emitQuestion({ id: "777777777777777774" });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 750);
  });
  expect(input.delivered).toHaveLength(1);
}

const unusedRuntimeTransport = {
  checkHealth: () => Promise.reject(new Error("unused synthetic runtime")),
  execute: () => Promise.reject(new Error("unused synthetic runtime")),
} as SubscriptionRuntimeTransportPort;
