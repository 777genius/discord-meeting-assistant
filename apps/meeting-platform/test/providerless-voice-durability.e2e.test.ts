import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PostgresMigrationRunner } from "@discord-meeting/postgres-adapter";
import { Pool, type PoolConfig } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { stableLiveTranscriptTurnId } from "../src/live-runtime/transcript-turn-id.js";
import {
  composePhase,
  GroundedAnswerProbe,
  hardGreetingLatencyMs,
  oneMinuteMs,
  packetBatch,
  participantEvent,
  participantOne,
  participantTwo,
  type QualificationPhase,
  runMinute,
  startEvent,
  transcript,
  twoHoursMs,
  VirtualClock,
} from "./providerless-voice-durability-fixtures.js";
import {
  audioChunks,
  completedReceiptStates,
  completedTurn,
  expectAuthoritativeRecording,
  farewellSha256,
  greetingStarts,
  playbackStarts,
  readEvents,
  readGreetingManifest,
  turnPcmSha256,
  waitForEvidence,
  waitForPersistedTurn,
} from "./providerless-voice-durability-recording.js";

const postgresImage =
  "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const postgresPort = 5_432;
let container: StartedTestContainer | undefined;
let databaseOptions: PoolConfig | undefined;

beforeAll(async () => {
  const databaseName = `voice_durability_test_${randomUUID().replaceAll("-", "")}`;
  const useHostNetwork = process.env.VOICE_DURABILITY_HOST_NETWORK === "true";
  let postgres = new GenericContainer(postgresImage)
    .withEnvironment({
      POSTGRES_DB: databaseName,
      POSTGRES_PASSWORD: "synthetic-only",
      POSTGRES_USER: databaseName,
    })
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/u, 2),
    )
    .withStartupTimeout(120_000);
  postgres = useHostNetwork
    ? postgres.withNetworkMode("host")
    : postgres.withExposedPorts(postgresPort);
  container = await postgres.start();
  databaseOptions = {
    database: databaseName,
    host: useHostNetwork ? "127.0.0.1" : container.getHost(),
    password: "synthetic-only",
    port: useHostNetwork ? postgresPort : container.getMappedPort(postgresPort),
    user: databaseName,
  };
  const bootstrap = new Pool(databaseOptions);
  try {
    await new PostgresMigrationRunner(bootstrap).migrate();
  } finally {
    await bootstrap.end();
  }
}, 150_000);

afterAll(async () => {
  await container?.stop();
});

