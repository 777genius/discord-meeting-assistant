import {
  startDisposableInfinityHttpService,
} from "@discord-meeting/infinity-context-adapter/test-support";
import {
  GroundedMeetingAnswer,
  LiveFinalizedMemoryWorker,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { LiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import type { MeetingSnapshot } from
  "@discord-meeting/meeting-core/meeting-lifecycle";
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
import type { Client } from "discord.js";
import { Pool } from "pg";
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
  persistPublishedMeeting,
  platformConfig,
  requiredHistoricalRuntime,
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

const postgresImage =
  "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const postgresPort = 5_432;
let container: StartedTestContainer | undefined;
let database: Pool | undefined;
const externalPostgresUrl = disposableExternalPostgresUrl(process.env);

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
      const runtime = requiredHistoricalRuntime(pool, infinity, true, true);
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
        servingRuntime = requiredHistoricalRuntime(pool, infinity, true, true);
        await servingRuntime.assertReady();

        const live = await createLiveProjection(pool, current, controller.signal);
        const authorization = allowOnlySyntheticRoom();
        const question = `How does <@${historicalActorA}> VLAD-Vlad, vlad_vLaD, and Vladimir   VLADIMIR's ANCHOR connect to PINE-GOLF?`;
        const observedEvidence: string[][] = [];
        let validatedAnswers = 0;
        const groundedAnswerUseCase = new GroundedMeetingAnswer({
          generate: async (request) => {
              observedEvidence.push(request.plan.evidence.map(({ source, text }) =>
                `${source?.meetingId ?? "unknown"}:${text}`
              ));
              const liveEvidence = request.plan.evidence.find(({ source, text }) =>
                source?.meetingId === currentMeetingId && text.includes("CURRENT-ANCHOR")
              );
              const historicalEvidenceTurn = request.plan.evidence.find(
                ({ source, text }) => source?.meetingId === historicalMeetingId &&
                  text.includes("PINE-GOLF"),
              );
              validatedAnswers += 1;
              return {
                answer: {
                  claims: [{
                    evidenceIds: [liveEvidence, historicalEvidenceTurn]
                      .filter((value) => value !== undefined)
                      .map(({ evidenceId }) => evidenceId),
                    text: "CURRENT-ANCHOR links Atlas to historical PINE-GOLF evidence.",
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
        const baseConfig = platformConfig(infinity.baseUrl, true, true, "test");
        const providerBinding = baseConfig.meetingKnowledge?.retrievalV2ProviderBinding;
        if (providerBinding === undefined) {
          throw new Error("synthetic Retrieval V2 binding is missing");
        }
        const admittedRequest = await servingRuntime
          .createRetrievalV2Admission(providerBinding)
          .prepare({
            currentMeetingId,
            question,
            roomId,
            scopeId,
            signal: controller.signal,
          });
        if (admittedRequest === null) {
          throw new Error("production Retrieval V2 admission was unavailable");
        }
        const config = {
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
        } as const;
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
        validatedAnswers = 0;
        await proveComposedGroundedVoice({
          groundedAnswers,
          meetingId: currentMeetingId,
          participantId: currentActor,
          question,
          roomId,
          validatedAnswerCount: () => validatedAnswers,
        });

        expect(observedEvidence.length).toBeGreaterThanOrEqual(2);
        const mixedEvidence = observedEvidence.find((evidence) =>
          evidence.some((text) => text.startsWith(`${currentMeetingId}:`)) &&
          evidence.some((text) => text.startsWith(`${historicalMeetingId}:`))
        );
        expect(mixedEvidence).toBeDefined();
        expect(mixedEvidence?.findIndex((text) =>
          text.startsWith(`${currentMeetingId}:`)
        )).toBeLessThan(mixedEvidence?.findIndex((text) =>
          text.startsWith(`${historicalMeetingId}:`)
        ) ?? -1);
        const providerCallsBeforeRevocation = assertRetrievalRequestPrivacy(infinity);
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

        await proveFinalReplyFactoryHistoricalWiring({
          config,
          groundedAnswerUseCase,
          historicalMemory: servingRuntime,
          pool,
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

async function proveFinalReplyFactoryHistoricalWiring(input: {
  readonly config: PlatformConfig;
  readonly groundedAnswerUseCase: GroundedMeetingAnswer;
  readonly historicalMemory: PlatformHistoricalMemoryRuntime;
  readonly pool: Pool;
}): Promise<void> {
  const createFocusedLocatorRetrievalV2 = vi.fn(
    (authorization: Parameters<
      PlatformHistoricalMemoryRuntime["createFocusedLocatorRetrievalV2"]
    >[0]) => input.historicalMemory.createFocusedLocatorRetrievalV2(authorization),
  );
  const finalReplyRuntime = createMeetingKnowledgeLocalFinalReply({
    answerDelivery: {
      create: async () => "888888888888888888",
      inspect: async () => ({ status: "unconfirmed" }),
      remove: async () => {},
    },
    answers: input.groundedAnswerUseCase,
    client: {} as Client,
    config: {
      ...input.config,
      meetingKnowledge: {
        ...input.config.meetingKnowledge,
        localFinalReply: true,
      },
    },
    historicalMemory: {
      ...input.historicalMemory,
      createFocusedLocatorRetrievalV2,
    },
    logger: silentLogger,
    pool: input.pool,
    runtimeTransport: syntheticCoverageRuntime,
    sourceConfigurations:
      new PostgresMeetingSourceConfigurationRepository(input.pool),
  });
  expect(createFocusedLocatorRetrievalV2).toHaveBeenCalledOnce();
  await finalReplyRuntime.close();
}

function assertRetrievalRequestPrivacy(
  infinity: Awaited<ReturnType<typeof startDisposableInfinityHttpService>>,
): number {
  const retrievalRequests = infinity.endpoint.requests.filter(
    ({ path }) => path === "/v1/context/retrieve",
  );
  expect(retrievalRequests.length).toBeGreaterThanOrEqual(2);
  const projectedActorKeys = infinity.endpoint.requests
    .filter(({ path }) => path === "/v1/documents")
    .flatMap(({ body }) => (body as null | { readonly retrieval_projection?: {
      readonly actor_keys?: readonly string[] } })
      ?.retrieval_projection?.actor_keys ?? []);
  for (const request of retrievalRequests) {
    const actorKeys = (request.body as null | { readonly filters?: {
      readonly actor_keys?: readonly string[] } })?.filters?.actor_keys ?? [];
    expect(actorKeys).toHaveLength(2);
    expect(actorKeys.map((key) => key.split(".")[1])).toEqual([
      "synthetic-r0",
      "synthetic-r1",
    ]);
    expect(JSON.stringify(request.body)).not.toMatch(
      new RegExp([currentActor, historicalActorA, historicalActorB,
        "Vlad", "Vladimir"].join("|"), "u"),
    );
    expect(JSON.stringify(request.body)).toMatch(/ANCHOR.*PINE-GOLF/u);
    expect(projectedActorKeys).toEqual(expect.arrayContaining(
      actorKeys.filter((key) => key.startsWith("dactor1.synthetic-r1.")),
    ));
  }
  const exactRetrievalBodies = infinity.endpoint.exactHttpRequests
    .filter(({ path }) => path === "/v1/context/retrieve")
    .map(({ bodyBytes }) => new TextDecoder().decode(bodyBytes));
  expect(exactRetrievalBodies).toHaveLength(retrievalRequests.length);
  for (const body of exactRetrievalBodies) {
    expect(body).not.toMatch(
      new RegExp([currentActor, historicalActorA, historicalActorB,
        "Vlad", "Vladimir"].join("|"), "iu"),
    );
    expect(body).toMatch(/ANCHOR.*PINE-GOLF/u);
  }
  return retrievalRequests.length;
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
