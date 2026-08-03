import { createHash } from "node:crypto";

import type {
  CraigLifecycleEvent,
  VoicePacketBatch,
} from "@discord-meeting/craig-gateway-contracts";
import { renderRussianLiveCaptionsMarkdown } from "@discord-meeting/discord-adapter";
import {
  AppendLiveTranscriptTurn,
  FinishLiveMeeting,
  RefreshLiveMeeting,
  StartLiveMeeting,
  type LiveCaptionSnapshot,
  type LiveGenerationTelemetrySnapshot,
  type TranscriptTurnSnapshot,
} from "@discord-meeting/meeting-core";
import type { Logger } from "@discord-meeting/observability-adapter";
import { opusPacketDurationSamples } from "@discord-meeting/recording-ingress-adapter";
import type {
  VoicetextLiveSession,
  VoicetextLiveTranscriptEvent,
  OpenVoicetextLiveSessionRequest,
} from "@discord-meeting/voicetext-adapter";

import {
  boundLiveFinalCaptionHistory,
  compareLiveCaptionSnapshots,
} from "./live-caption-history.js";

const refreshIntervalMs = 5_000;
const refreshSchedulerIntervalMs = 100;
const maximumInitialCaptionProjectionJitterMs = 900;
const activeCaptionRetentionMs = 30_000;
const maximumQueuedPacketsPerSpeaker = 512;
const maximumRememberedMeetingPacketIds = 65_536;
const defaultSpeakerIdleFinalizeMs = 750;
const initialSummaryGenerationBackoffMs = 30_000;
const maximumSummaryGenerationBackoffMs = 300_000;
const initialProjectionBackoffMs = 10_000;
const maximumProjectionBackoffMs = 300_000;

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
  readonly activeCaptions: Map<string, LiveCaptionSnapshot>;
  domainChain: Promise<void>;
  readonly finalCaptions: Map<string, LiveCaptionSnapshot>;
  finishPromise: Promise<void> | null;
  finishing: boolean;
  generationFailureCount: number;
  permanentGenerationBase: string | null;
  generationPromise: Promise<void> | null;
  generationRetryAtMs: number;
  lastProjectedCaptionsSignature: string | null;
  readonly meetingId: string;
  nextRefreshAtMs: number;
  nextSummaryRefreshAtMs: number;
  readonly packetIdOrder: string[];
  readonly packetIds: Set<string>;
  permanentProjectionFailureCode: string | null;
  projectionFailureCount: number;
  projectionRetryAtMs: number;
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
    }, refreshSchedulerIntervalMs);
    this.refreshTimer.unref();
  }

  public acceptLifecycle(event: CraigLifecycleEvent): void {
    if (event.type === "meeting.started") {
      this.start(event);
      return;
    }
    if (event.type === "meeting.ended" || event.type === "meeting.aborted") {
      const state = this.meetings.get(event.recordingId);
      if (state !== undefined) {
        this.beginFinish(state, Date.parse(event.occurredAt));
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
          const opus = Buffer.from(packet.opusBase64, "base64");
          const durationSamples48Khz = opusPacketDurationSamples(opus);
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
            durationSamples48Khz,
            opus,
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

  public prepareForAuthoritativeFinal(recordingId: string): void {
    const state = this.meetings.get(recordingId);
    if (state === undefined) {
      return;
    }
    this.beginFinish(state, Date.now());
  }

  public async settleBeforeFinalPublication(recordingId: string): Promise<void> {
    const state = this.meetings.get(recordingId);
    if (state === undefined) {
      return;
    }
    this.beginFinish(state, Date.now());
    await state.finishPromise;
  }

  public async close(): Promise<void> {
    clearInterval(this.refreshTimer);
    const nowMs = Date.now();
    await Promise.allSettled(
      [...this.meetings.values()].map((state) => {
        this.beginFinish(state, nowMs);
        return state.finishPromise ?? Promise.resolve();
      }),
    );
  }

  private start(event: Extract<CraigLifecycleEvent, { readonly type: "meeting.started" }>): void {
    if (this.meetings.has(event.recordingId)) {
      return;
    }
    const state: LiveMeetingState = {
      activeCaptions: new Map(),
      domainChain: Promise.resolve(),
      finalCaptions: new Map(),
      finishPromise: null,
      finishing: false,
      generationFailureCount: 0,
      permanentGenerationBase: null,
      generationPromise: null,
      generationRetryAtMs: 0,
      lastProjectedCaptionsSignature: null,
      meetingId: event.recordingId,
      nextRefreshAtMs: Date.now() + refreshIntervalMs,
      nextSummaryRefreshAtMs: Date.now() + refreshIntervalMs,
      packetIdOrder: [],
      packetIds: new Set(),
      permanentProjectionFailureCode: null,
      projectionFailureCount: 0,
      projectionRetryAtMs: 0,
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
      restoreFinalCaptions(state, result.finalizedTurns);
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
    const caption: LiveCaptionSnapshot = {
      endMs: event.endMs,
      isFinal: event.isFinal,
      speakerId: event.speakerId,
      startMs: event.startMs,
      text: event.text,
    };
    if (!event.isFinal) {
      state.activeCaptions.set(event.speakerId, caption);
      scheduleFirstCaptionProjection(state, caption.text);
      return;
    }
    state.activeCaptions.delete(event.speakerId);
    state.finalCaptions.set(stableTurnId(event), caption);
    boundLiveFinalCaptionHistory(state.finalCaptions);
    scheduleFirstCaptionProjection(state, caption.text);
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
      const projectionDue = nowMs >= state.nextRefreshAtMs;
      const summaryDue = nowMs >= state.nextSummaryRefreshAtMs;
      if (state.finishing || state.refreshQueued || (!projectionDue && !summaryDue)) {
        continue;
      }
      const refreshDueAtMs = state.nextRefreshAtMs;
      const summaryDueAtMs = state.nextSummaryRefreshAtMs;
      state.refreshQueued = true;
      this.enqueueDomain(state, async () => {
        try {
          if (state.finishing) {
            return;
          }
          if (projectionDue) {
            await this.refreshProjection(state, nowMs);
          }
          if (summaryDue) {
            this.startSummaryGeneration(state, nowMs);
          }
        } finally {
          if (projectionDue) {
            state.nextRefreshAtMs = nextRefreshAtMs(refreshDueAtMs, Date.now());
          }
          if (summaryDue) {
            state.nextSummaryRefreshAtMs = nextRefreshAtMs(summaryDueAtMs, Date.now());
          }
          state.refreshQueued = false;
        }
      });
    }
  }

  private async refreshProjection(state: LiveMeetingState, nowMs: number): Promise<void> {
    const refreshStartedAtMs = performance.now();
    const captions = collectLiveCaptions(state, Math.max(0, nowMs - state.startedAtMs));
    const captionsSignature = liveCaptionsSignature(captions);
    const projectionAllowed = this.projectionAllowed(state, nowMs);
    const result = await this.dependencies.refreshMeeting.execute({
      captions,
      meetingId: state.meetingId,
      nowMs,
      ...(projectionAllowed ? {} : { projection: "skip" as const }),
      projectionRequested: projectionAllowed &&
        captionsSignature !== state.lastProjectedCaptionsSignature,
      summaryGeneration: "skip",
    });
    if (result.status === "not-found") {
      throw new Error("Live meeting disappeared before refresh");
    }
    this.reconcilePermanentGenerationFence(state, result.generationBase);
    if (result.projectionFailure !== undefined) {
      if (result.projectionFailure.retryable) {
        this.deferProjection(state, result.projectionFailure.code);
      } else {
        this.fencePermanentProjectionFailure(state, result.projectionFailure.code);
      }
      this.dependencies.logger.warn("Live Discord projection refresh failed", {
        errorCode: result.projectionFailure.code,
        meetingId: state.meetingId,
        retryable: result.projectionFailure.retryable,
      });
    }
    if (result.projected) {
      state.lastProjectedCaptionsSignature = captionsSignature;
      state.projectionFailureCount = 0;
      state.projectionRetryAtMs = 0;
    }
    this.dependencies.logger.info("Live caption projection refresh completed", {
      durationMs: Math.max(0, performance.now() - refreshStartedAtMs),
      meetingId: state.meetingId,
      projectionAllowed,
      projected: result.projected,
    });
  }

  private projectionAllowed(state: LiveMeetingState, nowMs: number): boolean {
    return state.permanentProjectionFailureCode === null && nowMs >= state.projectionRetryAtMs;
  }

  private deferProjection(state: LiveMeetingState, errorCode: string): void {
    state.projectionFailureCount += 1;
    const delayMs = projectionBackoffDelayMs(state.meetingId, state.projectionFailureCount);
    state.projectionRetryAtMs = Date.now() + delayMs;
    this.dependencies.logger.info("Live Discord projection retry deferred", {
      delayMs,
      errorCode,
      failureCount: state.projectionFailureCount,
      meetingId: state.meetingId,
    });
  }

  private fencePermanentProjectionFailure(state: LiveMeetingState, errorCode: string): void {
    if (state.permanentProjectionFailureCode !== null) {
      return;
    }
    state.permanentProjectionFailureCode = errorCode;
    state.projectionFailureCount = 0;
    state.projectionRetryAtMs = Number.POSITIVE_INFINITY;
    this.dependencies.logger.error("Live Discord projection permanently fenced", {
      errorCode,
      meetingId: state.meetingId,
      release: "runtime-restart-or-configuration-change",
    });
  }

  private startSummaryGeneration(state: LiveMeetingState, nowMs: number): void {
    if (
      state.finishing ||
      state.generationPromise !== null ||
      state.permanentGenerationBase !== null ||
      nowMs < state.generationRetryAtMs
    ) {
      return;
    }
    const generation = this.generateSummary(state, nowMs)
      .catch((error: unknown) => {
        this.deferSummaryGeneration(state, "UNEXPECTED_LIVE_GENERATION_FAILURE", true);
        this.dependencies.logger.warn("Incremental meeting summary refresh failed", {
          errorCode: "UNEXPECTED_LIVE_GENERATION_FAILURE",
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: state.meetingId,
          retryable: true,
        });
      })
      .finally(() => {
        if (state.generationPromise === generation) {
          state.generationPromise = null;
        }
      });
    state.generationPromise = generation;
  }

  private async generateSummary(state: LiveMeetingState, nowMs: number): Promise<void> {
    const generationStartedAtMs = performance.now();
    const result = await this.dependencies.refreshMeeting.execute({
      captions: [],
      meetingId: state.meetingId,
      nowMs,
      projection: "skip",
      projectionRequested: false,
    });
    if (result.status === "not-found") {
      throw new Error("Live meeting disappeared before summary generation");
    }
    if (result.generationFailure !== undefined) {
      if (result.generationFailure.retryable) {
        this.deferSummaryGeneration(
          state,
          result.generationFailure.code,
          true,
        );
      } else {
        this.fencePermanentGenerationFailure(
          state,
          result.generationBase,
          result.generationFailure.code,
        );
      }
      this.dependencies.logger.warn("Incremental meeting summary refresh failed", {
        errorCode: result.generationFailure.code,
        meetingId: state.meetingId,
        retryable: result.generationFailure.retryable,
      });
    } else if (result.generated) {
      state.generationFailureCount = 0;
      state.generationRetryAtMs = 0;
      if (!state.finishing) {
        this.enqueueDomain(state, async () => {
          if (!state.finishing) {
            await this.refreshProjection(state, Date.now());
          }
        });
      }
    } else if (result.generationStale === true) {
      this.dependencies.logger.info("Incremental meeting summary result was stale", {
        meetingId: state.meetingId,
      });
    }
    if (result.generationTelemetry !== undefined) {
      this.dependencies.logger.info(
        "Incremental meeting summary telemetry recorded",
        generationTelemetryLogFields(state.meetingId, result.generationTelemetry),
      );
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
    } else if (result.generated && result.generationTelemetry === undefined) {
      this.dependencies.logger.warn("Incremental meeting summary usage telemetry is missing", {
        meetingId: state.meetingId,
      });
    }
    this.dependencies.logger.info("Incremental meeting summary refresh completed", {
      durationMs: Math.max(0, performance.now() - generationStartedAtMs),
      generated: result.generated,
      meetingId: state.meetingId,
      stale: result.generationStale ?? false,
    });
  }

  private deferSummaryGeneration(
    state: LiveMeetingState,
    errorCode: string,
    retryable: boolean,
  ): void {
    state.generationFailureCount += 1;
    const exponent = Math.min(state.generationFailureCount - 1, 4);
    const delayMs = Math.min(
      initialSummaryGenerationBackoffMs * 2 ** exponent,
      maximumSummaryGenerationBackoffMs,
    );
    state.generationRetryAtMs = Date.now() + delayMs;
    this.dependencies.logger.info("Incremental meeting summary retry deferred", {
      delayMs,
      errorCode,
      failureCount: state.generationFailureCount,
      meetingId: state.meetingId,
      retryable,
    });
  }

  private fencePermanentGenerationFailure(
    state: LiveMeetingState,
    generationBase: string | undefined,
    errorCode: string,
  ): void {
    if (generationBase === undefined) {
      this.deferSummaryGeneration(state, errorCode, true);
      return;
    }
    state.generationFailureCount = 0;
    state.generationRetryAtMs = Number.POSITIVE_INFINITY;
    state.permanentGenerationBase = generationBase;
    this.dependencies.logger.info("Incremental meeting summary permanently fenced", {
      errorCode,
      meetingId: state.meetingId,
    });
  }

  private reconcilePermanentGenerationFence(
    state: LiveMeetingState,
    generationBase: string | undefined,
  ): void {
    if (
      state.permanentGenerationBase === null ||
      generationBase === undefined ||
      generationBase === state.permanentGenerationBase
    ) {
      return;
    }
    state.generationFailureCount = 0;
    state.generationRetryAtMs = 0;
    state.permanentGenerationBase = null;
    this.dependencies.logger.info("Incremental meeting summary fence cleared for new evidence", {
      meetingId: state.meetingId,
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
    await state.generationPromise?.catch(() => {});
    this.enqueueDomain(state, async () => {
      const result = await this.dependencies.finishMeeting.execute(state.meetingId, endedAtMs);
      if (result === "not-found") {
        throw new Error("Live meeting disappeared before finish");
      }
      // Craig acknowledgement is no longer coupled to this work. The final
      // publisher waits on this finish promise, so keep the terminal projection
      // fast and let the durable post-call summary reconcile every turn.
      await this.refreshProjection(state, endedAtMs);
    });
    try {
      await state.domainChain;
    } finally {
      this.meetings.delete(state.meetingId);
    }
  }

  private beginFinish(state: LiveMeetingState, endedAtMs: number): void {
    if (state.finishing) {
      return;
    }
    state.finishing = true;
    const finishPromise = this.finish(state, endedAtMs);
    state.finishPromise = finishPromise;
    void finishPromise.catch((error: unknown) => {
      this.dependencies.logger.error("Derived live meeting finalization failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: state.meetingId,
      });
    });
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

function liveCaptionsSignature(captions: readonly LiveCaptionSnapshot[]): string {
  return createHash("sha256")
    .update(renderRussianLiveCaptionsMarkdown(captions), "utf8")
    .digest("hex");
}

function restoreFinalCaptions(
  state: LiveMeetingState,
  turns: readonly TranscriptTurnSnapshot[],
): void {
  for (const turn of turns) {
    state.finalCaptions.set(turn.turnId, {
      endMs: turn.endMs,
      isFinal: true,
      speakerId: turn.speakerId,
      startMs: turn.startMs,
      text: turn.text,
    });
  }
  boundLiveFinalCaptionHistory(state.finalCaptions);
}

function scheduleFirstCaptionProjection(state: LiveMeetingState, captionText: string): void {
  if (
    state.finishing ||
    state.lastProjectedCaptionsSignature !== null ||
    captionText.trim().length === 0
  ) {
    return;
  }
  const dueAtMs = Date.now() + deterministicOffsetMs(
    "live-first-caption-projection:v1",
    state.meetingId,
    maximumInitialCaptionProjectionJitterMs,
  );
  state.nextRefreshAtMs = Math.min(state.nextRefreshAtMs, dueAtMs);
}

function nextRefreshAtMs(previousDueAtMs: number, nowMs: number): number {
  const scheduled = previousDueAtMs + refreshIntervalMs;
  return scheduled > nowMs ? scheduled : nowMs + refreshIntervalMs;
}

function projectionBackoffDelayMs(meetingId: string, failureCount: number): number {
  const exponent = Math.min(failureCount - 1, 5);
  const baseDelayMs = Math.min(
    initialProjectionBackoffMs * 2 ** exponent,
    maximumProjectionBackoffMs,
  );
  const jitterBudgetMs = Math.floor(baseDelayMs / 5);
  return baseDelayMs - deterministicOffsetMs(
    `live-projection-retry:v1:${failureCount}`,
    meetingId,
    jitterBudgetMs,
  );
}

function deterministicOffsetMs(namespace: string, meetingId: string, maximumOffsetMs: number): number {
  if (maximumOffsetMs <= 0) {
    return 0;
  }
  const digest = createHash("sha256")
    .update(`${namespace}\0${meetingId}`, "utf8")
    .digest();
  return digest.readUInt32BE(0) % (maximumOffsetMs + 1);
}

function collectLiveCaptions(
  state: LiveMeetingState,
  elapsedMs: number,
): readonly LiveCaptionSnapshot[] {
  const cutoffMs = elapsedMs - activeCaptionRetentionMs;
  for (const [speakerId, caption] of state.activeCaptions) {
    if (caption.endMs < cutoffMs) {
      state.activeCaptions.delete(speakerId);
    }
  }

  return [...state.finalCaptions.values(), ...state.activeCaptions.values()]
    .toSorted(compareLiveCaptionSnapshots);
}

function generationTelemetryLogFields(
  meetingId: string,
  telemetry: LiveGenerationTelemetrySnapshot,
): Record<string, unknown> {
  return {
    cacheWriteInputTokens: telemetryTokenLogValue(telemetry.cacheWriteInputTokens),
    cachedInputTokens: telemetryTokenLogValue(telemetry.cachedInputTokens),
    ...(telemetry.cost === undefined
      ? {}
      : {
          ...(telemetry.cost.exactUsd === undefined
            ? {}
            : { exactCostUsd: telemetry.cost.exactUsd }),
          maximumCostUsd: telemetry.cost.maximumUsd,
          minimumCostUsd: telemetry.cost.minimumUsd,
          priceCardId: telemetry.cost.priceCardId,
          priceCardSource: telemetry.cost.priceCardSource,
        }),
    inputTokens: telemetryTokenLogValue(telemetry.inputTokens),
    meetingId,
    model: telemetry.model,
    outputTokens: telemetryTokenLogValue(telemetry.outputTokens),
    reasoningOutputTokens: telemetryTokenLogValue(telemetry.reasoningOutputTokens),
    runId: telemetry.runId,
    source: telemetry.source,
    totalTokens: telemetryTokenLogValue(telemetry.totalTokens),
  };
}

function telemetryTokenLogValue(
  token: LiveGenerationTelemetrySnapshot["inputTokens"],
): Record<string, unknown> {
  if (token.availability === "unavailable") {
    return { availability: "unavailable" };
  }
  if (token.availability === "measured") {
    return { availability: "measured", value: token.value };
  }
  return {
    availability: "derived",
    derivedFrom: token.derivedFrom,
    value: token.value,
  };
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