describe("providerless production-composition voice durability", () => {
  it("qualifies two compressed hours across durable playback and owner restart", async () => {
    const meetingId = `voice-durability-${randomUUID()}`;
    const recordingRoot = await mkdtemp(join(tmpdir(), "voice-durability-recording-"));
    const startedAtMs = 1_800_000_000_000;
    const startedAt = new Date(startedAtMs).toISOString();
    let first: QualificationPhase | undefined;
    let restarted: QualificationPhase | undefined;
    try {
      first = await composePhase({
        clock: new VirtualClock(startedAtMs),
        database: requiredDatabaseOptions(),
        groundedAnswers: new GroundedAnswerProbe("unused-first-owner"),
        meetingId,
        phase: "owner-1",
        recordingRoot,
      });
      await first.runtime.acceptLifecycle(startEvent(meetingId, startedAt, []));

      const firstGreetingAt = performance.now();
      await first.runtime.acceptLifecycle(participantEvent(
        meetingId,
        first.clock,
        "participant.joined",
        participantOne,
      ));
      await waitForEvidence(
        recordingRoot,
        (events) => audioChunks(events, `participant-greeting:${participantOne}`).length > 0,
        hardGreetingLatencyMs,
      );
      expect(performance.now() - firstGreetingAt).toBeLessThan(hardGreetingLatencyMs);
      await waitForEvidence(
        recordingRoot,
        (events) => completedTurn(events, `participant-greeting:${participantOne}`),
      );

      const secondGreetingAt = performance.now();
      await first.runtime.acceptLifecycle(participantEvent(
        meetingId,
        first.clock,
        "participant.joined",
        participantTwo,
      ));
      await waitForEvidence(
        recordingRoot,
        (events) => audioChunks(events, `participant-greeting:${participantTwo}`).length > 0,
        hardGreetingLatencyMs,
      );
      expect(performance.now() - secondGreetingAt).toBeLessThan(hardGreetingLatencyMs);
      await waitForEvidence(
        recordingRoot,
        (events) => completedTurn(events, `participant-greeting:${participantTwo}`),
      );
      expect(await completedReceiptStates(first.pool)).toEqual([
        "played",
        "played",
      ]);

      for (let minute = 1; minute <= 60; minute += 1) {
        await runMinute(first, meetingId, startedAtMs, minute, `Status update ${minute}.`);
      }
      await first.runtime.acceptLifecycle({
        occurredAt: first.clock.isoNow(),
        recordingId: meetingId,
        type: "meeting.connection_lost",
      });
      const beforeRestart = await first.releaseForRestart();
      expect(beforeRestart?.snapshot.status).toBe("active");
      expect(first.transcriber.activeSessions).toBe(0);
      expect(first.transport.activeAttempts).toBe(0);

      const evidenceEvent = transcript(
        meetingId,
        participantOne,
        7_080_000 - 500,
        7_080_000,
        "We decided to ship Friday.",
      );
      const evidenceTurnId = stableLiveTranscriptTurnId(evidenceEvent);
      const groundedAnswers = new GroundedAnswerProbe(evidenceTurnId);
      restarted = await composePhase({
        clock: new VirtualClock(startedAtMs + 3_600_000),
        database: requiredDatabaseOptions(),
        groundedAnswers,
        meetingId,
        phase: "owner-2",
        recordingRoot,
      });
      await restarted.runtime.acceptLifecycle(startEvent(meetingId, startedAt, []));
      await restarted.runtime.acceptLifecycle(participantEvent(
        meetingId,
        restarted.clock,
        "participant.joined",
        participantOne,
      ));
      await restarted.runtime.acceptLifecycle(participantEvent(
        meetingId,
        restarted.clock,
        "participant.joined",
        participantTwo,
      ));
      await restarted.clock.advanceTo(startedAtMs + 3_610_000);
      await restarted.coordinator.whenIdle(meetingId);
      expect(await completedReceiptStates(restarted.pool)).toEqual([
        "played",
        "played",
      ]);
      expect(greetingStarts(await readEvents(recordingRoot))).toHaveLength(2);

      for (let minute = 61; minute <= 117; minute += 1) {
        await runMinute(
          restarted,
          meetingId,
          startedAtMs,
          minute,
          `Status update ${minute}.`,
        );
      }
      await runMinute(
        restarted,
        meetingId,
        startedAtMs,
        118,
        evidenceEvent.text,
      );
      await waitForPersistedTurn(restarted.meetings, meetingId, evidenceTurnId);

      const questionEvent = await runMinute(
        restarted,
        meetingId,
        startedAtMs,
        119,
        "Botik, what did we decide?",
      );
      const questionTurnId = stableLiveTranscriptTurnId(questionEvent);
      await waitForEvidence(
        recordingRoot,
        (events) => audioChunks(events, questionTurnId).length === 1,
      );
      await restarted.clock.advanceTo(startedAtMs + 119 * oneMinuteMs + 4_001);
      await restarted.runtime.acceptVoiceBatch(packetBatch(
        meetingId,
        participantTwo,
        119 * oneMinuteMs + 4_000,
        10_119,
        startedAtMs + 119 * oneMinuteMs + 4_001,
      ));
      restarted.transcriber.emit(participantTwo, {
        ...transcript(
          meetingId,
          participantTwo,
          119 * oneMinuteMs + 3_900,
          119 * oneMinuteMs + 4_000,
          "interrupting",
        ),
        isFinal: false,
      });
      await waitForEvidence(
        recordingRoot,
        (events) => events.some((event) =>
          event.turnId === questionTurnId && event.type === "playback-cancel"
        ),
      );
      restarted.conversationRuntime.releaseLateChunk();
      await restarted.coordinator.whenIdle(meetingId);

      assertGroundedTurn(
        restarted, groundedAnswers, evidenceTurnId, questionTurnId,
      );

      const farewellEvent = await runMinute(
        restarted,
        meetingId,
        startedAtMs,
        120,
        "Bye everyone!",
      );
      await restarted.clock.advanceTo(startedAtMs + twoHoursMs + 100);
      await waitForEvidence(
        recordingRoot,
        (events) => completedTurn(events, "meeting-farewell:v1"),
      );
      restarted.transcriber.emit(participantOne, farewellEvent);
      await restarted.clock.advanceTo(startedAtMs + twoHoursMs + 10_000);

      await restarted.runtime.acceptLifecycle({
        occurredAt: restarted.clock.isoNow(),
        recordingId: meetingId,
        type: "meeting.ended",
      });
      await restarted.runtime.settleBeforeFinalPublication(meetingId);
      await restarted.transport.finalizeAuthoritativeRecording();

      const persisted = await restarted.meetings.readSnapshotAndTimeline(meetingId);
      expect(persisted?.snapshot.status).toBe("ended");
      expect(persisted?.timeline).toHaveLength(120);
      expect(persisted?.timeline.some(({ turn }) => turn.turnId === evidenceTurnId))
        .toBe(true);
      expect(persisted?.timeline.some(({ turn }) => turn.turnId === questionTurnId))
        .toBe(true);
      expect(Math.max(...(persisted?.timeline.map(({ turn }) => turn.endMs) ?? [])))
        .toBe(twoHoursMs);
      expect(await completedReceiptStates(restarted.pool)).toEqual([
        "played",
        "played",
        "played",
      ]);

      const events = await readEvents(recordingRoot);
      expect(greetingStarts(events)).toHaveLength(2);
      expect(playbackStarts(events, "meeting-farewell:v1")).toHaveLength(1);
      expect(completedTurn(events, "meeting-farewell:v1")).toBe(true);
      expect(audioChunks(events, questionTurnId)).toHaveLength(1);
      const cancelIndex = events.findIndex((event) =>
        event.turnId === questionTurnId && event.type === "playback-cancel"
      );
      expect(cancelIndex).toBeGreaterThanOrEqual(0);
      expect(events.slice(cancelIndex + 1).some((event) =>
        event.turnId === questionTurnId && event.type === "audio-chunk"
      )).toBe(false);

      const greetingManifest = await readGreetingManifest();
      expect(turnPcmSha256(events, `participant-greeting:${participantOne}`)).toBe(
        greetingManifest.get("Привет, Тест А!"),
      );
      expect(turnPcmSha256(events, `participant-greeting:${participantTwo}`)).toBe(
        greetingManifest.get("Hi, Test B!"),
      );
      expect(turnPcmSha256(events, "meeting-farewell:v1")).toBe(
        await farewellSha256("en"),
      );
      await expectAuthoritativeRecording(recordingRoot, meetingId);

      expect(restarted.transcriber.totalPackets).toBeGreaterThanOrEqual(61);
      expect(first.transcriber.totalPackets + restarted.transcriber.totalPackets)
        .toBeGreaterThanOrEqual(121);
      expect(restarted.transcriber.peakActiveSessions).toBeLessThanOrEqual(2);
      expect(restarted.transcriber.peakPendingPacketWrites).toBeLessThanOrEqual(1);
      expect(restarted.transcriber.activeSessions).toBe(0);
      expect(restarted.transport.peakActiveAttempts).toBeLessThanOrEqual(1);
      expect(restarted.transport.peakPendingWrites).toBeLessThanOrEqual(1);
      expect(restarted.transport.peakBufferedBytes).toBeGreaterThan(0);
      expect(restarted.transport.peakBufferedBytes).toBeLessThanOrEqual(3_840);
      expect(restarted.transport.activeAttempts).toBe(0);
      expect(restarted.transport.pendingWrites).toBe(0);
      expect(restarted.conversationRuntime.maximumActiveTurns).toBe(1);
      expect(restarted.conversationRuntime.activeTurns).toBe(0);
      expect(restarted.projector.requests.length).toBeLessThanOrEqual(256);
      expect(restarted.summarizer.requests.length).toBeLessThanOrEqual(256);
    } finally {
      await restarted?.closeFinal().catch(() => {});
      await first?.closeFinal().catch(() => {});
      await rm(recordingRoot, { force: true, recursive: true });
    }
  }, 180_000);
});

function assertGroundedTurn(
  phase: QualificationPhase,
  groundedAnswers: GroundedAnswerProbe,
  evidenceTurnId: string,
  questionTurnId: string,
): void {
  expect(groundedAnswers.answerRequests).toHaveLength(1);
  expect(groundedAnswers.recheckRequests).toHaveLength(1);
  expect(groundedAnswers.recheckRequests[0]?.citationTurnIds).toEqual([
    evidenceTurnId,
  ]);
  expect(phase.conversationRuntime.requests).toHaveLength(1);
  expect(phase.conversationRuntime.requests[0]).toMatchObject({
    literalSpeech: "We decided to ship Friday.",
    turnId: questionTurnId,
  });
  expect(phase.conversationRuntime.cancelReasons).toContain("barge-in");
}

function requiredDatabaseOptions(): PoolConfig {
  if (databaseOptions === undefined) {
    throw new Error("disposable PostgreSQL was not initialized");
  }
  return databaseOptions;
}
