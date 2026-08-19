import { EventEmitter } from "node:events";

import type { DisposableInfinityHttpService } from
  "@discord-meeting/infinity-context-adapter/test-support";
import { GuildConfiguration } from "@discord-meeting/guild-configuration-core";
import {
  GroundedMeetingAnswer,
  LiveFinalizedMemoryWorker,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { Meeting } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { ProcessMeetingSummary } from "@discord-meeting/meeting-core/post-call-workflow";
import {
  DurableAnswerPublication,
  type AnswerDeliveryPort,
} from "@discord-meeting/meeting-core/publishing";
import {
  PostgresGuildConfigurationRepository,
  PostgresAnswerEffectStore,
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryStore,
  PostgresLiveMeetingRepository,
  PostgresMeetingRepository,
  canonicalFinalReplyTurnHash,
} from "@discord-meeting/postgres-adapter";
import {
  auditedSubscriptionRuntimePackageVersion,
  canonicalJsonSha256,
  subscriptionRuntimeCliEngine,
  subscriptionRuntimeKnowledgeEvidenceSelectorPurpose,
  type JsonObject,
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
} from "@discord-meeting/subscription-runtime-adapter";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import type { Pool } from "pg";
import { expect } from "vitest";

import type { PlatformHistoricalMemoryRuntime } from
  "../src/composition/historical-memory.js";
import {
  createMeetingKnowledgeLocalFinalReply,
  localFinalReplyPolicy,
  localFinalReplyPolicyRelease,
} from "../src/composition/meeting-knowledge.js";
import { DiscordAnswerPayloadCodec } from "@discord-meeting/discord-adapter";
import {
  botApplicationIdentity,
  historicalRows,
  platformConfig,
  requiredHistoricalRuntime,
  resultsContainerId,
  roomId,
  scopeId,
  silentLogger,
} from "./meeting-knowledge-production-composition-fixtures.js";
import { waitForHistoricalRows } from
  "./meeting-knowledge-production-composition-diagnostics.js";

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
  const threadId = "666666666666666668";
  const questionId = "777777777777777777";
  const liveReceipt = `discord:v2:thread:${threadId}:message:${liveMessageId}`;
  const liveMeetings = new PostgresLiveMeetingRepository(input.pool);
  const live = LiveMeeting.start({
    meetingId,
    publicationTargetId: resultsContainerId,
    startedAtMs: 1_000,
  });
  live.completeProjection(liveReceipt, live.revision, botApplicationIdentity);
  await liveMeetings.save(live.toSnapshot(), null);
  const finalMeetings = new PostgresMeetingRepository(input.pool);
  await finalMeetings.save(Meeting.record({
    actors: [{ actorId: participantId, kind: "human" }],
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "f".repeat(40),
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingId,
    publicationTargetId: resultsContainerId,
    recording: {
      manifestLocator: `s3://synthetic-only/${meetingId}/manifest.json`,
      recordingId: `recording-${meetingId}`,
      speakerAudio: [{
        audioLocator: `s3://synthetic-only/${meetingId}/${participantId}.ogg`,
        speakerId: participantId,
        timelineOffsetMs: 0,
      }],
    },
    source: { roomId, scopeId },
  }).toSnapshot(), 0);
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
  const permissionSet = {
    bitfield: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory,
    has: (permission: bigint) =>
      permission === PermissionFlagsBits.ViewChannel ||
      permission === PermissionFlagsBits.ReadMessageHistory,
  };
  const channel = {
    id: resultsContainerId,
    permissionsFor: () => permissionSet,
    type: ChannelType.GuildText,
  };
  const thread = {
    id: threadId,
    isThread: () => true,
    members: { fetch: () => Promise.resolve({ id: participantId }) },
    parentId: resultsContainerId,
    permissionsFor: () => permissionSet,
    type: ChannelType.PrivateThread,
  };
  const guild = {
    channels: {
      fetch: (id: string) => Promise.resolve(id === threadId ? thread : channel),
    },
    members: { fetch: () => Promise.resolve({ id: participantId }) },
    roles: { fetch: () => Promise.resolve() },
  };
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    guilds: { fetch: () => Promise.resolve(guild) },
  }) as unknown as Client;
  const delivered: string[] = [];
  const deliveryCalls: Parameters<AnswerDeliveryPort["create"]>[0][] = [];
  let loseFirstResponse = true;
  const answerDelivery: AnswerDeliveryPort = {
    create: async (request) => {
      deliveryCalls.push(request);
      delivered.push(request.payloadBytes);
      if (loseFirstResponse) {
        loseFirstResponse = false;
        throw new Error("synthetic response lost after committed thread create");
      }
      return `88888888888888888${deliveryCalls.length}`;
    },
    inspect: async (request) => {
      const created = deliveryCalls.find((candidate) =>
        candidate.marker === request.marker &&
        candidate.deliveryContainerId === request.deliveryContainerId &&
        candidate.projectionTargetContainerId === request.projectionTargetContainerId &&
        candidate.replyToRemoteMessageId === request.replyToRemoteMessageId
      );
      return created === undefined
        ? { status: "unconfirmed" as const }
        : { externalReceipt: "888888888888888880", status: "found" as const };
    },
    remove: () => Promise.resolve(),
  };
  let generatorInvocations = 0;
  const generator = createGroundedAnswer(() => {
    generatorInvocations += 1;
    return generatorInvocations;
  });
  const selectorRuntime = new SyntheticFocusedSelectorRuntime();
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
    answerDelivery,
    answers: generator,
    client,
    config,
    guildConfigurations,
    historicalMemory: input.runtime,
    logger: silentLogger,
    pool: input.pool,
    runtimeTransport: selectorRuntime,
  });
  const emitQuestion = (overrides: Record<string, unknown> = {}): void => {
    emitter.emit("messageCreate", {
      author: { bot: false, id: participantId },
      channel: thread,
      channelId: threadId,
      content: "How does EARLY-COMET connect to PINE-GOLF?",
      guildId: scopeId,
      id: questionId,
      reference: { channelId: threadId, messageId: liveMessageId },
      webhookId: null,
      ...overrides,
    });
  };
  runtime.start();
  try {
    emitRejectedQuestions(emitQuestion, participantId, liveMessageId);
    await runtime.settleIngress();
    await expectQuestionEffects(input.pool, 0);
    expect(generatorInvocations).toBe(0);
    expect(delivered).toHaveLength(0);
    emitQuestion();
    emitQuestion();
    await runtime.settleIngress();
    await waitForQuestionEffectState(input.pool, questionId, "outcome_unknown", input.signal);
    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0]).toMatchObject({
      deliveryContainerId: threadId,
      projectionTargetContainerId: resultsContainerId,
      replyToRemoteMessageId: questionId,
    });
    const reconciliation = new DurableAnswerPublication({
      delivery: answerDelivery,
      payloads: new DiscordAnswerPayloadCodec(),
      store: new PostgresAnswerEffectStore(input.pool, localFinalReplyPolicyRelease),
    });
    await expect(reconciliation.reconcileUnknown(100)).resolves.toEqual({
      absentUnconfirmed: 0,
      containedDuplicates: 0,
      delivered: 1,
    });
    await waitForQuestionEffect(input.pool, questionId, input.signal);
    expect(delivered).toHaveLength(1);
    expect(selectorRuntime.invocations).toBe(1);
    expect(generatorInvocations).toBe(1);
    await expectQuestionEffects(input.pool, 1);
    expect(delivered[0]).toContain("Ana owns the active release");
    expect(delivered[0]).not.toContain("Ongoing live ingestion detail 19");
    await finalizeAndProveCanonicalTransition({
      delivered,
      emitQuestion,
      finalMeetings,
      generatorInvocations: () => generatorInvocations,
      infinity: input.infinity,
      lifecycle,
      liveMeetings,
      meetingId,
      participantId,
      pool: input.pool,
      runtime,
      signal: input.signal,
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

function createGroundedAnswer(onGenerate: () => number): GroundedMeetingAnswer {
  return new GroundedMeetingAnswer({
    generate: async (request) => {
      const invocation = onGenerate();
      const early = request.plan.evidence.find(({ text }) => text.includes("EARLY-COMET"));
      const historical = request.plan.evidence.find(({ text }) => text.includes("PINE-GOLF"));
      expect(request.plan.mode).toBe("focused_retrieval");
      expect(request.plan.evidence.length).toBeLessThanOrEqual(24);
      expect(early).toBeDefined();
      expect(historical).toBeDefined();
      if (invocation === 2) {
        expect(early?.turnId).toBe("same-meeting-final-turn-1");
      }
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

async function finalizeAndProveCanonicalTransition(input: {
  readonly delivered: readonly string[];
  readonly emitQuestion: (overrides?: Record<string, unknown>) => void;
  readonly finalMeetings: PostgresMeetingRepository;
  readonly generatorInvocations: () => number;
  readonly infinity: DisposableInfinityHttpService;
  readonly lifecycle: PostgresLiveFinalizedMemoryLifecycle;
  readonly liveMeetings: PostgresLiveMeetingRepository;
  readonly meetingId: string;
  readonly participantId: string;
  readonly pool: Pool;
  readonly runtime: NonNullable<ReturnType<typeof createMeetingKnowledgeLocalFinalReply>>;
  readonly signal: AbortSignal;
}): Promise<void> {
  const current = await input.liveMeetings.findById(input.meetingId);
  if (current === null) {
    throw new Error("live reply meeting disappeared before finalization");
  }
  const ended = LiveMeeting.restore(current);
  ended.end(30_000);
  await input.liveMeetings.save(ended.toSnapshot(), current.revision);
  await input.lifecycle.finishMeeting(input.meetingId);
  const finalMessageId = "666666666666666667";
  const finalReceipt =
    `discord:v2:channel:${resultsContainerId}:message:${finalMessageId}`;
  const finalized = await new ProcessMeetingSummary({
    meetings: input.finalMeetings,
    publisher: {
      publish: async () => ({
        ok: true as const,
        value: {
          externalPublicationId: finalReceipt,
          publisherIdentity: botApplicationIdentity,
        },
      }),
    },
    summarizer: {
      generate: async () => ({
        ok: true as const,
        value: {
          actionItems: [],
          decisions: [{
            decisionId: "same-meeting-final-decision",
            evidenceTurnIds: ["same-meeting-final-turn-1"],
            text: "Ana owns the active release.",
          }],
          openQuestions: [],
          overview: "The same meeting reached its authoritative final state.",
          summaryId: "same-meeting-final-summary",
          title: "Same meeting final",
          topics: [],
          version: 1,
        },
      }),
    },
    transcriber: {
      transcribe: async () => ({
        ok: true as const,
        value: {
          recordingId: `recording-${input.meetingId}`,
          transcriptId: `transcript-${input.meetingId}`,
          turns: Array.from({ length: 6 }, (_, index) => ({
            endMs: 2_500 + index * 1_000,
            speakerId: input.participantId,
            startMs: 2_000 + index * 1_000,
            text: index === 0
              ? "EARLY-COMET confirms Ana owns the active release."
              : `Canonical final transcript detail ${index}.`,
            turnId: `same-meeting-final-turn-${index + 1}`,
          })),
          version: 1,
        },
      }),
    },
  }).execute(input.meetingId, { signal: input.signal });
  expect(finalized).toMatchObject({
    externalPublicationId: finalReceipt,
    status: "published",
  });
  const sync = requiredHistoricalRuntime(input.pool, input.infinity, true, true);
  await sync.assertReady();
  await sync.start();
  try {
    await waitForHistoricalApplication(input.pool, input.meetingId, input.signal);
  } finally {
    await sync.close();
  }
  input.emitQuestion({ id: "777777777777777774" });
  await input.runtime.settleIngress();
  await expectQuestionEffects(input.pool, 1);
  expect(input.delivered).toHaveLength(1);
  expect(input.generatorInvocations()).toBe(1);

  const finalQuestionId = "777777777777777776";
  input.emitQuestion({
    channel: { isThread: () => false },
    channelId: resultsContainerId,
    id: finalQuestionId,
    reference: {
      channelId: resultsContainerId,
      messageId: finalMessageId,
    },
  });
  await input.runtime.settleIngress();
  await waitForQuestionEffect(input.pool, finalQuestionId, input.signal);
  await expectQuestionEffects(input.pool, 2);
  expect(input.delivered).toHaveLength(2);
  if (input.generatorInvocations() !== 2) {
    throw new Error(`final reply bypassed canonical generation: ${input.delivered[1]}`);
  }
  const deleting = requiredHistoricalRuntime(
    input.pool,
    input.infinity,
    false,
    false,
  );
  await deleting.requestMeetingDeletion(input.meetingId);
  const deletionRowCount = (await historicalRows(input.pool)).filter(
    ({ meeting_id }) => meeting_id === input.meetingId,
  ).length;
  await deleting.start();
  try {
    await waitForHistoricalRows(
      input.pool,
      ({ meeting_id, state }) =>
        meeting_id === input.meetingId && state === "deleted",
      deletionRowCount,
      input.signal,
    );
  } finally {
    await deleting.close();
  }
  const deleted = await input.pool.query<{ readonly state: string }>(
    `SELECT state FROM meeting_core.historical_memory_sync WHERE meeting_id = $1`,
    [input.meetingId],
  );
  expect(deleted.rows.every(({ state }) => state === "deleted")).toBe(true);
}

async function waitForQuestionEffectState(
  pool: Pool,
  questionId: string,
  expectedState: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    signal.throwIfAborted();
    const result = await pool.query<{ readonly state: string }>(
      "SELECT state FROM meeting_core.answer_effects WHERE effect_id = $1",
      [`meeting-knowledge-answer:v1:${questionId}`],
    );
    if (result.rows[0]?.state === expectedState) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`question effect ${questionId} did not reach ${expectedState}`);
}

async function waitForHistoricalApplication(
  pool: Pool,
  meetingId: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    signal.throwIfAborted();
    const result = await pool.query<{ readonly state: string }>(
      `SELECT state FROM meeting_core.historical_memory_sync WHERE meeting_id = $1`,
      [meetingId],
    );
    if (result.rows[0]?.state === "applied") {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });
  }
  throw new Error(`historical release ${meetingId} did not apply`);
}

async function expectQuestionEffects(pool: Pool, expected: number): Promise<void> {
  const [jobs, effects] = await Promise.all([
    pool.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM meeting_knowledge.question_jobs",
    ),
    pool.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM meeting_core.answer_effects",
    ),
  ]);
  expect(jobs.rows[0]?.count).toBe(expected);
  expect(effects.rows[0]?.count).toBe(expected);
}

async function waitForQuestionEffect(
  pool: Pool,
  questionId: string,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    signal.throwIfAborted();
    const result = await pool.query<{ readonly state: string }>(
      `SELECT state FROM meeting_core.answer_effects WHERE effect_id = $1`,
      [`meeting-knowledge-answer:v1:${questionId}`],
    );
    if (result.rows[0]?.state === "delivered") {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 100);
    });
  }
  throw new Error(`question effect ${questionId} did not settle`);
}

