import type { CraigPlaybackCommand, CraigPlaybackEvent } from "@discord-meeting/craig-gateway-contracts";
import {
  CraigPlaybackGateway,
  type CraigPlaybackTransport,
} from "@discord-meeting/craig-playback-adapter";
import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
} from "@discord-meeting/meeting-core/live-meeting";
import {
  ConversationCoordinator,
  type ConversationCancellationReason,
  type ConversationPortResult,
  type ConversationRuntime,
  type ConversationRuntimeEvent,
  type ConversationRuntimeTurn,
  type ConversationStartRequest,
  type GroundedKnowledgeAnswerPort,
} from "@discord-meeting/meeting-core/conversation";
import {
  PostgresConversationOneShotReceiptStore,
  PostgresLiveMeetingRepository,
  PostgresMigrationRunner,
} from "@discord-meeting/postgres-adapter";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { PlatformLiveMeetingRuntime } from "../src/live-meeting-runtime.js";
import type {
  LiveMeetingStartedEvent,
  LiveTranscriptionEvent,
} from "../src/live-runtime/contracts.js";
import {
  ControlledLiveTranscriberStub,
  logger,
  packets,
  ProjectionStub,
  SummaryStub,
} from "./live-runtime/live-runtime-fixtures.js";

const meetingId = "recording-providerless-durability";
const roomId = "voice-room-providerless-durability";
const participantOne = "1533224474609057795";
const participantTwo = "2533224474609057795";
const twoHoursMs = 7_200_000;
let qualificationNowMs = 0;

let database: Pool;
const cleanupTasks: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const connectionString = process.env.VOICE_DURABILITY_DATABASE_URL;
  if (connectionString === undefined) {
    throw new Error("VOICE_DURABILITY_DATABASE_URL must point to a disposable qualification database");
  }
  const databaseName = new URL(connectionString).pathname.slice(1);
  if (!/^voice_durability_test_[a-z\d_]+$/u.test(databaseName)) {
    throw new Error("Voice durability qualification requires a dedicated voice_durability_test_* database");
  }
  database = new Pool({ connectionString });
  await new PostgresMigrationRunner(database).migrate();
}, 30_000);

afterAll(async () => {
  await database?.end();
});

afterEach(async () => {
  let firstFailure: unknown;
  for (const cleanup of cleanupTasks.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error: unknown) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) {
    throw firstFailure;
  }
});

