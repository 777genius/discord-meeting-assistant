import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PostgresConversationOneShotReceiptStore,
  PostgresMigrationRunner,
} from "@discord-meeting/postgres-adapter";
import {
  DiscordSummaryPublicationAdapter,
  type DiscordProjectionReference,
  type PublishDiscordSummary,
} from "@discord-meeting/discord-adapter";
import type { SummaryPublicationRequest } from "@discord-meeting/meeting-core/publishing";
import { Pool, type PoolConfig } from "pg";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PlatformConfig } from "../src/config.js";
import { stableLiveTranscriptTurnId } from "../src/live-runtime/transcript-turn-id.js";
import type { LiveConversationOneShotReceiptPort } from
  "../src/live-runtime/contracts.js";
import { PostgresRecordingPublicationReconciliation } from
  "../src/recording-playback/adapters/index.js";
import {
  composePhase,
  departedParticipant,
  GroundedAnswerProbe,
  hardGreetingLatencyMs,
  oneMinuteMs,
  packetBatch,
  participantEvent,
  participantOne,
  participantTwo,
  type QualificationPhase,
  runMinute,
  sevenSyntheticParticipants,
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
  turnPcmSha256,
  waitForEvidence,
  waitForPersistedTurn,
} from "./providerless-voice-durability-recording.js";

const postgresImage =
  "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const postgresPort = 5_432;
const maximumLengthSyntheticProfiles = Object.freeze(Object.fromEntries(
  sevenSyntheticParticipants.map((participantId, index) => {
    const ordinal = index + 1;
    const displayName = `Synthetic-${ordinal}-`.padEnd(100, String(ordinal));
    const spokenName = index === 0
      ? `Синтетический-${ordinal}-`.padEnd(100, "Я")
      : displayName;
    return [participantId, Object.freeze({
      displayName,
      greetingLocale: index === 0 ? "ru" as const : "en" as const,
      spokenName,
    })] as const;
  }),
)) as PlatformConfig["participantGreetingProfiles"];
let container: StartedTestContainer | undefined;
let databaseOptions: PoolConfig | undefined;

