import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachCraigPlaybackWebSocketServer,
  CraigPlaybackGateway,
} from "@discord-meeting/craig-playback-adapter";
import { parseCraigPlaybackCommand } from "@discord-meeting/craig-gateway-contracts";
import type {
  ConversationCancellationReason,
  ConversationPortResult,
  ConversationRuntime,
  ConversationRuntimeEvent,
  ConversationRuntimeTurn,
  ConversationStartOptions,
  ConversationStartRequest,
  GroundedKnowledgeAnswerOptions,
  GroundedKnowledgeAnswerPort,
  GroundedKnowledgeAnswerRequest,
  GroundedKnowledgePlaybackAuthorityRequest,
} from "@discord-meeting/meeting-core/conversation";
import {
  PostgresConversationOneShotReceiptStore,
  PostgresLiveMeetingRepository,
} from "@discord-meeting/postgres-adapter";
import { Pool, type PoolConfig } from "pg";
import { WebSocket } from "ws";

import type { PlatformConfig } from "../src/config.js";
import {
  createPlatformLiveConversationConfiguration,
  createPlatformLiveMeetingRuntime,
} from "../src/composition/discord-live.js";
import { createLiveConversationResources } from
  "../src/composition/conversation-coordinator.js";
import type { PlatformLiveMeetingRuntime } from "../src/live-meeting-runtime.js";
import type {
  LiveConversationOneShotReceiptPort,
  LiveMeetingStartedEvent,
  LiveRuntimeClock,
  LiveRuntimeTimer,
  LiveRuntimeTimerHandle,
  LiveTranscriptionEvent,
  LiveTranscriptionPort,
  LiveTranscriptionSession,
  LiveVoicePacketBatch,
} from "../src/live-runtime/contracts.js";
import { stableLiveTranscriptTurnId } from "../src/live-runtime/transcript-turn-id.js";
import { logger, packets, ProjectionStub, SummaryStub } from
  "./live-runtime/live-runtime-fixtures.js";
import {
  DurableCraigPlaybackTransport,
  waitForPersistedTurn,
} from "./providerless-voice-durability-recording.js";

export const participantOne = "1533224474609057795";
export const participantTwo = "2533224474609057795";
export const sevenSyntheticParticipants = Object.freeze([
  participantOne,
  participantTwo,
  "7533224474609057795",
  "8533224474609057795",
  "9533224474609057795",
  "9633224474609057795",
  "9733224474609057795",
]);
export const departedParticipant = "5533224474609057795";
export const twoHoursMs = 7_200_000;
export const oneMinuteMs = 60_000;
// ADR-0051 anchors the externally meaningful claim at five seconds from the
// producer join occurrence to Craig's accepted first audio.
export const hardGreetingLatencyMs = 5_000;
const botApplicationId = "3533224474609057795";
const craigApplicationId = "4533224474609057795";
const roomId = "voice-room-providerless-durability";
const voiceProfileId = "elevenlabs-multilingual";
const voiceId = "jqcCZkN6Knx8BJ5TBdYR";
const platformRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const assetRoot = join(platformRoot, "assets");
const conversationConfig = Object.freeze({
  conversation: {
    farewellCueRoot: join(assetRoot, "farewell-cues"),
    greetingCueRoot: join(assetRoot, "greeting-cues"),
    runtimeAddress: "127.0.0.1:1",
    systemPrompt: "Answer only from durable transcript evidence.",
    thinkingCueRoot: join(assetRoot, "thinking-cues"),
    voiceId,
    voiceProfileId,
  },
} satisfies Pick<PlatformConfig, "conversation">);
const livePolicyConfig = Object.freeze({
  ...conversationConfig,
  discordApplicationId: botApplicationId,
  discordBotikApplicationId: botApplicationId,
  discordCraigApplicationId: craigApplicationId,
  participantGreetingDefaultLocale: "en" as const,
  participantGreetingProfiles: Object.freeze({
    [participantOne]: Object.freeze({
      displayName: "Test A",
      greetingLocale: "ru" as const,
      spokenName: "Тест А",
    }),
    [participantTwo]: Object.freeze({
      displayName: "Test B",
      greetingLocale: "en" as const,
      spokenName: "Test B",
    }),
    [sevenSyntheticParticipants[2]!]: Object.freeze({
      displayName: "Synthetic C", greetingLocale: "en" as const, spokenName: "Test C",
    }),
    [sevenSyntheticParticipants[3]!]: Object.freeze({
      displayName: "Synthetic D", greetingLocale: "en" as const, spokenName: "Test D",
    }),
    [sevenSyntheticParticipants[4]!]: Object.freeze({
      displayName: "Synthetic E", greetingLocale: "en" as const, spokenName: "Test E",
    }),
    [sevenSyntheticParticipants[5]!]: Object.freeze({
      displayName: "Synthetic F", greetingLocale: "en" as const, spokenName: "Test F",
    }),
    [sevenSyntheticParticipants[6]!]: Object.freeze({
      displayName: "Synthetic G", greetingLocale: "en" as const, spokenName: "Test G",
    }),
  }),
});

