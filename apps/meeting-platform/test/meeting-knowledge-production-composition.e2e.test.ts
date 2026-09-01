import { EventEmitter } from "node:events";

import {
  startDisposableInfinityHttpService,
} from "@discord-meeting/infinity-context-adapter/test-support";
import { MeetingSourceConfiguration } from "@discord-meeting/meeting-routing-core";
import {
  FocusedHistoricalEvidenceV2,
  GroundedMeetingAnswer,
  LiveFinalizedMemoryWorker,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import type { MeetingSnapshot } from
  "@discord-meeting/meeting-core/meeting-lifecycle";
import type { AnswerDeliveryPort } from
  "@discord-meeting/meeting-core/publishing";
import {
  PostgresLiveFinalizedMemoryLifecycle,
  PostgresLiveFinalizedMemoryQuery,
  PostgresLiveFinalizedMemoryStore,
  PostgresLiveMeetingRepository,
  PostgresMeetingSourceConfigurationRepository,
  PostgresMeetingRepository,
  PostgresMigrationRunner,
  canonicalFinalReplyTurnHash,
} from "@discord-meeting/postgres-adapter";
import { ChannelType, PermissionFlagsBits, type Client } from "discord.js";
import { Client as PgClient, Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createVoiceGroundedAnswers } from
  "../src/composition/voice-grounded-answers.js";
import type { PlatformHistoricalMemoryRuntime } from
  "../src/composition/historical-memory.js";
import { createMeetingKnowledgeLocalFinalReply, localFinalReplyPolicy } from
  "../src/composition/meeting-knowledge.js";
import { createPersistedFocusedMemoryRoute } from
  "../src/composition/meeting-knowledge-retrieval-router.js";
import type { PlatformConfig } from "../src/config.js";
import { proveComposedGroundedVoice } from "./meeting-knowledge-composed-voice-e2e.js";
import {
  allowOnlySyntheticRoom,
  currentActor,
  currentMeeting,
  currentMeetingId,
  historicalActorA,
  historicalActorB,
  historicalMeetingId,
  historicalRows,
  historicalTwoHourMeeting,
  mixedLaneQuestion,
  persistPublishedMeeting,
  platformConfig,
  requiredHistoricalRuntime,
  unavailableHistoryAnswersFixture,
  resultsContainerId,
  roomId,
  scopeId,
  silentLogger,
  syntheticCoverageRuntime,
} from "./meeting-knowledge-production-composition-fixtures.js";
import {
  disposableExternalPostgresUrl,
  waitForHistoricalRows,
} from "./meeting-knowledge-production-composition-diagnostics.js";
import { assertDirectMixedEvidence, assertFinalReplyMixedEvidence,
  assertHistoricalSelection, assertUnavailableHistoryFinalReplyState } from
  "./meeting-knowledge-production-composition-assertions.js";
import { assertRetrievalRequestPrivacy, proveActorScopedRetrievalRequest } from
  "./meeting-knowledge-production-composition-privacy.js";

const postgresImage =
  "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const postgresPort = 5_432;
let container: StartedTestContainer | undefined;
let database: Pool | undefined;
const externalPostgresUrl = disposableExternalPostgresUrl(process.env);
const unicodePrivacyProfiles = Object.freeze({
  [currentActor]: Object.freeze({
    displayName: "Alice Smith",
    greetingLocale: "en" as const,
    spokenName: "Alice",
  }),
  [historicalActorA]: Object.freeze({
    displayName: "Ｖｌａｄ",
    greetingLocale: "en" as const,
    spokenName: "🔥",
  }),
  [historicalActorB]: Object.freeze({
    displayName: "Boba",
    greetingLocale: "en" as const,
    spokenName: "Hopa",
  }),
});

describe("Meeting Knowledge V2 production composition", () => {
  beforeAll(async () => {
    if (externalPostgresUrl === undefined) {
      container = await new GenericContainer(postgresImage)
        .withEnvironment({
          POSTGRES_DB: "meeting_knowledge_e2e",
          POSTGRES_PASSWORD: "synthetic-only",
          POSTGRES_USER: "meeting_knowledge_e2e",
        })
        .withExposedPorts(postgresPort)
        .withWaitStrategy(
          Wait.forLogMessage(/database system is ready to accept connections/u, 2),
        )
        .withStartupTimeout(120_000)
        .start();
      database = new Pool({
        database: "meeting_knowledge_e2e",
        host: container.getHost(),
        password: "synthetic-only",
        port: container.getMappedPort(postgresPort),
        user: "meeting_knowledge_e2e",
      });
    } else {
      database = new Pool({ connectionString: externalPostgresUrl });
    }
    await database.query("SELECT 1");
    await new PostgresMigrationRunner(database).migrate();
  }, 150_000);

  afterAll(async () => {
    await database?.end();
    await container?.stop();
  });

  it("answers voice from deterministically mixed live and V2 locator-only history",
    async () => {
      const pool = requiredDatabase();
      const infinity = await startDisposableInfinityHttpService();
      const runtime = requiredHistoricalRuntime(
        pool, infinity, true, true, "test",
        { participantGreetingProfiles: unicodePrivacyProfiles },
      );
      let servingRuntime: typeof runtime | undefined;
      const controller = new AbortController();
      let runtimeClosed = false;
      try {
        const repository = new PostgresMeetingRepository(pool);
        const historical = await persistPublishedMeeting(
          repository,
          historicalTwoHourMeeting(),
        );
        const current = await persistPublishedMeeting(repository, currentMeeting());
        await runtime.assertReady();
        await runtime.start();
        await waitForHistoricalRows(
          pool,
          ({ state }) => state === "applied",
          2,
          controller.signal,
        );
        expect((await historicalRows(pool)).filter(({ state }) => state === "applied"))
          .toHaveLength(2);
        await runtime.assertReady();
        await runtime.close();
        runtimeClosed = true;
        servingRuntime = requiredHistoricalRuntime(
          pool, infinity, true, true, "test",
          { participantGreetingProfiles: unicodePrivacyProfiles },
        );
        await servingRuntime.assertReady();

        const live = await createLiveProjection(pool, current, controller.signal);
        const authorization = allowOnlySyntheticRoom();
        const question = mixedLaneQuestion;
        const groundedFixture = compositionGroundedAnswers();
        const groundedAnswerUseCase = groundedFixture.answers;
        const platformBaseConfig = platformConfig(
          infinity.baseUrl, true, true, "test",
        );
        const baseConfig = {
          ...platformBaseConfig,
          participantGreetingProfiles: unicodePrivacyProfiles,
        };
        const providerBinding = baseConfig.meetingKnowledge?.retrievalV2ProviderBinding;
        if (providerBinding === undefined) {
          throw new Error("synthetic Retrieval V2 binding is missing");
        }
        await proveConfusableIdentityAdmissionFailsBeforeInfinity({
          authorization,
          currentMeetingId,
          infinity,
          pool,
          providerBinding,
          roomId,
          runtime: servingRuntime,
          scopeId,
          signal: controller.signal,
        });
        const actorScopedRetrievalRequestIndex =
          await proveActorScopedRetrievalRequest({
            authorization,
            infinity,
            providerBinding,
            roomId,
            runtime: servingRuntime,
            scopeId,
            signal: controller.signal,
          });
        const admittedRequest = await servingRuntime
          .createRetrievalV2Admission(providerBinding)
          .prepare({
            currentMeetingId,
            question,
            roomId,
            scopeId,
            signal: controller.signal,
          });
        if (admittedRequest.status !== "prepared") {
          throw new Error("production Retrieval V2 admission was unavailable");
        }
        assertHistoricalSelection(await servingRuntime
          .createFocusedLocatorRetrievalV2(authorization)
          .retrieveEvidence({
            authorizationPrincipalRef: "synthetic-principal",
            currentMeetingId,
            request: admittedRequest,
            roomId,
            scopeId,
            signal: controller.signal,
          }));
        const config = composedVoiceConfig(baseConfig);
        const groundedAnswers = createVoiceGroundedAnswers({
          authority: {
            historicalAuthorization: authorization,
            principalFor: async () => "synthetic-principal",
            rolloutAuthorized: async () => true,
          },
          config,
          groundedAnswerUseCase,
          historicalMemory: servingRuntime,
          liveFinalizedMemory: { query: live },
        }, {} as Client);
        if (groundedAnswers === undefined) {
          throw new Error("production voice grounded answers did not compose");
        }
        await expect(groundedAnswers.answer({
          locale: "en-US",
          meetingId: currentMeetingId,
          participantId: currentActor,
          question,
          roomId,
        }, { signal: controller.signal })).resolves.toMatchObject({
          ok: true,
          value: { status: "answered" },
        });
        assertDirectMixedEvidence(groundedFixture.observedEvidence);
        groundedFixture.resetValidated();
        await proveComposedGroundedVoice({
          groundedAnswers,
          meetingId: currentMeetingId,
          participantId: currentActor,
          question,
          roomId,
          validatedAnswerCount: groundedFixture.validatedCount,
        });
        expect(groundedFixture.observedEvidence.length).toBeGreaterThanOrEqual(2);
        const mixedEvidence = groundedFixture.observedEvidence.find((evidence) =>
          evidence.some((text) => text.startsWith(`${currentMeetingId}:`)) &&
          evidence.some((text) => text.startsWith(`${historicalMeetingId}:`))
        );
        expect(mixedEvidence).toBeDefined();
        expect(mixedEvidence?.findIndex((text) =>
          text.startsWith(`${currentMeetingId}:`)
        )).toBeLessThan(mixedEvidence?.findIndex((text) =>
          text.startsWith(`${historicalMeetingId}:`)
        ) ?? -1);
        const providerCallsBeforeRevocation = assertRetrievalRequestPrivacy(
          infinity,
          actorScopedRetrievalRequestIndex,
        );
        infinity.endpoint.setCapabilitiesQualified(false);
        await servingRuntime.assertReady();
        expect(servingRuntime.servingAuthorized()).toBe(false);
        await groundedAnswers.answer({
          locale: "en-US",
          meetingId: currentMeetingId,
          participantId: currentActor,
          question,
          roomId,
        }, { signal: controller.signal });
        expect(infinity.endpoint.requests.filter(
          ({ path }) => path === "/v1/context/retrieve",
        )).toHaveLength(providerCallsBeforeRevocation);
        const finalReplyMemory = createPersistedFocusedMemoryRoute({
          current: { retrieve: async () => ({ schemaVersion: 1, status: "low_coverage" }) },
          retrievalV2Historical:
            servingRuntime.createFocusedLocatorRetrievalV2(authorization),
        });
        await expect(finalReplyMemory.retrieve({
          authorizationPrincipalRef: "synthetic-principal",
          canonicalEvidenceHash: "a".repeat(64),
          expectedAuthorityGeneration: "generation-before-revocation",
          finalProjectionReceipt: "synthetic-final-projection",
          maximumCandidates: 24,
          meetingId: currentMeetingId,
          meetingRevision: 1,
          neighborTurns: 0,
          projectionTargetContainerId: resultsContainerId,
          question,
          retrievalBinding: {
            cutoverEpoch: "synthetic-composition-test-r1",
            profileFingerprint: providerBinding.capabilityFingerprint,
            request: admittedRequest,
            retrievalPath: "infinity_locator_v2",
          },
          roomId,
          scopeId,
          signal: controller.signal,
          transcriptId: current.transcript?.transcriptId ?? "missing-transcript",
          transcriptVersion: current.transcript?.version ?? 0,
        })).resolves.toMatchObject({ status: "unavailable" });
        expect(infinity.endpoint.requests.filter(
          ({ path }) => path === "/v1/context/retrieve",
        )).toHaveLength(providerCallsBeforeRevocation);

        infinity.endpoint.setCapabilitiesQualified(true);
        await servingRuntime.assertReady();
        expect(servingRuntime.servingAuthorized()).toBe(true);
        groundedFixture.resetValidated();
        await proveFinalReplyFactoryRuntime({
          current,
          config,
          groundedAnswerUseCase,
          historicalMemory: servingRuntime,
          observedEvidence: groundedFixture.observedEvidence,
          observedEvidenceStart: groundedFixture.observedEvidence.length,
          pool,
          validatedAnswerCount: groundedFixture.validatedCount,
        });
        expect(historical.transcript?.turns.at(-2)?.turnId)
          .toBe("history-turn-0719");
      } finally {
        controller.abort();
        if (!runtimeClosed) {
          await runtime.close();
        }
        await servingRuntime?.close();
        await infinity.close();
      }
    }, 600_000);
});

function composedVoiceConfig(baseConfig: PlatformConfig): PlatformConfig {
  return {
    ...baseConfig,
    conversation: {
      farewellCueRoot: "/tmp/synthetic-farewell",
      greetingCueRoot: "/tmp/synthetic-greeting",
      runtimeAddress: "127.0.0.1:1",
      systemPrompt: "Use only validated grounded evidence.",
      thinkingCueRoot: "/tmp/synthetic-thinking",
      voiceId: "synthetic",
      voiceProfileId: "deterministic-e2e",
    },
    meetingKnowledge: {
      ...baseConfig.meetingKnowledge,
      groundedVoice: {
        rolloutEpoch: "synthetic-composition-test-r1",
        rolloutStateFile: "/tmp/not-read-through-authority-seam",
      },
    },
    secrets: {
      ...baseConfig.secrets,
      meetingKnowledgePrincipalKey: "aa".repeat(32),
    },
  };
}

function compositionGroundedAnswers(): {
  readonly answers: GroundedMeetingAnswer;
  readonly observedEvidence: string[][];
  readonly resetValidated: () => void;
  readonly validatedCount: () => number;
} {
  const observedEvidence: string[][] = [];
  let validated = 0;
  const answers = new GroundedMeetingAnswer({
    generate: async (request) => {
      observedEvidence.push(request.plan.evidence.map(({ source, text }) =>
        `${source?.meetingId ?? "unknown"}:${text}`
      ));
      const live = request.plan.evidence.find(({ source, text }) =>
        source?.meetingId === currentMeetingId && text.includes("CURRENT-ANCHOR")
      );
      const historical = request.plan.evidence.find(({ source, text }) =>
        source?.meetingId === historicalMeetingId && text.includes("PINE-GOLF")
      );
      validated += 1;
      return {
        answer: {
          claims: [{
            evidenceIds: [live, historical]
              .filter((value) => value !== undefined)
              .map(({ evidenceId }) => evidenceId),
            text: "CURRENT-ANCHOR confirms Atlas is active; PINE-GOLF records Monday approval.",
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
      runtimeProfile: "production-composition-v2-fixture",
    }),
  }, localFinalReplyPolicy.groundingSafety);
  return {
    answers,
    observedEvidence,
    resetValidated: () => { validated = 0; },
    validatedCount: () => validated,
  };
}

async function proveConfusableIdentityAdmissionFailsBeforeInfinity(input: {
  readonly authorization: ReturnType<typeof allowOnlySyntheticRoom>;
  readonly currentMeetingId: string;
  readonly infinity: Awaited<ReturnType<typeof startDisposableInfinityHttpService>>;
  readonly pool: Pool;
  readonly providerBinding:
    NonNullable<PlatformConfig["meetingKnowledge"]>["retrievalV2ProviderBinding"];
  readonly roomId: string;
  readonly runtime: PlatformHistoricalMemoryRuntime;
  readonly scopeId: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (input.providerBinding === undefined) {
    throw new Error("synthetic Retrieval V2 binding is missing");
  }
  const retrieval = new FocusedHistoricalEvidenceV2({
    admission: input.runtime.createRetrievalV2Admission(input.providerBinding),
    retrieval: input.runtime.createFocusedLocatorRetrievalV2(input.authorization),
  });
  const connect = vi.spyOn(input.pool, "connect");
  const directQuery = vi.spyOn(input.pool, "query");
  const clientQuery = vi.spyOn(PgClient.prototype, "query");
  const authorization = vi.spyOn(input.authorization, "authorize");
  const allParsedBefore = input.infinity.endpoint.requests.length;
  const allRawBefore = input.infinity.endpoint.exactHttpRequests.length;
  const parsedBefore = input.infinity.endpoint.requests.filter(
    ({ path }) => path === "/v1/context/retrieve",
  ).length;
  const rawBefore = input.infinity.endpoint.exactHttpRequests.filter(
    ({ path }) => path === "/v1/context/retrieve",
  ).length;
  try {
    const safeRequest = await input.runtime
      .createRetrievalV2Admission(input.providerBinding)
      .prepare({
        currentMeetingId: input.currentMeetingId,
        question: "What did Vlad decide?",
        roomId: input.roomId,
        scopeId: input.scopeId,
        signal: input.signal,
      });
    expect(safeRequest.status).toBe("prepared");
    expect(connect).toHaveBeenCalled();
    expect(directQuery).not.toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalled();
    expect(authorization).not.toHaveBeenCalled();

    const connectBeforeUnsafe = connect.mock.calls.length;
    const directQueriesBeforeUnsafe = directQuery.mock.calls.length;
    const clientQueriesBeforeUnsafe = clientQuery.mock.calls.length;
    for (const question of [
      "What did Vlad and Ѵӏаԁ decide?",
      "Что решила Вова?",
      "Что решила Нора?",
      "What did Vl\u0000ad decide?",
      "What did Vl\u000Aad decide?",
      "What did Vl\u2060ad decide?",
      "What did Vl\uFE0Fad decide?",
      "What did Vl\uFFF0ad decide?",
      "What did Vl\u{E0061}ad decide?",
      "What did 🔥\uFE0F decide?",
      "What did 🔥\u0000 decide?",
      "What did 🔥\u{E0061} decide?",
      "What did 🔥\u{1F3FB} decide?",
      "What did Alice \u2060 Smith decide?",
      "What did Alice\u000ASmith decide?",
    ]) {
      await expect(retrieval.retrieve({
        authorizationPrincipalRef: "synthetic-principal",
        currentMeetingId: input.currentMeetingId,
        maximumCandidates: 24,
        question,
        roomId: input.roomId,
        scopeId: input.scopeId,
        signal: input.signal,
      })).resolves.toMatchObject({
        reason: "request_not_admitted",
        status: "unavailable",
      });
    }
    expect(connect).toHaveBeenCalledTimes(connectBeforeUnsafe);
    expect(directQuery).toHaveBeenCalledTimes(directQueriesBeforeUnsafe);
    expect(clientQuery).toHaveBeenCalledTimes(clientQueriesBeforeUnsafe);
    expect(authorization).not.toHaveBeenCalled();
  } finally {
    authorization.mockRestore();
    clientQuery.mockRestore();
    directQuery.mockRestore();
    connect.mockRestore();
  }
  expect(input.infinity.endpoint.requests.filter(
    ({ path }) => path === "/v1/context/retrieve",
  )).toHaveLength(parsedBefore);
  expect(input.infinity.endpoint.exactHttpRequests.filter(
    ({ path }) => path === "/v1/context/retrieve",
  )).toHaveLength(rawBefore);
  expect(input.infinity.endpoint.requests).toHaveLength(allParsedBefore);
  expect(input.infinity.endpoint.exactHttpRequests).toHaveLength(allRawBefore);
}

async function proveFinalReplyFactoryRuntime(input: {
  readonly config: PlatformConfig;
  readonly current: MeetingSnapshot;
  readonly groundedAnswerUseCase: GroundedMeetingAnswer;
  readonly historicalMemory: PlatformHistoricalMemoryRuntime;
  readonly observedEvidence: readonly (readonly string[])[];
  readonly observedEvidenceStart: number;
  readonly pool: Pool;
  readonly validatedAnswerCount: () => number;
}): Promise<void> {
  const participantId = currentActor;
  const questionId = "777777777777777701";
  const projectionMessageId = input.current.publication?.externalPublicationId
    .split(":").at(-1);
  if (projectionMessageId === undefined) {
    throw new Error("synthetic current meeting lacks a publication binding");
  }
  const sourceConfigurations = new PostgresMeetingSourceConfigurationRepository(
    input.pool,
  );
  await sourceConfigurations.save(MeetingSourceConfiguration.configure({
    configuredByActorId: participantId,
    publicationTargetId: resultsContainerId,
    roomId,
    sourceId: scopeId,
  }).toSnapshot(), null);
  const { client, emitQuestion } = finalReplyDiscordIngress(
    participantId,
    projectionMessageId,
  );
  const deliveries: Parameters<AnswerDeliveryPort["create"]>[0][] = [];
  let loseCommittedResponse = true;
  const answerDelivery: AnswerDeliveryPort = {
    create: async (request) => {
      deliveries.push(request);
      if (loseCommittedResponse) {
        loseCommittedResponse = false;
        throw new Error("synthetic committed Discord response loss");
      }
      return "888888888888888888";
    },
    inspect: async (request) => deliveries.some(({ marker }) =>
      marker === request.marker
    )
      ? { externalReceipt: "888888888888888888", status: "found" }
      : { status: "unconfirmed" },
    remove: async () => {},
  };
  const runtimeInput = {
    answerDelivery,
    answers: input.groundedAnswerUseCase,
    client,
    config: {
      ...input.config,
      meetingKnowledge: {
        ...input.config.meetingKnowledge,
        localFinalReply: true,
      },
    },
    historicalMemory: input.historicalMemory,
    logger: silentLogger,
    pool: input.pool,
    runtimeTransport: syntheticCoverageRuntime,
    sourceConfigurations,
  } as const;
  const firstRuntime = createMeetingKnowledgeLocalFinalReply(runtimeInput);
  firstRuntime.start();
  emitQuestion(questionId, scopeId);
  emitQuestion(questionId, scopeId);
  emitQuestion("777777777777777702", "999999999999999999");
  await firstRuntime.settleIngress();
  await firstRuntime.processPending();
  expect(input.validatedAnswerCount()).toBe(1);
  assertFinalReplyMixedEvidence(input.observedEvidence.slice(
    input.observedEvidenceStart,
  ));
  if (deliveries.length === 0) {
    const diagnostics = await Promise.all([
      input.pool.query<Record<string, unknown>>(
        "SELECT question_id, state, outcome FROM meeting_knowledge.question_jobs",
      ),
      input.pool.query<Record<string, unknown>>(
        "SELECT effect_id, state FROM meeting_core.answer_effects",
      ),
    ]);
    throw new Error(`final reply runtime produced no delivery: ${JSON.stringify(
      diagnostics.map(({ rows }) => rows),
    )}`);
  }
  expect(deliveries).toHaveLength(1);
  await expect(input.pool.query<{ readonly state: string }>(
    "SELECT state FROM meeting_core.answer_effects WHERE effect_id = $1",
    [`meeting-knowledge-answer:v1:${questionId}`],
  )).resolves.toMatchObject({ rows: [{ state: "outcome_unknown" }] });
  await firstRuntime.close();

  const restarted = createMeetingKnowledgeLocalFinalReply(runtimeInput);
  restarted.start();
  await restarted.reconcilePending();
  await restarted.processPending();
  await restarted.close();
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]).toMatchObject({
    deliveryContainerId: resultsContainerId,
    projectionTargetContainerId: resultsContainerId,
    replyToRemoteMessageId: questionId,
  });
  expect(deliveries[0]?.payloadBytes).toContain("CURRENT-ANCHOR");
  expect(deliveries[0]?.payloadBytes).toContain("history-turn-0719");
  await expect(input.pool.query<{ readonly question_id: string;
    readonly state: string }>(
    "SELECT question_id, state FROM meeting_knowledge.question_jobs",
  )).resolves.toMatchObject({ rows: [{ question_id: questionId,
    state: "terminal" }] });
  await expect(input.pool.query<{ readonly effect_id: string;
    readonly state: string }>(
    "SELECT effect_id, state FROM meeting_core.answer_effects",
  )).resolves.toMatchObject({ rows: [{
    effect_id: `meeting-knowledge-answer:v1:${questionId}`, state: "delivered",
  }] });

  const unavailableHistory = unavailableHistoryAnswersFixture(
    localFinalReplyPolicy.groundingSafety,
  );
  const withoutHistorical = createMeetingKnowledgeLocalFinalReply({
    answerDelivery: runtimeInput.answerDelivery,
    answers: unavailableHistory.answers,
    client: runtimeInput.client,
    config: runtimeInput.config,
    logger: runtimeInput.logger,
    pool: runtimeInput.pool,
    runtimeTransport: runtimeInput.runtimeTransport,
    sourceConfigurations: runtimeInput.sourceConfigurations,
  });
  withoutHistorical.start();
  emitQuestion("777777777777777703", scopeId);
  await withoutHistorical.settleIngress();
  await withoutHistorical.processPending();
  await withoutHistorical.close();
  await assertUnavailableHistoryFinalReplyState(input.pool);
  expect(unavailableHistory.calls()).toBe(0);
  expect(deliveries).toHaveLength(1);
}

function finalReplyDiscordIngress(
  participantId: string,
  projectionMessageId: string,
): {
  readonly client: Client;
  readonly emitQuestion: (questionId: string, guildId: string) => void;
} {
  const permissionSet = {
    bitfield: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory,
    has: (permission: bigint) => permission === PermissionFlagsBits.ViewChannel ||
      permission === PermissionFlagsBits.ReadMessageHistory,
  };
  const messages = new Map<string, {
    readonly author: { readonly bot?: boolean; readonly id: string };
    readonly channelId: string;
    readonly content: string;
    readonly guildId: string;
    readonly id: string;
    readonly reference?: { readonly channelId: string; readonly messageId: string };
    readonly webhookId: null;
  }>();
  messages.set(projectionMessageId, {
    author: { bot: true, id: "111111111111111111" },
    channelId: resultsContainerId,
    content: "Synthetic canonical live projection",
    guildId: scopeId,
    id: projectionMessageId,
    webhookId: null,
  });
  const channel = {
    id: resultsContainerId,
    isThread: () => false,
    isTextBased: () => true,
    messages: {
      fetch: ({ message }: { readonly message: string }) => {
        const current = messages.get(message);
        return current === undefined
          ? Promise.reject(new Error("synthetic Discord message is absent"))
          : Promise.resolve(current);
      },
    },
    permissionsFor: () => permissionSet,
    type: ChannelType.GuildText,
  };
  const guild = {
    channels: { fetch: () => Promise.resolve(channel) },
    members: { fetch: () => Promise.resolve({ id: participantId }) },
    roles: { fetch: () => Promise.resolve() },
  };
  const emitter = new EventEmitter();
  const client = Object.assign(emitter, {
    channels: { fetch: () => Promise.resolve(channel) },
    guilds: { fetch: () => Promise.resolve(guild) },
    user: { id: "111111111111111111" },
  }) as unknown as Client;
  return {
    client,
    emitQuestion: (questionId, guildId) => {
      const question = {
        author: { bot: false, id: participantId },
        channel,
        channelId: resultsContainerId,
        content: mixedLaneQuestion,
        guildId,
        id: questionId,
        reference: {
          channelId: resultsContainerId,
          messageId: projectionMessageId,
        },
        webhookId: null,
      };
      messages.set(questionId, question);
      emitter.emit("messageCreate", question);
    },
  };
}

async function createLiveProjection(
  pool: Pool,
  current: MeetingSnapshot,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (current.transcript === null) {
    throw new Error("synthetic current meeting has no final transcript");
  }
  const meetings = new PostgresLiveMeetingRepository(pool);
  await meetings.save(LiveMeeting.start({
    meetingId: currentMeetingId,
    publicationTargetId: resultsContainerId,
    startedAtMs: 0,
  }).toSnapshot(), null);
  for (const turn of current.transcript.turns) {
    await meetings.appendFinalizedTurn(currentMeetingId, turn);
  }
  const lifecycle = new PostgresLiveFinalizedMemoryLifecycle(pool);
  await lifecycle.registerMeeting({
    actors: [{ actorId: currentActor, kind: "human" }],
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "f".repeat(40),
      rosterState: "unsealed",
    },
    lifecycleGeneration: 3,
    meetingId: currentMeetingId,
    roomId,
    scopeId,
  });
  const worker = new LiveFinalizedMemoryWorker(
    new PostgresLiveFinalizedMemoryStore(pool),
    { hash: canonicalFinalReplyTurnHash },
  );
  for (;;) {
    const result = await worker.executeOnce({ meetingId: currentMeetingId });
    if (result.status === "idle") {
      break;
    }
  }
  return new PostgresLiveFinalizedMemoryQuery(pool);
}

function requiredDatabase(): Pool {
  if (database === undefined) {
    throw new Error("mandatory PostgreSQL qualification database was not initialized");
  }
  return database;
}