describe("providerless production-composition voice durability", () => {
  it("qualifies two compressed hours across playback, persistence and restart boundaries", async () => {
    const meetings = new PostgresLiveMeetingRepository(database);
    const receipts = new PostgresConversationOneShotReceiptStore(database);
    const playback = new CraigPlaybackGateway(() => Date.now());
    const transport = new SyntheticCraigPlaybackTransport(meetingId);
    playback.register(transport);
    const conversationRuntime = new ControlledConversationRuntime();
    cleanupTasks.push(async () => playback.close());
    const groundedAnswers = groundedAnswerPort();
    qualificationNowMs = Date.now();
    const firstCoordinator = new ConversationCoordinator({
      groundedAnswers,
      playback,
      runtime: conversationRuntime,
    });
    const firstTranscriber = new ControlledLiveTranscriberStub();
    cleanupTasks.push(async () => firstCoordinator.close(Date.now()));
    const startedAt = new Date(qualificationNowMs).toISOString();
    const started = startEvent(startedAt, []);
    const firstRuntime = composedRuntime({
      coordinator: firstCoordinator,
      meetings,
      receipts,
      transcriber: firstTranscriber,
    });

    cleanupTasks.push(async () => firstRuntime.close());
    await firstRuntime.acceptLifecycle(started);
    await firstRuntime.acceptLifecycle(participantEvent("participant.joined", participantOne));
    await waitFor(() => greetingStarts(transport).length === 1);
    await firstRuntime.acceptLifecycle(participantEvent("participant.joined", participantTwo));
    await waitFor(() => greetingStarts(transport).length === 2);
    expect(greetingStarts(transport).map(({ turnId }) => turnId)).toEqual([
      `participant-greeting:${participantOne}`,
      `participant-greeting:${participantTwo}`,
    ]);

    await firstRuntime.acceptLifecycle(participantEvent("participant.left", participantOne));
    await firstRuntime.acceptLifecycle(participantEvent("participant.joined", participantOne));
    await wait(150);
    expect(greetingStarts(transport)).toHaveLength(2);

    await firstRuntime.acceptLifecycle({
      occurredAt: new Date().toISOString(),
      recordingId: meetingId,
      type: "meeting.connection_lost",
    });

    const restartedCoordinator = new ConversationCoordinator({
      groundedAnswers,
      playback,
      runtime: conversationRuntime,
    });
    const restartedTranscriber = new ControlledLiveTranscriberStub();
    cleanupTasks.push(async () => restartedCoordinator.close(Date.now()));
    const restartedRuntime = composedRuntime({
      coordinator: restartedCoordinator,
      meetings,
      receipts,
      transcriber: restartedTranscriber,
    });
    cleanupTasks.push(async () => restartedRuntime.close());
    await restartedRuntime.acceptLifecycle(startEvent(startedAt, [participantOne, participantTwo]));
    await wait(150);
    expect(greetingStarts(transport)).toHaveLength(2);

    qualificationNowMs += twoHoursMs;
    const finalPacketBatch = packets();
    finalPacketBatch.packets[0] = {
      ...finalPacketBatch.packets[0]!,
      recordingId: meetingId,
      relativeTimeMs: twoHoursMs - 20,
      speakerId: participantOne,
    };
    await restartedRuntime.acceptVoiceBatch(finalPacketBatch);
    await waitFor(() => restartedTranscriber.requests.length === 1);
    const transcription = restartedTranscriber.requests[0];
    if (transcription === undefined) {
      throw new Error("providerless transcription session did not open");
    }

    transcription.onTranscript(transcript(
      transcription.meetingId,
      transcription.speakerId,
      twoHoursMs - 2_000,
      twoHoursMs - 1_000,
      "Botik, what did we decide?",
    ));
    await waitFor(() => answerChunks(transport).length === 1);
    transcription.onTranscript({
      ...transcript(
        transcription.meetingId,
        participantTwo,
        twoHoursMs - 900,
        twoHoursMs - 800,
        "interrupting",
      ),
      isFinal: false,
    });
    await waitFor(() => transport.commands.some(({ type }) => type === "playback-cancel"));
    conversationRuntime.releaseLateChunk();
    await restartedCoordinator.whenIdle(meetingId);
    await wait(50);
    expect(answerChunks(transport)).toHaveLength(1);
    expect(conversationRuntime.cancelReasons).toContain("barge-in");

    transcription.onTranscript(transcript(
      transcription.meetingId,
      participantOne,
      twoHoursMs - 500,
      twoHoursMs,
      "Bye everyone!",
    ));
    await wait(50);
    qualificationNowMs += 100;
    await waitFor(() => farewellStarts(transport).length === 1);
    transcription.onTranscript(transcript(
      transcription.meetingId,
      participantOne,
      twoHoursMs - 500,
      twoHoursMs,
      "Bye everyone!",
    ));
    await wait(200);
    expect(farewellStarts(transport)).toHaveLength(1);

    await restartedRuntime.acceptLifecycle({
      occurredAt: new Date().toISOString(),
      recordingId: meetingId,
      type: "meeting.ended",
    });
    await restartedRuntime.settleBeforeFinalPublication(meetingId);
    const persisted = await meetings.readSnapshotAndTimeline(meetingId);
    expect(persisted?.snapshot.status).toBe("ended");
    expect(persisted?.timeline.map(({ turn }) => turn.text)).toEqual(expect.arrayContaining([
      "Botik, what did we decide?",
      "Bye everyone!",
    ]));
    expect(Math.max(...(persisted?.timeline.map(({ turn }) => turn.endMs) ?? []))).toBe(twoHoursMs);

    const receiptRows = await database.query<{ readonly count: number }>(
      "SELECT count(*)::integer AS count FROM meeting_core.conversation_one_shot_receipts",
    );
    expect(receiptRows.rows[0]?.count).toBe(3);
    expect(transport.peakBufferedBytes).toBeLessThanOrEqual(8);
    expect(conversationRuntime.maximumActiveTurns).toBe(1);
  }, 150_000);
});