interface ComposePhaseInput {
  readonly clock: VirtualClock;
  readonly database: PoolConfig;
  readonly groundedAnswers: GroundedAnswerProbe;
  readonly meetingId: string;
  readonly participantGreetingProfiles?: PlatformConfig["participantGreetingProfiles"];
  readonly phase: string;
  readonly receiptDecorator?: (
    store: PostgresConversationOneShotReceiptStore,
  ) => LiveConversationOneShotReceiptPort;
  readonly recordingRoot: string;
  readonly waitForPlaybackReadiness?: boolean;
}

export interface QualificationPhase {
  readonly clock: VirtualClock;
  readonly conversationRuntime: ControlledProviderlessConversationRuntime;
  readonly coordinator: NonNullable<Awaited<ReturnType<
    typeof createLiveConversationResources
  >>["coordinator"]>;
  readonly meetings: PostgresLiveMeetingRepository;
  readonly pool: Pool;
  readonly projector: ProjectionStub;
  readonly runtime: PlatformLiveMeetingRuntime;
  readonly summarizer: SummaryStub;
  readonly transcriber: BoundedTranscriberProbe;
  readonly transport: DurableCraigPlaybackTransport;
  connectPlayback(): Promise<void>;
  closeFinal(): Promise<void>;
  killForRestart(): Promise<void>;
  releaseForRestart(): Promise<Awaited<ReturnType<
    PostgresLiveMeetingRepository["readSnapshotAndTimeline"]
  >>>;
}

