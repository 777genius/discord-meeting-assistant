import { createHash } from "node:crypto";

import type {
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
  type LiveCaptionSnapshot,
} from "@discord-meeting/meeting-core";
import type { Logger } from "@discord-meeting/observability-adapter";
import type {
  VoicetextLiveSession,
  VoicetextLiveTranscriptEvent,
  OpenVoicetextLiveSessionRequest,
} from "@discord-meeting/voicetext-adapter";

const refreshIntervalMs = 5_000;
const captionRetentionMs = 30_000;
const maximumContinuousPacketGapMs = 120;
const maximumQueuedPacketsPerSpeaker = 512;
const maximumRememberedMeetingPacketIds = 65_536;
const defaultSpeakerIdleFinalizeMs = 750;

export interface LiveMeetingRuntimeDependencies {
  readonly appendTurn: AppendLiveTranscriptTurn;
  readonly finishMeeting: FinishLiveMeeting;
  readonly logger: Logger;
  readonly publicationTargetId: string;
  readonly refreshMeeting: RefreshLiveMeeting;
  readonly speakerIdleFinalizeMs?: number;
  readonly startMeeting: StartLiveMeeting;
  readonly transcriber: LiveTranscriptionPort;
}

interface LiveTranscriptionPort {
  openSession(request: OpenVoicetextLiveSessionRequest): Promise<VoicetextLiveSession>;
}

interface SpeakerStream {
  chain: Promise<void>;
  inactivityTimer: NodeJS.Timeout | null;
  lastRelativeTimeMs: number | null;
  nextSegment: number;
  queuedPackets: number;
  session: VoicetextLiveSession | null;
}

interface LiveMeetingState {
  readonly captions: Map<string, LiveCaptionSnapshot>;
  domainChain: Promise<void>;
  finishPromise: Promise<void> | null;
  finishing: boolean;
  readonly meetingId: string;
  readonly packetIdOrder: string[];
  readonly packetIds: Set<string>;
  refreshQueued: boolean;
  readonly speakers: Map<string, SpeakerStream>;
  readonly startedAtMs: number;
}

export class PlatformLiveMeetingRuntime {
  private readonly meetings = new Map<string, LiveMeetingState>();
  private readonly refreshTimer: NodeJS.Timeout;
  private readonly speakerIdleFinalizeMs: number;

  public constructor(private readonly dependencies: LiveMeetingRuntimeDependencies) {
    this.speakerIdleFinalizeMs = validateSpeakerIdleFinalizeMs(
      dependencies.speakerIdleFinalizeMs,
    );
    this.refreshTimer = setInterval(() => {
      this.tick();
    }, refreshIntervalMs);
    this.refreshTimer.unref();
  }

  public acceptLifecycle(event: CraigLifecycleEvent): void {
    if (event.type === "meeting.started") {
      this.start(event);
      return;
    }
    if (event.type === "meeting.ended" || event.type === "meeting.aborted") {
      const state = this.meetings.get(event.recordingId);
      if (state !== undefined && !state.finishing) {
        state.finishing = true;
        state.finishPromise = this.finish(state, Date.parse(event.occurredAt));
      }
    }
  }

