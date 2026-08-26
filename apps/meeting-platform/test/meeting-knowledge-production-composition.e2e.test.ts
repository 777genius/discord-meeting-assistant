import { createHash } from "node:crypto";

import {
  InfinityContextRetrievalV2Adapter,
} from "@discord-meeting/infinity-context-adapter";
import {
  startDisposableInfinityHttpService,
} from "@discord-meeting/infinity-context-adapter/test-support";
import {
  AnswerGroundedMeetingQuestion,
  FocusedHistoricalEvidenceV2,
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
  PostgresMeetingRepository,
  PostgresMigrationRunner,
  canonicalFinalReplyTurnHash,
} from "@discord-meeting/postgres-adapter";
import { Pool } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MeetingKnowledgeGroundedAnswerAcl } from
  "../src/adapters/outbound/meeting-knowledge-grounded-answer-acl.js";
import { localFinalReplyPolicy } from "../src/composition/meeting-knowledge.js";
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
      const controller = new AbortController();
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

        const live = await createLiveProjection(pool, current, controller.signal);
        const authorization = allowOnlySyntheticRoom();
        const providerBinding = platformConfig(
          infinity.baseUrl, true, true, "test",
        ).meetingKnowledge?.retrievalV2ProviderBinding;
        if (providerBinding === undefined) {
          throw new Error("synthetic Retrieval V2 binding is missing");
        }
        const historicalEvidence = new FocusedHistoricalEvidenceV2({
          admission: runtime.createRetrievalV2Admission(providerBinding),
          retrieval: runtime.createFocusedLocatorRetrievalV2(authorization),
        });
        const question = "How does Vlad's ANCHOR connect to PINE-GOLF?";
        const prepared = await runtime.createRetrievalV2Admission(providerBinding)
          .prepare({
            currentMeetingId,
            question,
            roomId,
            scopeId,
            signal: controller.signal,
          });
        if (prepared === null) {
          throw new Error("V2 production admission was unavailable");
        }
        await expect(new InfinityContextRetrievalV2Adapter({
          baseUrl: infinity.baseUrl,
          operationTimeoutMs: 4_000,
          requestTimeoutMs: 2_000,
          token: () => "synthetic-infinity-token",
        }).retrieve(prepared, { signal: controller.signal })).resolves.toMatchObject({
          status: "available",
        });
        const historicalProbe = await historicalEvidence.retrieve({
          authorizationPrincipalRef: "synthetic-principal",
          currentMeetingId,
          maximumCandidates: 24,
          question,
          roomId,
          scopeId,
          signal: controller.signal,
        });
        expect(historicalProbe).toMatchObject({ status: "current" });
        if (historicalProbe.status === "current") {
          expect(historicalProbe.turns.map(({ text }) => text).join("\n"))
            .toContain("PINE-GOLF");
        }
        const observedEvidence: string[][] = [];
        const answerUseCase = new AnswerGroundedMeetingQuestion({
          answers: new GroundedMeetingAnswer({
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
          }, localFinalReplyPolicy.groundingSafety),
          authorization,
          historical: historicalEvidence,
          ids: {
            digest: (namespace, parts) => createHash("sha256")
              .update(JSON.stringify([namespace, ...parts]), "utf8")
              .digest("hex"),
          },
          live,
          turnHashes: { hash: canonicalFinalReplyTurnHash },
        });
        let validatedAnswers = 0;
        const acl = new MeetingKnowledgeGroundedAnswerAcl({
          execute: async (request, options) => {
            const result = await answerUseCase.execute({
              ...request,
              authorizationPrincipalRef: "synthetic-principal",
            }, options);
            if (result.status === "answered") {
              validatedAnswers += 1;
            }
            return result;
          },
          recheckPlaybackAuthority: async (request, options) =>
            answerUseCase.recheckPlaybackAuthority({
              ...request,
              authorizationPrincipalRef: "synthetic-principal",
            }, options),
        });
        const direct = await answerUseCase.execute({
          activeParticipantId: currentActor,
          authorizationPrincipalRef: "synthetic-principal",
          locale: "en-US",
          meetingId: currentMeetingId,
          question,
          roomId,
        }, { signal: controller.signal });
        expect(direct).toMatchObject({ status: "answered" });
        expect(observedEvidence[0]).toEqual(expect.arrayContaining([
          expect.stringContaining(`${currentMeetingId}:`),
          expect.stringContaining(`${historicalMeetingId}:`),
        ]));
        await proveComposedGroundedVoice({
          groundedAnswers: acl,
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
        const retrievalRequests = infinity.endpoint.requests.filter(
          ({ path }) => path === "/v1/context/retrieve",
        );
        expect(retrievalRequests.length).toBeGreaterThanOrEqual(3);
        for (const request of retrievalRequests) {
          const actorKeys = (request.body as { readonly filters?: {
            readonly actor_keys?: readonly string[] } })?.filters?.actor_keys ?? [];
          expect(actorKeys.length).toBeGreaterThan(0);
          expect(actorKeys.every((key) => key.startsWith("dactor1."))).toBe(true);
          expect(JSON.stringify(actorKeys)).not.toMatch(
            new RegExp([currentActor, historicalActorA, historicalActorB,
              "Vlad", "Vladimir"].join("|"), "u"),
          );
          const projectedActorKeys = infinity.endpoint.requests
            .filter(({ path }) => path === "/v1/documents")
            .flatMap(({ body }) => (body as { readonly retrieval_projection?: {
              readonly actor_keys?: readonly string[] } })
              ?.retrieval_projection?.actor_keys ?? []);
          expect(projectedActorKeys).toEqual(expect.arrayContaining([...actorKeys]));
        }
        expect(historical.transcript?.turns.at(-2)?.turnId)
          .toBe("history-turn-0719");
      } finally {
        controller.abort();
        await runtime.close();
        await infinity.close();
      }
    }, 600_000);
});

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