beforeAll(async () => {
  const externalDisposableUrl = process.env.VOICE_DURABILITY_E2E_POSTGRES_URL?.trim();
  if (externalDisposableUrl !== undefined && externalDisposableUrl.length > 0) {
    const parsed = new URL(externalDisposableUrl);
    if (
      !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
      !parsed.pathname.slice(1).startsWith("voice_durability_test_")
    ) {
      throw new Error(
        "VOICE_DURABILITY_E2E_POSTGRES_URL must target a loopback disposable voice_durability_test_* database",
      );
    }
    databaseOptions = { connectionString: externalDisposableUrl };
    const bootstrap = new Pool(databaseOptions);
    try {
      await new PostgresMigrationRunner(bootstrap).migrate();
    } finally {
      await bootstrap.end();
    }
    return;
  }
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

beforeEach(async () => {
  const pool = new Pool(requiredDatabaseOptions());
  try {
    await pool.query(
      `TRUNCATE meeting_core.recording_publication_reconciliations,
                meeting_core.conversation_one_shot_receipts`,
    );
  } finally {
    await pool.end();
  }
}, 30_000);

// oxlint-disable-next-line max-lines-per-function
describe("providerless production-composition voice durability", () => {
  it.each([
    "reserved",
    "commanded",
    "provider-start-before-db-confirm",
    "db-start-before-settlement",
  ] as const)("recovers a process kill at %s within the original join deadline", async (checkpoint) => {
    const recordingRoot = await mkdtemp(join(tmpdir(), `voice-kill-${checkpoint}-`));
    const meetingId = `voice-kill-${checkpoint}-${randomUUID()}`;
    const startedAtMs = 1_800_000_000_000;
    const reached = checkpointFault(checkpoint);
    let killed: QualificationPhase | undefined;
    let restarted: QualificationPhase | undefined;
    try {
      killed = await composePhase({
        clock: new VirtualClock(startedAtMs),
        database: requiredDatabaseOptions(),
        groundedAnswers: new GroundedAnswerProbe(`unused-${checkpoint}`),
        meetingId,
        phase: `killed-${checkpoint}`,
        receiptDecorator: reached.decorate,
        recordingRoot,
      });
      const event = startEvent(
        meetingId,
        new Date(startedAtMs).toISOString(),
        [participantOne],
      );
      await killed.runtime.acceptLifecycle(event);
      await reached.wait;
      await killed.killForRestart();

      restarted = await composePhase({
        clock: new VirtualClock(startedAtMs + 100),
        database: requiredDatabaseOptions(),
        groundedAnswers: new GroundedAnswerProbe(`unused-restarted-${checkpoint}`),
        meetingId,
        phase: `restarted-${checkpoint}`,
        recordingRoot,
      });
      await restarted.runtime.acceptLifecycle(event);
      await restarted.coordinator.whenIdle(meetingId);

      if (checkpoint === "db-start-before-settlement") {
        await expect(restarted.pool.query<{ readonly state: string }>(
          "SELECT state FROM meeting_core.conversation_one_shot_receipts",
        )).resolves.toMatchObject({ rows: [{ state: "started" }] });
      } else {
        expect(await completedReceiptStates(restarted.pool, 1)).toEqual(["played"]);
      }
      const events = await readEvents(recordingRoot);
      expect(greetingStarts(events)).toHaveLength(1);
      const greetingAudio = audioChunks(
        events,
        `participant-greeting:${participantOne}`,
      );
      if (checkpoint === "provider-start-before-db-confirm") {
        expect(greetingAudio.length).toBeGreaterThan(0);
      } else {
        expect(greetingAudio.length).toBeGreaterThan(1);
      }
      expect(new Set(greetingAudio.map(({ attemptId }) => attemptId)).size).toBe(1);
      expect(greetingAudio.map(({ sequence }) => sequence)).toEqual(
        Array.from({ length: greetingAudio.length }, (_, index) => index),
      );
      if (checkpoint === "provider-start-before-db-confirm") {
        expect(restarted.conversationRuntime.proactiveRequests[0]?.idempotencyKey)
          .toBe(killed.conversationRuntime.proactiveRequests[0]?.idempotencyKey);
        const providerStart = await restarted.pool.query<{ readonly started_at_ms: string }>(
          `SELECT floor(extract(epoch FROM provider_started_at) * 1000)::bigint::text
             AS started_at_ms
           FROM meeting_core.conversation_one_shot_receipts`,
        );
        expect(Number(providerStart.rows[0]?.started_at_ms)).toBe(startedAtMs);
      }
      expect(restarted.clock.nowMilliseconds() - startedAtMs)
        .toBeLessThan(hardGreetingLatencyMs);
    } finally {
      await restarted?.closeFinal();
      await killed?.killForRestart();
      await rm(recordingRoot, { force: true, recursive: true });
    }
  }, 60_000);

  it("greets seven configured participants through real PostgreSQL sequentially and simultaneously", async () => {
    const recordingRoot = await mkdtemp(join(tmpdir(), "voice-seven-greetings-"));
    const startedAtMs = 1_800_000_000_000;
    const simultaneousMeetingId = `voice-seven-simultaneous-${randomUUID()}`;
    const sequentialMeetingId = `voice-seven-sequential-${randomUUID()}`;
    let simultaneous: QualificationPhase | undefined;
    let sequential: QualificationPhase | undefined;
    try {
      simultaneous = await composePhase({
        clock: new VirtualClock(startedAtMs),
        database: requiredDatabaseOptions(),
        groundedAnswers: new GroundedAnswerProbe("unused-seven-simultaneous"),
        meetingId: simultaneousMeetingId,
        participantGreetingProfiles: maximumLengthSyntheticProfiles,
        phase: "seven-simultaneous",
        recordingRoot,
        waitForPlaybackReadiness: false,
      });
      await simultaneous.runtime.acceptLifecycle(startEvent(
        simultaneousMeetingId,
        new Date(startedAtMs).toISOString(),
        [],
      ));
      for (const participantId of sevenSyntheticParticipants) {
        await simultaneous.runtime.acceptLifecycle(participantEvent(
          simultaneousMeetingId,
          simultaneous.clock,
          "participant.joined",
          participantId,
        ));
      }
      await simultaneous.connectPlayback();
      await simultaneous.coordinator.whenIdle(simultaneousMeetingId);
      expect(await completedReceiptStates(simultaneous.pool, 7))
        .toEqual(Array.from({ length: 7 }, () => "played"));
      expect(simultaneous.conversationRuntime.proactiveRequests).toHaveLength(1);
      const cohortPrompt = await simultaneous.pool.query<{
        readonly prompt: string;
        readonly prompt_length: number;
      }>(`
        SELECT DISTINCT provider_command_prompt AS prompt,
          char_length(provider_command_prompt) AS prompt_length
        FROM meeting_core.conversation_one_shot_receipts
      `);
      expect(cohortPrompt.rows).toHaveLength(1);
      expect(cohortPrompt.rows[0]?.prompt_length).toBeLessThanOrEqual(1_024);
      for (const profile of Object.values(maximumLengthSyntheticProfiles)) {
        expect(cohortPrompt.rows[0]?.prompt).toContain(profile.spokenName);
      }

      sequential = await composePhase({
        clock: new VirtualClock(startedAtMs + 10_000),
        database: requiredDatabaseOptions(),
        groundedAnswers: new GroundedAnswerProbe("unused-seven-sequential"),
        meetingId: sequentialMeetingId,
        participantGreetingProfiles: maximumLengthSyntheticProfiles,
        phase: "seven-sequential",
        recordingRoot,
      });
      await sequential.runtime.acceptLifecycle(startEvent(
        sequentialMeetingId,
        new Date(startedAtMs + 10_000).toISOString(),
        [],
      ));
      for (const [index, participantId] of sevenSyntheticParticipants.entries()) {
        await sequential.runtime.acceptLifecycle(participantEvent(
          sequentialMeetingId,
          sequential.clock,
          "participant.joined",
          participantId,
        ));
        await sequential.coordinator.whenIdle(sequentialMeetingId);
        expect(await completedReceiptStates(sequential.pool, 8 + index))
          .toEqual(Array.from({ length: 8 + index }, () => "played"));
      }
      expect(await completedReceiptStates(sequential.pool, 14))
        .toEqual(Array.from({ length: 14 }, () => "played"));
      expect(sequential.conversationRuntime.proactiveRequests).toHaveLength(7);
    } finally {
      await sequential?.closeFinal();
      await simultaneous?.closeFinal();
      await rm(recordingRoot, { force: true, recursive: true });
    }
  }, 60_000);

  it("publishes no processing link and reconciles ready or unavailable exactly once across takeover", async () => {
    const pool = new Pool(requiredDatabaseOptions());
    const recordingStates = new Map<string, "processing" | "ready" | "unavailable">();
    const projector = new RecordingPublicationProjector();
    const obligations = new PostgresRecordingPublicationReconciliation(pool);
    const adapter = new DiscordSummaryPublicationAdapter(projector, {
      recordingPlayback: (meetingId) => {
        const status = recordingStates.get(meetingId) ?? "processing";
        return Promise.resolve(status === "ready"
          ? { status, url: `https://recordings.invalid/playback#${meetingId}` }
          : { status });
      },
      recordingPlaybackReconciliation: obligations,
    });
    try {
      const readyRequest = recordingPublicationRequest(`ready-${randomUUID()}`);
      recordingStates.set(readyRequest.meetingId, "processing");
      await expect(adapter.publish(readyRequest)).resolves.toMatchObject({ ok: true });
      expect(projector.calls).toHaveLength(1);
      expect(projector.calls[0]?.input.markdown).not.toContain("/playback#");

      const abandoned = await obligations.claim({
        leaseOwner: "publication-owner-before-restart",
        leaseSeconds: 120,
      });
      expect(abandoned.map(({ meetingId }) => meetingId)).toContain(readyRequest.meetingId);
      await expect(obligations.claim({
        leaseOwner: "publication-contender",
      })).resolves.toEqual([]);
      await pool.query(
        `UPDATE meeting_core.recording_publication_reconciliations
         SET lease_expires_at = transaction_timestamp() - interval '1 second'
         WHERE meeting_id = $1`,
        [readyRequest.meetingId],
      );

      recordingStates.set(readyRequest.meetingId, "ready");
      const takeover = await obligations.claim({ leaseOwner: "publication-owner-after-restart" });
      const readyObligation = takeover.find(({ meetingId }) => meetingId === readyRequest.meetingId);
      expect(readyObligation).toBeDefined();
      await expect(adapter.reconcileRecordingPlayback(readyObligation!)).resolves.toBe("edited");
      await expect(obligations.complete(
        readyObligation!.meetingId,
        readyObligation!.leaseOwner,
        "edited",
      )).resolves.toBe(true);
      await expect(obligations.claim({ leaseOwner: "publication-owner-final" }))
        .resolves.toEqual([]);
      expect(projector.calls).toHaveLength(2);
      expect(projector.calls[1]).toMatchObject({ directEditOnly: true });
      expect(projector.calls[1]?.input.markdown).toContain(
        `https://recordings.invalid/playback#${readyRequest.meetingId}`,
      );

      const unavailableRequest = recordingPublicationRequest(`unavailable-${randomUUID()}`);
      recordingStates.set(unavailableRequest.meetingId, "processing");
      await expect(adapter.publish(unavailableRequest)).resolves.toMatchObject({ ok: true });
      expect(projector.calls.at(-1)?.input.markdown).not.toContain("/playback#");
      recordingStates.set(unavailableRequest.meetingId, "unavailable");
      const unavailable = (await obligations.claim({ leaseOwner: "publication-terminal" }))
        .find(({ meetingId }) => meetingId === unavailableRequest.meetingId);
      expect(unavailable).toBeDefined();
      await expect(adapter.reconcileRecordingPlayback(unavailable!)).resolves.toBe("unavailable");
      await expect(obligations.complete(
        unavailable!.meetingId,
        unavailable!.leaseOwner,
        "unavailable",
      )).resolves.toBe(true);
      const terminal = await pool.query<{ readonly state: string }>(
        `SELECT state FROM meeting_core.recording_publication_reconciliations
         WHERE meeting_id = $1`,
        [unavailableRequest.meetingId],
      );
      expect(terminal.rows[0]?.state).toBe("unavailable");
      expect(projector.calls).toHaveLength(3);
    } finally {
      await pool.end();
    }
  });

  // oxlint-disable-next-line max-lines-per-function
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
        waitForPlaybackReadiness: false,
      });
      await first.runtime.acceptLifecycle(startEvent(meetingId, startedAt, []));

      const clusteredGreetingAt = performance.now();
      await first.runtime.acceptLifecycle(participantEvent(
        meetingId,
        first.clock,
        "participant.joined",
        participantOne,
      ));
      await first.runtime.acceptLifecycle(participantEvent(
        meetingId,
        first.clock,
        "participant.joined",
        participantTwo,
      ));
      await first.runtime.acceptLifecycle(participantEvent(
        meetingId,
        first.clock,
        "participant.joined",
        departedParticipant,
      ));
      await first.runtime.acceptLifecycle(participantEvent(
        meetingId,
        first.clock,
        "participant.left",
        departedParticipant,
      ));
      await first.connectPlayback();
      const firstAudioAcceptedAt = await first.transport.whenFirstAudioAccepted(
        `participant-greeting:${participantOne}`,
        hardGreetingLatencyMs,
      );
      expect(firstAudioAcceptedAt - clusteredGreetingAt)
        .toBeLessThan(hardGreetingLatencyMs);
      await waitForEvidence(
        recordingRoot,
        (events) => audioChunks(events, `participant-greeting:${participantOne}`).length > 0,
      );
      await waitForEvidence(
        recordingRoot,
        (events) => completedTurn(events, `participant-greeting:${participantOne}`),
      );
      expect(await completedReceiptStates(first.pool, 2)).toEqual([
        "played",
        "played",
      ]);
      expect(first.conversationRuntime.proactiveRequests).toHaveLength(1);
      expect(first.conversationRuntime.proactiveRequests[0]?.literalSpeech)
        .toBe("Привет, Тест А! Hi, Test B!");

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
      expect(await completedReceiptStates(restarted.pool, 2)).toEqual([
        "played",
        "played",
      ]);
      expect(greetingStarts(await readEvents(recordingRoot))).toHaveLength(1);

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
        10_000,
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
      expect(await completedReceiptStates(restarted.pool, 3)).toEqual([
        "played",
        "played",
        "played",
      ]);

      const events = await readEvents(recordingRoot);
      expect(greetingStarts(events)).toHaveLength(1);
      expect(playbackStarts(events, "meeting-farewell:v1")).toHaveLength(1);
      expect(completedTurn(events, "meeting-farewell:v1")).toBe(true);
      expect(audioChunks(events, questionTurnId)).toHaveLength(1);
      const cancelIndex = events.findIndex((event) =>
        event.turnId === questionTurnId && event.type === "playback-cancel"
      );
      expect(cancelIndex).toBeGreaterThanOrEqual(0);
      expect(events[cancelIndex]).toMatchObject({
        cancellationObservedAtMs: startedAtMs + 119 * oneMinuteMs + 4_001,
        meetingId,
        reason: "barge-in",
        schemaVersion: 2,
      });
      expect(events.slice(cancelIndex + 1).some((event) =>
        event.turnId === questionTurnId && event.type === "audio-chunk"
      )).toBe(false);

      expect(audioChunks(events, `participant-greeting:${participantOne}`).length)
        .toBeGreaterThan(0);
      expect(events.some(({ turnId }) =>
        turnId.startsWith(`participant-greeting:${departedParticipant}`)
      )).toBe(false);
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

type GreetingKillCheckpoint =
  | "commanded"
  | "db-start-before-settlement"
  | "provider-start-before-db-confirm"
  | "reserved";

function checkpointFault(checkpoint: GreetingKillCheckpoint): {
  readonly decorate: (
    store: PostgresConversationOneShotReceiptStore,
  ) => LiveConversationOneShotReceiptPort;
  readonly wait: Promise<void>;
} {
  let signal!: () => void;
  let signalled = false;
  const wait = new Promise<void>((resolve) => { signal = resolve; });
  const kill = async (): Promise<never> => {
    if (!signalled) {
      signalled = true;
      signal();
    }
    return await new Promise<never>(() => {});
  };
  return {
    decorate: (store) => ({
      beginFarewellAttempt: (input) => store.beginFarewellAttempt(input),
      beginGreetingAttempt: async (input) => {
        await store.beginGreetingAttempt(input);
        if (checkpoint === "commanded") {
          await kill();
        }
      },
      beginGreetingCohortAttempt: async (input) => {
        await store.beginGreetingCohortAttempt(input);
        if (checkpoint === "commanded") {
          await kill();
        }
      },
      complete: (input) => store.complete(input),
      confirmGreetingStarted: async (input) => {
        if (checkpoint === "provider-start-before-db-confirm") { await kill(); }
        await store.confirmGreetingStarted(input);
      },
      confirmGreetingCohortStarted: async (input) => {
        if (checkpoint === "provider-start-before-db-confirm") { await kill(); }
        await store.confirmGreetingCohortStarted(input);
      },
      release: async (input) => { await store.release(input); },
      releaseFarewellAttempt: async (input) => { await store.releaseFarewellAttempt(input); },
      releaseGreetingAttempt: async (input) => { await store.releaseGreetingAttempt(input); },
      reconcileGreetingCapacity: (input) => store.reconcileGreetingCapacity(input),
      reserve: async (input) => {
        const reservation = await store.reserve(input);
        if (checkpoint === "reserved" && reservation.status === "reserved") {
          await kill();
        }
        return reservation;
      },
      settleFarewell: (input) => store.settleFarewell(input),
      settleGreeting: async (input) => {
        if (checkpoint === "db-start-before-settlement") { await kill(); }
        await store.settleGreeting(input);
      },
    }),
    wait,
  };
}

class RecordingPublicationProjector {
  readonly calls: Array<{
    readonly directEditOnly: boolean;
    readonly input: PublishDiscordSummary;
  }> = [];

  public publish(
    input: PublishDiscordSummary,
    options?: { readonly directEditOnly?: boolean },
  ): Promise<DiscordProjectionReference> {
    this.calls.push({ directEditOnly: options?.directEditOnly === true, input });
    return Promise.resolve({
      kind: "channel-message",
      messageId: "33333333333333333",
      parentChannelId: "11111111111111111",
    });
  }
}

function recordingPublicationRequest(meetingId: string): SummaryPublicationRequest {
  const turnId = `${meetingId}:turn`;
  const transcriptId = `${meetingId}:transcript`;
  return {
    idempotencyKey: `${meetingId}:publication:v1`,
    meetingId,
    publicationTargetId: "11111111111111111",
    summary: {
      actionItems: [],
      decisions: [{
        decisionId: `${meetingId}:decision`,
        evidenceTurnIds: [turnId],
        text: "Ship the synthetic fixture.",
      }],
      openQuestions: [],
      overview: "Providerless recording publication qualification.",
      summaryId: `${meetingId}:summary`,
      title: "Providerless publication",
      topics: [],
      transcriptId,
      version: 1,
    },
    transcript: {
      readableSegments: [],
      recordingId: meetingId,
      transcriptId,
      turns: [{
        endMs: 1_000,
        speakerId: "synthetic-speaker",
        startMs: 0,
        text: "Ship the synthetic fixture.",
        turnId,
      }],
      version: 1,
    },
  };
}

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
