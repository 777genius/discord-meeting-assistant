import {
  type ConversationRuntimeEvent as TransportEvent,
  type ConversationRuntimeStartTurn,
} from "@discord-meeting/conversation-runtime-contracts";
import {
  type ConversationCancellationReason,
  type ConversationRuntimeEvent,
  type ConversationRuntimeTurn,
} from "@discord-meeting/meeting-core/conversation";

import { AsyncEventBuffer } from "./async-event-buffer.js";
import {
  createGrpcConversationCancellationMessage,
  createGrpcConversationStartMessage,
  decodeGrpcConversationRuntimeEvent,
  isGrpcConversationTerminalEvent,
  toCoreConversationRuntimeEvent,
} from "./grpc-pipecat-protocol.js";
import { safeErrorMessage } from "./grpc-pipecat-runtime-support.js";
import type { ConversationDuplexCall, RawMessage } from "./grpc-pipecat-types.js";

const pauseIncomingAudioBytes = 96_000;
const resumeIncomingAudioBytes = 48_000;
const maximumIncomingAudioBytes = 192_000;

export class GrpcConversationRuntimeTurn implements ConversationRuntimeTurn {
  public readonly events: AsyncIterable<ConversationRuntimeEvent>;
  private readonly eventBuffer: AsyncEventBuffer<ConversationRuntimeEvent>;
  private attemptId: string | undefined;
  private readonly attemptWaiters: Array<() => void> = [];
  private expectedEventSequence = 0;
  private queuedAudioBytes = 0;
  private paused = false;
  private terminal = false;
  private readonly terminalWaiters: Array<() => void> = [];
  private writeClosed = false;

  public constructor(
    private readonly call: ConversationDuplexCall,
    private readonly turnId: string,
    private readonly cancellationTimeoutMs: number,
  ) {
    this.eventBuffer = new AsyncEventBuffer((event) => {
      this.eventConsumed(event);
    });
    this.events = this.eventBuffer;
    call.on("data", (message) => {
      this.receive(message);
    });
    call.on("error", (error) => {
      this.transportFailed(error);
    });
    call.on("end", () => {
      this.transportEnded();
    });
  }

  public async start(request: ConversationRuntimeStartTurn): Promise<void> {
    await this.writeWithTimeout(
      createGrpcConversationStartMessage(request),
      this.cancellationTimeoutMs,
      "Conversation runtime did not accept the initial write before the deadline",
    );
  }

  public abortBeforeStart(): void {
    this.call.cancel();
    this.complete();
  }