const syntheticLauncherSha256 = "d".repeat(64);

class SyntheticFocusedSelectorRuntime implements SubscriptionRuntimeTransportPort {
  public invocations = 0;

  public checkHealth() {
    return Promise.resolve({
      launcherSha256: syntheticLauncherSha256,
      runtimeEngine: subscriptionRuntimeCliEngine,
      runtimeVersion: auditedSubscriptionRuntimePackageVersion,
      status: "serving" as const,
      warningCodes: [],
    });
  }

  public execute(
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SubscriptionRuntimeTaskResult> {
    options.signal?.throwIfAborted();
    expect(request.context.purpose).toBe(
      subscriptionRuntimeKnowledgeEvidenceSelectorPurpose,
    );
    this.invocations += 1;
    const prompt = JSON.parse(request.task.prompt) as {
      readonly candidates: readonly {
        readonly candidateId: string;
        readonly snippet: string;
      }[];
    };
    const selectedCandidateIds = prompt.candidates
      .filter(({ snippet }) => /EARLY-COMET|PINE-GOLF/u.test(snippet))
      .map(({ candidateId }) => candidateId)
      .slice(0, 5);
    expect(selectedCandidateIds.length).toBeGreaterThan(0);
    const output: JsonObject = {
      schemaVersion: 1,
      selectedCandidateIds,
      status: "selected",
    };
    return Promise.resolve({
      executionAttestation: {
        canonicalRequestSha256: canonicalJsonSha256(request),
        launcherSha256: syntheticLauncherSha256,
        model: request.task.controls.model,
        provider: "codex",
        purpose: request.context.purpose,
        reasoningEffort: request.task.controls.reasoningEffort,
        requestId: request.runId,
        runtimeEngine: subscriptionRuntimeCliEngine,
        runtimePackageVersion: auditedSubscriptionRuntimePackageVersion,
        schemaVersion: 1,
        selectedOutputKind: "structured_output",
        selectedOutputSha256: canonicalJsonSha256(output),
      },
      protocolVersion: 1,
      status: "completed",
      structuredOutput: output,
    });
  }
}