  public acceptVoiceBatch(batch: VoicePacketBatch): void {
    for (const packet of batch.packets) {
      const state = this.meetings.get(packet.recordingId);
      if (state === undefined || state.finishing) {
        this.dependencies.logger.debug("Live packet skipped without active derived meeting", {
          meetingId: packet.recordingId,
          speakerId: packet.speakerId,
        });
        continue;
      }
      const stream = this.speakerStream(state, packet.speakerId);
      const packetId = packetIdentity(packet);
      if (state.packetIds.has(packetId)) {
        continue;
      }
      if (
        stream.lastRelativeTimeMs !== null &&
        packet.relativeTimeMs < stream.lastRelativeTimeMs
      ) {
        this.dependencies.logger.warn("Out-of-order live packet skipped", {
          meetingId: state.meetingId,
          speakerId: packet.speakerId,
        });
        continue;
      }
      const rotateBeforeSend =
        stream.lastRelativeTimeMs !== null &&
        packet.relativeTimeMs - stream.lastRelativeTimeMs > maximumContinuousPacketGapMs;
      stream.lastRelativeTimeMs = packet.relativeTimeMs;
      this.cancelSpeakerIdleFinalization(stream);
      if (stream.queuedPackets >= maximumQueuedPacketsPerSpeaker) {
        this.dependencies.logger.warn("Live transcription packet queue is full", {
          meetingId: packet.recordingId,
          speakerId: packet.speakerId,
        });
        continue;
      }
      rememberMeetingPacket(state, packetId);
      stream.queuedPackets += 1;
      const task = async () => {
        try {
          if (rotateBeforeSend && stream.session !== null) {
            const priorSession = stream.session;
            stream.session = null;
            try {
              await priorSession.finalize();
            } catch (error) {
              priorSession.terminate();
              this.dependencies.logger.warn("Derived live timeline-gap finalize failed", {
                errorName: error instanceof Error ? error.name : "UnknownError",
                meetingId: state.meetingId,
                speakerId: packet.speakerId,
              });
            }
          }
          if (stream.session === null) {
            const segment = stream.nextSegment;
            stream.nextSegment += 1;
            stream.session = await this.dependencies.transcriber.openSession({
              idempotencyKey: `voicetext-live:v2|${state.meetingId}|${packet.speakerId}|${segment}`,
              meetingId: state.meetingId,
              onTranscript: (transcript) => {
                this.acceptTranscript(state, transcript);
              },
              speakerId: packet.speakerId,
            });
          }
          await stream.session.sendPacket({
            opus: Buffer.from(packet.opusBase64, "base64"),
            packetId,
            relativeTimeMs: packet.relativeTimeMs,
          });
        } catch (error) {
          stream.session?.terminate();
          stream.session = null;
          this.dependencies.logger.warn("Derived live transcription packet failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            meetingId: state.meetingId,
            speakerId: packet.speakerId,
          });
        } finally {
          stream.queuedPackets -= 1;
          if (stream.queuedPackets === 0 && stream.session !== null && !state.finishing) {
            this.scheduleSpeakerIdleFinalization(state, packet.speakerId, stream);
          }
        }
      };
      stream.chain = stream.chain.then(task, task);
    }
  }

  public async settleBeforeAuthoritativeFinal(recordingId: string): Promise<void> {
    const state = this.meetings.get(recordingId);
    if (state === undefined) {
      return;
    }
    if (!state.finishing) {
      state.finishing = true;
      state.finishPromise = this.finish(state, Date.now());
    }
    await state.finishPromise;
  }

  public async close(): Promise<void> {
    clearInterval(this.refreshTimer);
    const nowMs = Date.now();
    await Promise.allSettled(
      [...this.meetings.values()].map((state) => {
        if (!state.finishing) {
          state.finishing = true;
          state.finishPromise = this.finish(state, nowMs);
        }
        return state.finishPromise ?? Promise.resolve();
      }),
    );
  }

  private start(event: Extract<CraigLifecycleEvent, { readonly type: "meeting.started" }>): void {
    if (this.meetings.has(event.recordingId)) {
      return;
    }
    const state: LiveMeetingState = {
      captions: new Map(),
      domainChain: Promise.resolve(),
      finishPromise: null,
      finishing: false,
      meetingId: event.recordingId,
      packetIdOrder: [],
      packetIds: new Set(),
      refreshQueued: false,
      speakers: new Map(),
      startedAtMs: Date.parse(event.occurredAt),
    };
    this.meetings.set(event.recordingId, state);
    this.enqueueDomain(state, async () => {
      const result = await this.dependencies.startMeeting.execute({
        meetingId: state.meetingId,
        publicationTargetId: this.dependencies.publicationTargetId,
        startedAtMs: state.startedAtMs,
      });
      this.dependencies.logger.info("Derived live meeting started", {
        meetingId: state.meetingId,
        reused: result.status === "reused",
      });
    });
  }

  private speakerStream(state: LiveMeetingState, speakerId: string): SpeakerStream {
    const existing = state.speakers.get(speakerId);
    if (existing !== undefined) {
      return existing;
    }
    const created: SpeakerStream = {
      chain: Promise.resolve(),
      inactivityTimer: null,
      lastRelativeTimeMs: null,
      nextSegment: 1,
      queuedPackets: 0,
      session: null,
    };
    state.speakers.set(speakerId, created);
    return created;
  }

  private acceptTranscript(
    state: LiveMeetingState,
    event: VoicetextLiveTranscriptEvent,
  ): void {
    state.captions.set(event.speakerId, {
      endMs: event.endMs,
      isFinal: event.isFinal,
      speakerId: event.speakerId,
      startMs: event.startMs,
      text: event.text,
    });
    if (!event.isFinal) {
      return;
    }
    this.dependencies.logger.info("Live transcript turn finalized", {
      endMs: event.endMs,
      meetingId: state.meetingId,
      providerLagMs: Math.max(0, Date.now() - (state.startedAtMs + event.endMs)),
      speakerId: event.speakerId,
      startMs: event.startMs,
    });
    this.enqueueDomain(state, async () => {
      const result = await this.dependencies.appendTurn.execute(state.meetingId, {
        endMs: event.endMs,
        speakerId: event.speakerId,
        startMs: event.startMs,
        text: event.text,
        turnId: stableTurnId(event),
      });
      if (result === "not-found") {
        throw new Error("Live meeting disappeared before transcript append");
      }
    });
  }

  private tick(): void {
    const nowMs = Date.now();
    for (const state of this.meetings.values()) {
      if (state.finishing || state.refreshQueued) {
        continue;
      }
      state.refreshQueued = true;
      this.enqueueDomain(state, async () => {
        try {
          await this.refresh(state, nowMs);
        } finally {
          state.refreshQueued = false;
        }
      });
    }
  }

  private async refresh(state: LiveMeetingState, nowMs: number): Promise<void> {
    const refreshStartedAtMs = performance.now();
    const captions = [...state.captions.values()]
      .filter(({ endMs }) => nowMs - state.startedAtMs - endMs <= captionRetentionMs)
      .toSorted((left, right) => left.startMs - right.startMs || left.speakerId.localeCompare(right.speakerId));
    const result = await this.dependencies.refreshMeeting.execute({
      captions,
      meetingId: state.meetingId,
      nowMs,
    });
    if (result.status === "not-found") {
      throw new Error("Live meeting disappeared before refresh");
    }
    if (result.generationFailure !== undefined) {
      this.dependencies.logger.warn("Incremental meeting summary refresh failed", {
        errorCode: result.generationFailure.code,
        meetingId: state.meetingId,
        retryable: result.generationFailure.retryable,
      });
    }
    if (result.generationUsage !== undefined) {
      this.dependencies.logger.info("Incremental meeting summary usage measured", {
        apiEquivalentCostUsd: result.generationUsage.apiEquivalentCostUsd,
        cachedInputTokens: result.generationUsage.cachedInputTokens,
        inputTokens: result.generationUsage.inputTokens,
        meetingId: state.meetingId,
        model: result.generationUsage.model,
        outputTokens: result.generationUsage.outputTokens,
        priceCard: result.generationUsage.priceCard,
        totalTokens: result.generationUsage.totalTokens,
      });
    } else if (result.generated) {
      this.dependencies.logger.warn("Incremental meeting summary usage telemetry is missing", {
        meetingId: state.meetingId,
      });
    }
    if (result.projectionFailure !== undefined) {
      this.dependencies.logger.warn("Live Discord projection refresh failed", {
        errorCode: result.projectionFailure.code,
        meetingId: state.meetingId,
        retryable: result.projectionFailure.retryable,
      });
    }
    this.dependencies.logger.info("Live meeting refresh completed", {
      durationMs: Math.max(0, performance.now() - refreshStartedAtMs),
      generated: result.generated,
      meetingId: state.meetingId,
      projected: result.projected,
    });
  }

  private async finish(state: LiveMeetingState, endedAtMs: number): Promise<void> {
    const finalizeTasks = [...state.speakers.entries()].map(async ([speakerId, stream]) => {
      this.cancelSpeakerIdleFinalization(stream);
      await stream.chain.catch(() => {});
      try {
        await stream.session?.finalize();
      } catch (error) {
        stream.session?.terminate();
        this.dependencies.logger.warn("Derived live speaker finalize failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: state.meetingId,
          speakerId,
        });
      }
    });
    await Promise.allSettled(finalizeTasks);
    this.enqueueDomain(state, async () => {
      const result = await this.dependencies.finishMeeting.execute(state.meetingId, endedAtMs);
      if (result === "not-found") {
        throw new Error("Live meeting disappeared before finish");
      }
      await this.refresh(state, endedAtMs);
      this.meetings.delete(state.meetingId);
    });
    await state.domainChain;
  }

  private scheduleSpeakerIdleFinalization(
    state: LiveMeetingState,
    speakerId: string,
    stream: SpeakerStream,
  ): void {
    this.cancelSpeakerIdleFinalization(stream);
    stream.inactivityTimer = setTimeout(() => {
      stream.inactivityTimer = null;
      const finalize = async () => {
        if (state.finishing || stream.queuedPackets > 0 || stream.session === null) {
          return;
        }
        const session = stream.session;
        stream.session = null;
        try {
          await session.finalize();
        } catch (error) {
          session.terminate();
          this.dependencies.logger.warn("Derived live idle speaker finalize failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            meetingId: state.meetingId,
            speakerId,
          });
        }
      };
      stream.chain = stream.chain.then(finalize, finalize);
    }, this.speakerIdleFinalizeMs);
    stream.inactivityTimer.unref();
  }

  private cancelSpeakerIdleFinalization(stream: SpeakerStream): void {
    if (stream.inactivityTimer !== null) {
      clearTimeout(stream.inactivityTimer);
      stream.inactivityTimer = null;
    }
  }

  private enqueueDomain(state: LiveMeetingState, task: () => Promise<void>): void {
    const guarded = async () => {
      try {
        await task();
      } catch (error) {
        this.dependencies.logger.warn("Derived live meeting operation failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: state.meetingId,
        });
      }
    };
    state.domainChain = state.domainChain.then(guarded, guarded);
  }
}

function validateSpeakerIdleFinalizeMs(value: number | undefined): number {
  const resolved = value ?? defaultSpeakerIdleFinalizeMs;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 10_000) {
    throw new RangeError("speakerIdleFinalizeMs must be between 100 and 10000");
  }
  return resolved;
}

function rememberMeetingPacket(state: LiveMeetingState, packetId: string): void {
  state.packetIds.add(packetId);
  state.packetIdOrder.push(packetId);
  if (state.packetIdOrder.length > maximumRememberedMeetingPacketIds) {
    const evicted = state.packetIdOrder.shift();
    if (evicted !== undefined) {
      state.packetIds.delete(evicted);
    }
  }
}

function packetIdentity(packet: VoicePacketBatch["packets"][number]): string {
  return [
    packet.recordingId,
    packet.speakerId,
    packet.rtpTimestamp,
    packet.rtpSequence,
    packet.relativeTimeMs,
  ].join(":");
}

function stableTurnId(event: VoicetextLiveTranscriptEvent): string {
  const digest = createHash("sha256")
    .update(
      [event.meetingId, event.speakerId, event.startMs, event.endMs, event.text].join("\0"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return `live-turn:v1:${digest}`;
}