  public async cancel(reason: ConversationCancellationReason): Promise<void> {
    if (this.terminal) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        this.fail(
          "CONVERSATION_RUNTIME_CANCELLATION_TIMEOUT",
          "Conversation runtime did not acknowledge cancellation before the deadline",
          true,
        );
        resolve();
      }, this.cancellationTimeoutMs);
    });
    try {
      await Promise.race([this.cancelAndWait(reason), timedOut]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async cancelAndWait(reason: ConversationCancellationReason): Promise<void> {
    if (this.attemptId === undefined) {
      await this.waitForAttempt();
    }
    if (this.terminal) {
      return;
    }
    const attemptId = this.attemptId;
    if (attemptId === undefined) {
      return;
    }
    try {
      await this.write(
        createGrpcConversationCancellationMessage(this.turnId, attemptId, reason),
      );
    } catch (error) {
      this.fail(
        "CONVERSATION_RUNTIME_TRANSPORT_ERROR",
        safeErrorMessage(error, "Conversation runtime cancellation failed"),
        true,
      );
      return;
    }
    if (this.hasTerminated()) {
      return;
    }
    this.halfClose();
    await this.waitForTerminal();
  }

  private hasTerminated(): boolean {
    return this.terminal;
  }

  private receive(message: RawMessage): void {
    if (this.terminal) {
      return;
    }
    try {
      const event = decodeGrpcConversationRuntimeEvent(message);
      this.validateIncomingEvent(event);
      const coreEvent = toCoreConversationRuntimeEvent(event);
      this.trackIncomingAudio(coreEvent);
      this.eventBuffer.push(coreEvent);
      if (coreEvent.type === "accepted") {
        this.releaseAttemptWaiters();
      }
      if (isGrpcConversationTerminalEvent(event)) {
        this.complete();
      }
    } catch (error) {
      this.fail(
        "CONVERSATION_RUNTIME_PROTOCOL_ERROR",
        safeErrorMessage(error, "Conversation runtime protocol is invalid"),
        false,
      );
    }
  }

  private validateIncomingEvent(event: TransportEvent): void {
    if (event.turnId !== this.turnId) {
      throw new Error("Conversation runtime returned a different turn ID");
    }
    if (event.eventSequence !== this.expectedEventSequence) {
      throw new Error(
        `Conversation runtime event sequence ${event.eventSequence} does not match ${this.expectedEventSequence}`,
      );
    }
    if (this.expectedEventSequence === 0 && event.type !== "accepted") {
      throw new Error("Conversation runtime must accept a turn before emitting output");
    }
    this.expectedEventSequence += 1;
    if (this.attemptId !== undefined && event.attemptId !== this.attemptId) {
      throw new Error("Conversation runtime changed attempt ID during a turn");
    }
    this.attemptId = event.attemptId;
  }

  private trackIncomingAudio(event: ConversationRuntimeEvent): void {
    if (event.type !== "audio-chunk") {
      return;
    }
    this.queuedAudioBytes += event.bytes.byteLength;
    if (this.queuedAudioBytes > maximumIncomingAudioBytes) {
      this.queuedAudioBytes -= event.bytes.byteLength;
      throw new Error("Conversation runtime exceeded two seconds of buffered audio");
    }
    if (!this.paused && this.queuedAudioBytes >= pauseIncomingAudioBytes) {
      this.paused = true;
      this.call.pause();
    }
  }

  private transportFailed(error: Error): void {
    this.fail(
      "CONVERSATION_RUNTIME_TRANSPORT_ERROR",
      safeErrorMessage(error, "Conversation runtime transport failed"),
      true,
    );
  }

  private transportEnded(): void {
    if (!this.terminal) {
      this.fail(
        "CONVERSATION_RUNTIME_STREAM_ENDED",
        "Conversation runtime stream ended before a terminal event",
        true,
      );
    }
  }

  private fail(code: string, message: string, retryable: boolean): void {
    if (this.terminal) {
      return;
    }
    this.eventBuffer.push({
      attemptId: this.attemptId ?? "unassigned",
      failure: { code, message, retryable },
      type: "failed",
    });
    this.call.cancel();
    this.complete();
  }

  private complete(): void {
    if (this.terminal) {
      return;
    }
    this.terminal = true;
    this.halfClose();
    this.eventBuffer.close();
    this.releaseAttemptWaiters();
    for (const resolve of this.terminalWaiters.splice(0)) {
      resolve();
    }
  }

  private write(message: RawMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.call.write(message, (error) => {
        if (error === undefined || error === null) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  private async writeWithTimeout(
    message: RawMessage,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });
    try {
      await Promise.race([this.write(message), timedOut]);
    } finally {
      clearTimeout(timeout);
    }
  }

  private eventConsumed(event: ConversationRuntimeEvent): void {
    if (event.type !== "audio-chunk") {
      return;
    }
    this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - event.bytes.byteLength);
    if (this.paused && this.queuedAudioBytes <= resumeIncomingAudioBytes) {
      this.paused = false;
      this.call.resume();
    }
  }

  private async waitForTerminal(): Promise<void> {
    if (this.terminal) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.terminalWaiters.push(resolve);
    });
  }

  private async waitForAttempt(): Promise<void> {
    if (this.attemptId !== undefined || this.terminal) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.attemptWaiters.push(resolve);
    });
  }

  private releaseAttemptWaiters(): void {
    for (const resolve of this.attemptWaiters.splice(0)) {
      resolve();
    }
  }

  private halfClose(): void {
    if (this.writeClosed) {
      return;
    }
    this.writeClosed = true;
    this.call.end();
  }
}