function composedRuntime(input: {
  readonly coordinator: ConversationCoordinator;
  readonly meetings: PostgresLiveMeetingRepository;
  readonly receipts: PostgresConversationOneShotReceiptStore;
  readonly transcriber: ControlledLiveTranscriberStub;
}): PlatformLiveMeetingRuntime {
  return new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(input.meetings),
    conversation: {
      coordinator: input.coordinator,
      farewells: {
        cues: {
          select: ({ locale }) => ({
            cueId: `farewell-${locale}-v1`,
            pcmChunks: [Uint8Array.of(7, 0, 7, 0)],
            playbackAttemptId: `farewell-${meetingId}-${locale}`,
          }),
        },
        participantNames: {},
      },
      greetings: {
        cues: {
          select: ({ participantId }) => ({
            cueId: `greeting-${participantId}`,
            pcmChunks: [Uint8Array.of(1, 0, 2, 0)],
            playbackAttemptId: `greeting-${participantId}`,
          }),
        },
        defaultLocale: "en",
        excludedParticipantIds: [],
        isPlaybackReady: () => true,
        profiles: {},
      },
      locale: "en-US",
      nowMilliseconds: () => qualificationNowMs,
      oneShotReceipts: input.receipts,
      systemPrompt: "Answer only from durable transcript evidence.",
      voiceProfileId: "providerless-voice",
    },
    clock: {
      monotonicMilliseconds: () => qualificationNowMs,
      nowMilliseconds: () => qualificationNowMs,
    },
    finishMeeting: new FinishLiveMeeting(input.meetings),
    logger,
    packetFlowControl: {
      maximumConcurrentSessions: 2,
      packetBackpressureTimeoutMs: 100,
    },
    refreshMeeting: new RefreshLiveMeeting({
      meetings: input.meetings,
      projector: new ProjectionStub(),
      summarizer: new SummaryStub(),
    }),
    startMeeting: new StartLiveMeeting({ meetings: input.meetings }),
    transcriber: input.transcriber,
  });
}

function startEvent(
  occurredAt: string,
  participantIds: readonly string[],
): LiveMeetingStartedEvent {
  return {
    occurredAt,
    participantIds,
    publicationTarget: { resolve: async () => "results-channel-providerless" },
    recordingId: meetingId,
    roomId,
    type: "meeting.started",
  };
}

function participantEvent(
  type: "participant.joined" | "participant.left",
  participantId: string,
) {
  return {
    occurredAt: new Date().toISOString(),
    participantId,
    recordingId: meetingId,
    type,
  } as const;
}

function transcript(
  targetMeetingId: string,
  speakerId: string,
  startMs: number,
  endMs: number,
  text: string,
): LiveTranscriptionEvent {
  return { endMs, isFinal: true, meetingId: targetMeetingId, speakerId, startMs, text };
}

function groundedAnswerPort(): GroundedKnowledgeAnswerPort {
  return {
    answer: async () => ({
      ok: true,
      value: {
        citations: [{ turnId: "durable-evidence-turn" }],
        evidenceEpoch: "evidence-1",
        knowledgeEpoch: "knowledge-1",
        plainText: "We decided to ship Friday.",
        schemaVersion: 1,
        status: "answered",
      },
    }),
    recheckPlaybackAuthority: async () => ({ ok: true, value: "current" }),
  };
}

class ControlledConversationRuntime implements ConversationRuntime {
  public readonly cancelReasons: ConversationCancellationReason[] = [];
  public maximumActiveTurns = 0;
  private activeTurns = 0;
  private releaseLate: (() => void) | undefined;

  public startTurn(
    request: ConversationStartRequest,
  ): Promise<ConversationPortResult<ConversationRuntimeTurn>> {
    this.activeTurns += 1;
    this.maximumActiveTurns = Math.max(this.maximumActiveTurns, this.activeTurns);
    let cancelled: ConversationCancellationReason | undefined;
    const late = new Promise<void>((resolve) => {
      this.releaseLate = resolve;
    });
    const events = this.events(request, late, () => cancelled, () => {
      this.activeTurns -= 1;
    });
    return Promise.resolve({
      ok: true,
      value: {
        cancel: async (reason) => {
          cancelled = reason;
          this.cancelReasons.push(reason);
          this.releaseLate?.();
        },
        events,
      },
    });
  }

