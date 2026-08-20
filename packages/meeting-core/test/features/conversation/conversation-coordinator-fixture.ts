import type {
  FinalizedConversationTurnInput,
  ConversationAudioChunk,
  ConversationCancellationReason,
  ConversationDelay,
  ConversationDelayPort,
  ConversationRuntime,
  ConversationRuntimeEvent,
  ConversationRuntimeTurn,
  ConversationStartRequest,
  ConversationStartOptions,
  ConversationThinkingCuePort,
  ConversationThinkingCueRequest,
  ConversationThinkingCueStage,
  ConversationPortResult,
  VoicePlaybackEvent,
  VoicePlaybackOpenOptions,
  VoicePlaybackPort,
  VoicePlaybackRequest,
  VoicePlaybackCancellationRequest,
  VoicePlaybackSession,
} from "@discord-meeting/meeting-core/conversation";

class EventStream<Value> implements AsyncIterable<Value> {
  private closed = false;
  private resolver: ((result: IteratorResult<Value, void>) => void) | null = null;
  private readonly values: Array<{ readonly value: Value }> = [];

  public close(): void {
    this.closed = true;
    const resolver = this.resolver;
    this.resolver = null;
    resolver?.({ done: true, value: undefined });
  }

  public push(value: Value): void {
    const resolver = this.resolver;
    if (resolver !== null) {
      this.resolver = null;
      resolver({ done: false, value });
      return;
    }
    this.values.push({ value });
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<Value> {
    for (;;) {
      const next = await this.next();
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }

  private next(): Promise<IteratorResult<Value, void>> {
    const nextValue = this.values.shift();
    if (nextValue !== undefined) {
      return Promise.resolve({ done: false, value: nextValue.value });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.resolver = resolve;
    });
  }
}

class ScriptedRuntime implements ConversationRuntime {
  public readonly cancellations: Array<{
    readonly reason: ConversationCancellationReason;
    readonly turnId: string;
  }> = [];
  public readonly requests: ConversationStartRequest[] = [];

  public constructor(private readonly streams: EventStream<ConversationRuntimeEvent>[]) {}

  public startTurn(
    request: ConversationStartRequest,
  ): Promise<ConversationPortResult<ConversationRuntimeTurn>> {
    const stream = this.streams.shift();
    if (stream === undefined) {
      throw new Error("unexpected conversation start");
    }
    this.requests.push(structuredClone(request));
    return Promise.resolve({
      ok: true,
      value: {
        cancel: (reason) => {
          this.cancellations.push({ reason, turnId: request.turnId });
          stream.close();
          return Promise.resolve();
        },
        events: stream,
      },
    });
  }
}

class AbortablePendingRuntime implements ConversationRuntime {
  public aborted = false;
  public startCount = 0;

