import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CraigPlaybackGateway } from "@discord-meeting/craig-playback-adapter";
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

import type { PlatformConfig } from "../src/config.js";
import {
  createPlatformLiveConversationConfiguration,
  createPlatformLiveMeetingRuntime,
} from "../src/composition/discord-live.js";
import { createLiveConversationResources } from
  "../src/composition/conversation-coordinator.js";
import type { PlatformLiveMeetingRuntime } from "../src/live-meeting-runtime.js";
import type {
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
export const twoHoursMs = 7_200_000;
export const oneMinuteMs = 60_000;
export const hardGreetingLatencyMs = 500;
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
  }),
});

interface ComposePhaseInput {
  readonly clock: VirtualClock;
  readonly database: PoolConfig;
  readonly groundedAnswers: GroundedAnswerProbe;
  readonly meetingId: string;
  readonly phase: string;
  readonly recordingRoot: string;
}

export interface QualificationPhase {
  readonly clock: VirtualClock;
  readonly conversationRuntime: ControlledGroundedConversationRuntime;
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
  closeFinal(): Promise<void>;
  releaseForRestart(): Promise<Awaited<ReturnType<
    PostgresLiveMeetingRepository["readSnapshotAndTimeline"]
  >>>;
}

export async function composePhase(input: ComposePhaseInput): Promise<QualificationPhase> {
  const pool = new Pool(input.database);
  await pool.query("SELECT 1");
  const meetings = new PostgresLiveMeetingRepository(pool);
  const receipts = new PostgresConversationOneShotReceiptStore(pool);
  const playback = new CraigPlaybackGateway(() => input.clock.nowMilliseconds());
  const transport = await DurableCraigPlaybackTransport.open({
    clock: input.clock,
    meetingId: input.meetingId,
    phase: input.phase,
    root: input.recordingRoot,
  });
  playback.register(transport);
  const conversationRuntime = new ControlledGroundedConversationRuntime();
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
    config: livePolicyConfig,
    coordinator: resources.coordinator,
    farewellCues: resources.farewellCues,
    greetingCues: resources.greetingCues,
    isPlaybackReady: (recordingId) => playback.hasSession(recordingId),
    nowMilliseconds: () => input.clock.nowMilliseconds(),
    oneShotReceipts: receipts,
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
  let closed = false;
  const releaseResources = async (): Promise<void> => {
    await transport.whenIdle();
    playback.close();
    await resources.coordinator?.close(input.clock.nowMilliseconds());
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
    conversationRuntime,
    coordinator: resources.coordinator,
    meetings,
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

class ControlledGroundedConversationRuntime implements ConversationRuntime {
  public activeTurns = 0;
  public readonly cancelReasons: ConversationCancellationReason[] = [];
  public maximumActiveTurns = 0;
  public readonly requests: ConversationStartRequest[] = [];
  private releaseLate: (() => void) | undefined;

  public startTurn(
    request: ConversationStartRequest,
    options: ConversationStartOptions = {},
  ): Promise<ConversationPortResult<ConversationRuntimeTurn>> {
    options.signal?.throwIfAborted();
    if (request.literalSpeech !== "We decided to ship Friday.") {
      throw new Error("grounded qualification must use validated literal speech");
    }
    this.requests.push(structuredClone(request));
    this.activeTurns += 1;
    this.maximumActiveTurns = Math.max(this.maximumActiveTurns, this.activeTurns);
    let cancelled: ConversationCancellationReason | undefined;
    const late = new Promise<void>((resolve) => {
      this.releaseLate = resolve;
    });
    return Promise.resolve({
      ok: true,
      value: {
        cancel: async (reason) => {
          cancelled = reason;
          this.cancelReasons.push(reason);
          this.releaseLate?.();
        },
        events: this.events(request, late, () => cancelled),
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
  ): AsyncGenerator<ConversationRuntimeEvent> {
    const attemptId = `grounded-attempt-${request.turnId}`;
    try {
      yield { attemptId, type: "accepted" };
      yield {
        attemptId,
        channels: 1,
        format: "pcm_s16le",
        sampleRateHz: 48_000,
        type: "audio-start",
      };
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