  public releaseLateChunk(): void {
    this.releaseLate?.();
  }

  private async *events(
    request: ConversationStartRequest,
    late: Promise<void>,
    cancelled: () => ConversationCancellationReason | undefined,
    settled: () => void,
  ): AsyncGenerator<ConversationRuntimeEvent> {
    const attemptId = `attempt-${request.turnId}`;
    try {
      yield { attemptId, type: "accepted" };
      yield { attemptId, channels: 1, format: "pcm_s16le", sampleRateHz: 48_000, type: "audio-start" };
      yield audioChunk(attemptId, request.turnId, 0, Uint8Array.of(3, 0, 4, 0));
      await late;
      yield audioChunk(attemptId, request.turnId, 1, Uint8Array.of(5, 0, 6, 0));
      const reason = cancelled();
      if (reason === undefined) {
        yield { attemptId, type: "audio-end" };
        yield { attemptId, type: "completed" };
      } else {
        yield { attemptId, reason, type: "cancelled" };
      }
    } finally {
      settled();
    }
  }
}

function audioChunk(
  attemptId: string,
  turnId: string,
  sequence: number,
  bytes: Uint8Array,
): ConversationRuntimeEvent {
  return {
    attemptId,
    bytes,
    channels: 1,
    format: "pcm_s16le",
    sampleRateHz: 48_000,
    sequence,
    turnId,
    type: "audio-chunk",
  };
}

class SyntheticCraigPlaybackTransport implements CraigPlaybackTransport {
  public bufferedBytes = 0;
  public readonly commands: CraigPlaybackCommand[] = [];
  public readonly identity;
  public peakBufferedBytes = 0;
  private closeListener: (reason: string) => void = () => {};
  private eventListener: (event: CraigPlaybackEvent) => void = () => {};
  private readonly startedAttempts = new Set<string>();

  public constructor(recordingId: string) {
    this.identity = {
      channelId: roomId,
      gatewaySessionId: "providerless-gateway-session",
      guildId: "providerless-guild",
      recordingId,
    };
  }

  public close(_code: number, reason: string): void {
    this.closeListener(reason);
  }

  public onClose(listener: (reason: string) => void): void {
    this.closeListener = listener;
  }

  public onEvent(listener: (event: CraigPlaybackEvent) => void): void {
    this.eventListener = listener;
  }

  public send(command: CraigPlaybackCommand): Promise<void> {
    this.commands.push(structuredClone(command));
    if (command.type === "audio-chunk") {
      this.bufferedBytes += Buffer.from(command.pcmBase64, "base64").byteLength;
      this.peakBufferedBytes = Math.max(this.peakBufferedBytes, this.bufferedBytes);
      if (!this.startedAttempts.has(command.attemptId)) {
        this.startedAttempts.add(command.attemptId);
        this.eventListener({
          attemptId: command.attemptId,
          recordingId: command.recordingId,
          schemaVersion: 1,
          startedAtMs: Date.now(),
          turnId: command.turnId,
          type: "playback-started",
        });
      }
      this.bufferedBytes = 0;
    }
    if (command.type === "playback-finish" || command.type === "playback-cancel") {
      this.eventListener({
        attemptId: command.attemptId,
        finishedAtMs: Date.now(),
        recordingId: command.recordingId,
        schemaVersion: 1,
        turnId: command.turnId,
        type: "playback-finished",
      });
    }
    return Promise.resolve();
  }
}

function greetingStarts(transport: SyntheticCraigPlaybackTransport) {
  return transport.commands.filter(({ type, turnId }) =>
    type === "playback-start" && turnId.startsWith("participant-greeting:")
  );
}

function farewellStarts(transport: SyntheticCraigPlaybackTransport) {
  return transport.commands.filter(({ type, turnId }) =>
    type === "playback-start" && turnId === "meeting-farewell:v1"
  );
}

function answerChunks(transport: SyntheticCraigPlaybackTransport) {
  return transport.commands.filter(({ type, turnId }) =>
    type === "audio-chunk" && !turnId.startsWith("participant-greeting:") &&
      turnId !== "meeting-farewell:v1"
  );
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("providerless durability condition timed out");
    }
    await wait(10);
  }
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