export async function composePhase(input: ComposePhaseInput): Promise<QualificationPhase> {
  const pool = new Pool(input.database);
  await pool.query("SELECT 1");
  const meetings = new PostgresLiveMeetingRepository(pool);
  const receipts = new PostgresConversationOneShotReceiptStore(pool);
  const activeReceipts = input.receiptDecorator?.(receipts) ?? receipts;
  const playback = new CraigPlaybackGateway(() => input.clock.nowMilliseconds());
  const transport = await DurableCraigPlaybackTransport.open({
    clock: input.clock,
    meetingId: input.meetingId,
    phase: input.phase,
    root: input.recordingRoot,
  });
  const bearerToken = "providerless-craig-playback-token";
  const httpServer = createServer();
  const playbackWebSocket = attachCraigPlaybackWebSocketServer(httpServer, {
    bearerToken,
    gateway: playback,
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    throw new Error("providerless Craig WebSocket address was unavailable");
  }
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/craig/playback`, {
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  await once(socket, "open");
  transport.onEvent((event) => { socket.send(JSON.stringify(event)); });
  socket.on("message", (data) => {
    const payload = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
    void transport.send(parseCraigPlaybackCommand(JSON.parse(payload) as unknown));
  });
  const conversationRuntime = new ControlledProviderlessConversationRuntime();
  const resources = await createLiveConversationResources({
    config: conversationConfig,
    groundedAnswers: input.groundedAnswers,
    logger,
    playback,
    runtime: conversationRuntime,
  });
  if (
    resources.coordinator === undefined ||
    resources.farewellCues === undefined ||
    resources.greetingCues === undefined
  ) {
    throw new Error("production conversation resources were not composed");
  }
  const conversation = createPlatformLiveConversationConfiguration({
    config: input.participantGreetingProfiles === undefined
      ? livePolicyConfig
      : { ...livePolicyConfig, participantGreetingProfiles: input.participantGreetingProfiles },
    coordinator: resources.coordinator,
    farewellCues: resources.farewellCues,
    greetingCues: resources.greetingCues,
    isPlaybackReady: (recordingId) => playback.hasSession(recordingId),
    nowMilliseconds: () => input.clock.nowMilliseconds(),
    // The production factory deliberately requires the concrete PostgreSQL adapter;
    // this test decorator preserves its full port while pausing selected boundaries.
    oneShotReceipts: activeReceipts as PostgresConversationOneShotReceiptStore,
  });
  if (conversation === undefined) {
    throw new Error("production live conversation policy was not composed");
  }
  const transcriber = new BoundedTranscriberProbe();
  const projector = new ProjectionStub();
  const summarizer = new SummaryStub();
  const runtime = createPlatformLiveMeetingRuntime({
    clock: input.clock,
    conversation,
    logger,
    meetings,
    packetFlowControl: {
      maximumConcurrentSessions: 2,
      maximumQueuedPacketsGlobally: 64,
      maximumQueuedPacketsPerSpeaker: 16,
      packetBackpressureTimeoutMs: 100,
    },
    packetInspector: { durationSamples48Khz: () => 960 },
    projector,
    summarizer,
    timer: input.clock,
    transcriber,
  });
  let readinessTail = Promise.resolve();
  const stopObservingReadiness = playback.onSessionReady((recordingId) => {
    readinessTail = readinessTail.then(() => runtime.conversationPlaybackReady(recordingId));
  });
  let playbackConnected = false;
  const connectPlayback = async (): Promise<void> => {
    if (!playbackConnected) {
      playbackConnected = true;
      socket.send(JSON.stringify({
        ...transport.identity,
        channelId: "1533228823045214398",
        guildId: "1533228590643155034",
        playbackCapabilities: {
          attestsDiscordVoiceSend: true,
          deduplicatesCommandIds: true,
          deduplicationRetentionSeconds: 300,
          replaysOriginalStartedAtMs: true,
        },
        schemaVersion: 3,
        type: "session-ready",
      }));
    }
    while (!playback.hasSession(input.meetingId)) {
      await new Promise<void>(setImmediate);
    }
    await readinessTail;
  };
  if (input.waitForPlaybackReadiness !== false) {
    await connectPlayback();
  }
  let closed = false;
  const releaseResources = async (closeCoordinator = true): Promise<void> => {
    await transport.whenIdle();
    stopObservingReadiness();
    playback.close();
    socket.terminate();
    await playbackWebSocket.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
    if (closeCoordinator) {
      await resources.coordinator?.close(input.clock.nowMilliseconds());
    }
    await pool.end();
  };
  return {
    clock: input.clock,
    closeFinal: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await runtime.close();
      await releaseResources();
    },
    connectPlayback,
    conversationRuntime,
    coordinator: resources.coordinator,
    meetings,
    killForRestart: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await releaseResources(false);
    },
    pool,
    projector,
    releaseForRestart: async () => {
      if (closed) {
        throw new Error("qualification owner was already released");
      }
      closed = true;
      await runtime.releaseForRestart();
      const snapshot = await meetings.readSnapshotAndTimeline(input.meetingId);
      await releaseResources();
      return snapshot;
    },
    runtime,
    summarizer,
    transcriber,
    transport,
  };
}

export async function runMinute(
  phase: QualificationPhase,
  meetingId: string,
  startedAtMs: number,
  minute: number,
  text: string,
): Promise<LiveTranscriptionEvent> {
  const endMs = minute * oneMinuteMs;
  await phase.clock.advanceTo(startedAtMs + endMs);
  await phase.runtime.acceptVoiceBatch(packetBatch(
    meetingId,
    participantOne,
    endMs - 20,
    minute,
    startedAtMs + endMs,
  ));
  const event = transcript(
    meetingId,
    participantOne,
    endMs - 500,
    endMs,
    text,
  );
  phase.transcriber.emit(participantOne, event);
  if (minute % 10 === 0) {
    await waitForPersistedTurn(
      phase.meetings,
      meetingId,
      stableLiveTranscriptTurnId(event),
    );
  }
  return event;
}

export function startEvent(
  meetingId: string,
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

export function participantEvent(
  meetingId: string,
  clock: VirtualClock,
  type: "participant.joined" | "participant.left",
  participantId: string,
) {
  return {
    occurredAt: clock.isoNow(),
    participantId,
    recordingId: meetingId,
    type,
  } as const;
}

export function packetBatch(
  meetingId: string,
  speakerId: string,
  relativeTimeMs: number,
  sequenceNumber: number,
  receivedAtMs: number,
): LiveVoicePacketBatch {
  const fixture = packets();
  const packet = fixture.packets[0];
  if (packet === undefined) {
    throw new Error("voice packet fixture is empty");
  }
  return {
    ...fixture,
    packets: [{
      ...packet,
      mediaTimestamp: sequenceNumber * 960,
      receivedAtMs,
      recordingId: meetingId,
      relativeTimeMs,
      sequenceNumber,
      speakerId,
    }],
  };
}

export function transcript(
  meetingId: string,
  speakerId: string,
  startMs: number,
  endMs: number,
  text: string,
): LiveTranscriptionEvent {
  return { endMs, isFinal: true, meetingId, speakerId, startMs, text };
}

export class GroundedAnswerProbe implements GroundedKnowledgeAnswerPort {
  public readonly answerRequests: GroundedKnowledgeAnswerRequest[] = [];
  public readonly recheckRequests: GroundedKnowledgePlaybackAuthorityRequest[] = [];

  public constructor(private readonly evidenceTurnId: string) {}

  public answer(
    request: GroundedKnowledgeAnswerRequest,
    _options: GroundedKnowledgeAnswerOptions,
  ): Promise<ConversationPortResult<unknown>> {
    this.answerRequests.push(structuredClone(request));
    return Promise.resolve({
      ok: true,
      value: {
        citations: [{ turnId: this.evidenceTurnId }],
        evidenceEpoch: "evidence-1",
        knowledgeEpoch: "knowledge-1",
        plainText: "We decided to ship Friday.",
        schemaVersion: 1,
        status: "answered",
      },
    });
  }

  public recheckPlaybackAuthority(
    request: GroundedKnowledgePlaybackAuthorityRequest,
    options: GroundedKnowledgeAnswerOptions,
  ): Promise<ConversationPortResult<"current">> {
    options.signal.throwIfAborted();
    this.recheckRequests.push(structuredClone(request));
    return Promise.resolve({ ok: true, value: "current" });
  }
}

export class ControlledProviderlessConversationRuntime implements ConversationRuntime {
  public activeTurns = 0;
  public readonly cancelReasons: ConversationCancellationReason[] = [];
  public maximumActiveTurns = 0;
  public readonly proactiveRequests: ConversationStartRequest[] = [];
  public readonly requests: ConversationStartRequest[] = [];
  private releaseLate: (() => void) | undefined;

  public startTurn(
    request: ConversationStartRequest,
    options: ConversationStartOptions = {},
  ): Promise<ConversationPortResult<ConversationRuntimeTurn>> {
    options.signal?.throwIfAborted();
    const proactive = request.idempotencyKey.startsWith(
      "25:proactive-conversation:v1|",
    );
    if (proactive && request.literalSpeech !== request.prompt) {
      throw new Error("providerless proactive speech must be literal");
    }
    if (!proactive && request.literalSpeech !== "We decided to ship Friday.") {
      throw new Error("grounded qualification must use validated literal speech");
    }
    const grounded = !proactive;
    (grounded ? this.requests : this.proactiveRequests).push(structuredClone(request));
    this.activeTurns += 1;
    this.maximumActiveTurns = Math.max(this.maximumActiveTurns, this.activeTurns);
    let cancelled: ConversationCancellationReason | undefined;
    const late = grounded
      ? new Promise<void>((resolve) => {
          this.releaseLate = resolve;
        })
      : Promise.resolve();
    return Promise.resolve({
      ok: true,
      value: {
        cancel: async (reason) => {
          cancelled = reason;
          this.cancelReasons.push(reason);
          this.releaseLate?.();
        },
        events: this.events(request, late, grounded, () => cancelled),
      },
    });
  }

  public releaseLateChunk(): void {
    this.releaseLate?.();
  }

  private async *events(
    request: ConversationStartRequest,
    late: Promise<void>,
    grounded: boolean,
    cancelled: () => ConversationCancellationReason | undefined,
  ): AsyncGenerator<ConversationRuntimeEvent> {
    const attemptId = `attempt-${createHash("sha256")
      .update(request.idempotencyKey)
      .digest("hex")}`;
    try {
      yield { attemptId, type: "accepted" };
      yield {
        attemptId,
        attestation: {
          attemptId,
          deployment: "providerless-pipecat-runtime",
          keyId: "a".repeat(64),
          model: "providerless-tts-v1",
          provider: "providerless-fixture",
          schemaVersion: 1,
          signature: "b".repeat(64),
          sourceRevision: "c".repeat(40),
          turnId: request.turnId,
          voice: "providerless-fixture",
          voiceProfileId: request.voiceProfileId,
        },
        type: "tts-attestation",
      };
      yield {
        attemptId,
        channels: 1,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        type: "audio-start",
      };
      yield audioChunk(attemptId, request.turnId, 0, Uint8Array.of(3, 0, 4, 0));
      if (grounded) {
        await late;
      }
      yield audioChunk(attemptId, request.turnId, 1, Uint8Array.of(5, 0, 6, 0));
      const reason = cancelled();
      if (reason === undefined) {
        yield { attemptId, type: "audio-end" };
        yield { attemptId, type: "completed" };
      } else {
        yield { attemptId, reason, type: "cancelled" };
      }
    } finally {
      this.activeTurns -= 1;
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

type OpenTranscriptionRequest = Parameters<LiveTranscriptionPort["openSession"]>[0];

class BoundedTranscriberProbe implements LiveTranscriptionPort {
  public activeSessions = 0;
  public peakActiveSessions = 0;
  public peakPendingPacketWrites = 0;
  public totalPackets = 0;
  public totalSessions = 0;
  private pendingPacketWrites = 0;
  private readonly sessions = new Map<string, OpenTranscriptionRequest>();

  public openSession(request: OpenTranscriptionRequest): Promise<LiveTranscriptionSession> {
    if (this.sessions.has(request.speakerId)) {
      throw new Error("transcriber opened overlapping sessions for one speaker");
    }
    this.sessions.set(request.speakerId, request);
    this.activeSessions += 1;
    this.totalSessions += 1;
    this.peakActiveSessions = Math.max(this.peakActiveSessions, this.activeSessions);
    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      this.sessions.delete(request.speakerId);
      this.activeSessions -= 1;
    };
    return Promise.resolve({
      finalize: async () => {
        close();
      },
      sendPacket: async () => {
        this.pendingPacketWrites += 1;
        this.peakPendingPacketWrites = Math.max(
          this.peakPendingPacketWrites,
          this.pendingPacketWrites,
        );
        try {
          await Promise.resolve();
          this.totalPackets += 1;
          return "accepted" as const;
        } finally {
          this.pendingPacketWrites -= 1;
        }
      },
      terminate: close,
    });
  }

  public emit(speakerId: string, event: LiveTranscriptionEvent): void {
    const session = this.sessions.get(speakerId);
    if (session === undefined) {
      throw new Error(`no active transcription session for ${speakerId}`);
    }
    session.onTranscript(event);
  }
}

interface VirtualTask extends LiveRuntimeTimerHandle {
  readonly id: number;
  callback: () => void;
  dueAtMs: number;
  intervalMs: number | null;
  unref(): void;
}

export class VirtualClock implements LiveRuntimeClock, LiveRuntimeTimer {
  private currentMs: number;
  private nextId = 1;
  private readonly tasks = new Map<number, VirtualTask>();

  public constructor(startedAtMs: number) {
    this.currentMs = startedAtMs;
  }

  public monotonicMilliseconds(): number {
    return this.currentMs;
  }

  public nowMilliseconds(): number {
    return this.currentMs;
  }

  public isoNow(): string {
    return new Date(this.currentMs).toISOString();
  }

  public cancel(handle: LiveRuntimeTimerHandle): void {
    const candidate = handle as Partial<VirtualTask>;
    if (candidate.id !== undefined) {
      this.tasks.delete(candidate.id);
    }
  }

  public repeat(intervalMs: number, callback: () => void): VirtualTask {
    return this.add(intervalMs, intervalMs, callback);
  }

  public schedule(delayMs: number, callback: () => void): VirtualTask {
    return this.add(delayMs, null, callback);
  }

  public async advanceTo(targetMs: number): Promise<void> {
    if (targetMs < this.currentMs) {
      throw new Error("virtual clock cannot move backwards");
    }
    let callbacks = 0;
    for (;;) {
      const next = [...this.tasks.values()]
        .filter(({ dueAtMs }) => dueAtMs <= targetMs)
        .toSorted((left, right) => left.dueAtMs - right.dueAtMs || left.id - right.id)[0];
      if (next === undefined) {
        break;
      }
      this.currentMs = next.dueAtMs;
      if (next.intervalMs === null) {
        this.tasks.delete(next.id);
      } else {
        next.dueAtMs += next.intervalMs;
      }
      next.callback();
      callbacks += 1;
      if (callbacks % 100 === 0) {
        await Promise.resolve();
      }
    }
    this.currentMs = targetMs;
    await Promise.resolve();
    await Promise.resolve();
  }

  private add(
    delayMs: number,
    intervalMs: number | null,
    callback: () => void,
  ): VirtualTask {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new Error("virtual timer delay must be a non-negative integer");
    }
    const id = this.nextId;
    this.nextId += 1;
    const task: VirtualTask = {
      callback,
      dueAtMs: this.currentMs + delayMs,
      id,
      intervalMs,
      unref: () => {},
    };
    this.tasks.set(id, task);
    return task;
  }
}