  public startTurn(
    _request: ConversationStartRequest,
    options: ConversationStartOptions = {},
  ): Promise<ConversationPortResult<ConversationRuntimeTurn>> {
    this.startCount += 1;
    return new Promise((resolve) => {
      const abort = () => {
        this.aborted = true;
        resolve({
          failure: {
            code: "RUNTIME_START_CANCELLED",
            message: "test runtime start cancelled",
            retryable: true,
          },
          ok: false,
        });
      };
      if (options.signal?.aborted === true) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

class ControlledDelay implements ConversationDelay {
  public readonly elapsed: Promise<"cancelled" | "elapsed">;
  private resolve!: (value: "cancelled" | "elapsed") => void;

  public constructor() {
    this.elapsed = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  public cancel(): void {
    this.resolve("cancelled");
  }

  public elapse(): void {
    this.resolve("elapsed");
  }
}

class ControlledDelayPort implements ConversationDelayPort {
  public readonly delays: ControlledDelay[] = [];
  public readonly requestedMs: number[] = [];

  public start(delayMs: number): ConversationDelay {
    const delay = new ControlledDelay();
    this.requestedMs.push(delayMs);
    this.delays.push(delay);
    return delay;
  }
}

class FixedThinkingCues implements ConversationThinkingCuePort {
  public readonly selections: ConversationThinkingCueStage[] = [];

  public select(request: ConversationThinkingCueRequest) {
    this.selections.push(request.stage);
    return Promise.resolve({
      ok: true as const,
      value: {
        cueId: `thinking-${request.stage}`,
        playbackAttemptId: `cue-attempt-${request.turnId}-${request.stage}`,
        pcmChunks: [Uint8Array.of(1, 2), Uint8Array.of(3, 4)],
        pcmSha256: "c".repeat(64),
      },
    });
  }
}

class RecordingPlaybackSession implements VoicePlaybackSession {
  public readonly cancelReasons: ConversationCancellationReason[] = [];
  public readonly cancellationRequests: VoicePlaybackCancellationRequest[] = [];
  public readonly chunks: ConversationAudioChunk[] = [];
  public readonly events = new EventStream<VoicePlaybackEvent>();
  public finishCalls = 0;

  public constructor(
    public readonly request: VoicePlaybackRequest,
    private readonly failWrites: boolean,
  ) {
    this.events.push({
      attemptId: request.attemptId,
      startedAtMs: 100,
      type: "started",
    });
  }

  public cancel(
    request: VoicePlaybackCancellationRequest,
  ): Promise<ConversationPortResult<"cancelled" | "reused">> {
    this.cancellationRequests.push(structuredClone(request));
    this.cancelReasons.push(request.reason);
    this.events.push({
      attemptId: this.request.attemptId,
      finishedAtMs: 200,
      type: "finished",
    });
    this.events.close();
    return Promise.resolve({ ok: true, value: "cancelled" });
  }

  public finish(): Promise<ConversationPortResult<"finished" | "reused">> {
    this.finishCalls += 1;
    this.events.push({
      attemptId: this.request.attemptId,
      finishedAtMs: 200,
      type: "finished",
    });
    this.events.close();
    return Promise.resolve({ ok: true, value: "finished" });
  }

  public write(chunk: ConversationAudioChunk): Promise<ConversationPortResult<"accepted" | "reused">> {
    this.chunks.push(chunk);
    if (this.failWrites) {
      return Promise.resolve({
        failure: { code: "PLAYBACK_UNAVAILABLE", message: "injected", retryable: true },
        ok: false,
      });
    }
    return Promise.resolve({ ok: true, value: "accepted" });
  }
}

class RecordingPlayback implements VoicePlaybackPort {
  public readonly requests: VoicePlaybackRequest[] = [];
  public readonly sessions: RecordingPlaybackSession[] = [];

  public constructor(private readonly failingTurnIds = new Set<string>()) {}

  public open(
    request: VoicePlaybackRequest,
  ): Promise<ConversationPortResult<VoicePlaybackSession>> {
    this.requests.push(structuredClone(request));
    const session = new RecordingPlaybackSession(
      request,
      this.failingTurnIds.has(request.turnId),
    );
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

class ReceiptControlledPlaybackSession implements VoicePlaybackSession {
  public readonly cancellationRequests: VoicePlaybackCancellationRequest[] = [];
  public readonly chunks: ConversationAudioChunk[] = [];
  public readonly events = new EventStream<VoicePlaybackEvent>();

  public constructor(public readonly request: VoicePlaybackRequest) {}

  public cancel(
    request: VoicePlaybackCancellationRequest,
  ): Promise<ConversationPortResult<"cancelled" | "reused">> {
    this.cancellationRequests.push(structuredClone(request));
    this.events.push({
      attemptId: this.request.attemptId,
      finishedAtMs: request.cancellationObservedAtMs,
      type: "finished",
    });
    this.events.close();
    return Promise.resolve({ ok: true, value: "cancelled" });
  }

  public finish(): Promise<ConversationPortResult<"finished" | "reused">> {
    return Promise.resolve({ ok: true, value: "finished" });
  }

  public write(
    chunk: ConversationAudioChunk,
  ): Promise<ConversationPortResult<"accepted" | "reused">> {
    this.chunks.push(chunk);
    return Promise.resolve({ ok: true, value: "accepted" });
  }
}

class ReceiptControlledPlayback implements VoicePlaybackPort {
  public readonly sessions: ReceiptControlledPlaybackSession[] = [];

  public open(
    request: VoicePlaybackRequest,
  ): Promise<ConversationPortResult<VoicePlaybackSession>> {
    const session = new ReceiptControlledPlaybackSession(request);
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

class DelayedFirstOpenPlayback implements VoicePlaybackPort {
  public readonly requests: VoicePlaybackRequest[] = [];
  public readonly sessions: RecordingPlaybackSession[] = [];
  private releasePending: (() => void) | null = null;

  public open(
    request: VoicePlaybackRequest,
    options: VoicePlaybackOpenOptions = {},
  ): Promise<ConversationPortResult<VoicePlaybackSession>> {
    this.requests.push(structuredClone(request));
    if (this.requests.length > 1) {
      const session = new RecordingPlaybackSession(request, false);
      this.sessions.push(session);
      return Promise.resolve({ ok: true, value: session });
    }
    return new Promise((resolve) => {
      const abort = () => {
        this.releasePending = null;
        resolve({
          failure: {
            code: "PLAYBACK_OPEN_CANCELLED",
            message: "test playback open cancelled",
            retryable: true,
          },
          ok: false,
        });
      };
      if (options.signal?.aborted === true) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      this.releasePending = () => {
        options.signal?.removeEventListener("abort", abort);
        const session = new RecordingPlaybackSession(request, false);
        this.sessions.push(session);
        resolve({ ok: true, value: session });
      };
    });
  }

  public releaseFirstOpen(): void {
    const release = this.releasePending;
    this.releasePending = null;
    if (release === null) {
      throw new Error("first playback open is not pending");
    }
    release();
  }
}

class HeldFinishPlaybackSession extends RecordingPlaybackSession {
  public override finish(): Promise<ConversationPortResult<"finished" | "reused">> {
    this.finishCalls += 1;
    return Promise.resolve({ ok: true, value: "finished" });
  }

  public complete(finishedAtMs: number): void {
    this.events.push({
      attemptId: this.request.attemptId,
      finishedAtMs,
      type: "finished",
    });
    this.events.close();
  }
}

class HeldTerminalPlaybackSession extends RecordingPlaybackSession {
  public override cancel(
    request: VoicePlaybackCancellationRequest,
  ): Promise<ConversationPortResult<"cancelled" | "reused">> {
    this.cancellationRequests.push(structuredClone(request));
    this.cancelReasons.push(request.reason);
    return Promise.resolve({ ok: true, value: "cancelled" });
  }

  public complete(finishedAtMs: number): void {
    this.events.push({
      attemptId: this.request.attemptId,
      finishedAtMs,
      type: "finished",
    });
    this.events.close();
  }
}

class CloseWithoutFinishedPlaybackSession extends RecordingPlaybackSession {
  public override finish(): Promise<ConversationPortResult<"finished" | "reused">> {
    this.finishCalls += 1;
    this.events.close();
    return Promise.resolve({ ok: true, value: "finished" });
  }
}

class FailingCancellationPlaybackSession extends RecordingPlaybackSession {
  public constructor(
    request: VoicePlaybackRequest,
    failWrites: boolean,
    private readonly cancellationFailure: "result" | "throw",
  ) {
    super(request, failWrites);
  }

  public override cancel(
    request: VoicePlaybackCancellationRequest,
  ): Promise<ConversationPortResult<"cancelled" | "reused">> {
    this.cancellationRequests.push(structuredClone(request));
    this.cancelReasons.push(request.reason);
    if (this.cancellationFailure === "throw") {
      return Promise.reject(new Error("injected cancellation error"));
    }
    return Promise.resolve({
      failure: {
        code: "PLAYBACK_CANCEL_UNCONFIRMED",
        message: "injected cancellation result",
        retryable: true,
      },
      ok: false,
    });
  }

  public closeWithoutTerminalReceipt(): void {
    this.events.close();
  }

  public complete(finishedAtMs: number): void {
    this.events.push({
      attemptId: this.request.attemptId,
      finishedAtMs,
      type: "finished",
    });
    this.events.close();
  }
}

class HeldFirstFinishPlayback implements VoicePlaybackPort {
  public readonly requests: VoicePlaybackRequest[] = [];
  public readonly sessions: Array<
    HeldFinishPlaybackSession | RecordingPlaybackSession
  > = [];

  public open(
    request: VoicePlaybackRequest,
  ): Promise<ConversationPortResult<VoicePlaybackSession>> {
    this.requests.push(structuredClone(request));
    const session = this.requests.length === 1
      ? new HeldFinishPlaybackSession(request, false)
      : new RecordingPlaybackSession(request, false);
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

class HeldFirstTerminalPlayback implements VoicePlaybackPort {
  public readonly requests: VoicePlaybackRequest[] = [];
  public readonly sessions: Array<
    HeldTerminalPlaybackSession | RecordingPlaybackSession
  > = [];

  public open(
    request: VoicePlaybackRequest,
  ): Promise<ConversationPortResult<VoicePlaybackSession>> {
    this.requests.push(structuredClone(request));
    const session = this.requests.length === 1
      ? new HeldTerminalPlaybackSession(request, false)
      : new RecordingPlaybackSession(request, false);
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

class CloseWithoutFinishedPlayback implements VoicePlaybackPort {
  public readonly requests: VoicePlaybackRequest[] = [];
  public readonly sessions: CloseWithoutFinishedPlaybackSession[] = [];

  public open(
    request: VoicePlaybackRequest,
  ): Promise<ConversationPortResult<VoicePlaybackSession>> {
    this.requests.push(structuredClone(request));
    const session = new CloseWithoutFinishedPlaybackSession(request, false);
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

class FailingCancellationPlayback implements VoicePlaybackPort {
  public readonly requests: VoicePlaybackRequest[] = [];
  public readonly sessions: FailingCancellationPlaybackSession[] = [];

  public constructor(private readonly cancellationFailure: "result" | "throw") {}

  public open(
    request: VoicePlaybackRequest,
  ): Promise<ConversationPortResult<VoicePlaybackSession>> {
    this.requests.push(structuredClone(request));
    const session = new FailingCancellationPlaybackSession(
      request,
      false,
      this.cancellationFailure,
    );
    this.sessions.push(session);
    return Promise.resolve({ ok: true, value: session });
  }
}

function input(
  turnId: string,
  nowMs: number,
  text = "Ботик, ответь кратко.",
  overrides: Partial<FinalizedConversationTurnInput> = {},
): FinalizedConversationTurnInput {
  return {
    locale: "ru-RU",
    meetingId: "meeting-1",
    nowMs,
    recordingId: "recording-1",
    roomId: "private-room-1",
    speakerId: `speaker-${turnId}`,
    systemPrompt: "Отвечай кратко и дружелюбно.",
    text,
    thinkingCueLocale: "ru-RU",
    transcriptEndMs: nowMs + 1,
    transcriptStartMs: nowMs,
    turnId,
    voiceProfileId: "default",
    ...overrides,
  };
}

function audioChunk(attemptId: string, turnId: string, sequence: number): ConversationRuntimeEvent {
  return {
    attemptId,
    bytes: new Uint8Array([sequence]),
    channels: 1,
    format: "pcm_s16le",
    sampleRateHz: 48_000,
    sequence,
    turnId,
    type: "audio-chunk",
  };
}

function closedStream(events: readonly ConversationRuntimeEvent[]): EventStream<ConversationRuntimeEvent> {
  const stream = new EventStream<ConversationRuntimeEvent>();
  for (const event of events) {
    stream.push(event);
  }
  stream.close();
  return stream;
}

export {
  AbortablePendingRuntime,
  CloseWithoutFinishedPlayback,
  ControlledDelayPort,
  DelayedFirstOpenPlayback,
  EventStream,
  FailingCancellationPlayback,
  FixedThinkingCues,
  HeldFinishPlaybackSession,
  HeldFirstFinishPlayback,
  HeldFirstTerminalPlayback,
  HeldTerminalPlaybackSession,
  RecordingPlayback,
  ReceiptControlledPlayback,
  ScriptedRuntime,
  audioChunk,
  closedStream,
  input,
};
