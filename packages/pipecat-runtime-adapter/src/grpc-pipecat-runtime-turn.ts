import {
  type ConversationRuntimeEvent as TransportEvent,
  type ConversationRuntimeStartTurn,
} from "@discord-meeting/conversation-runtime-contracts";
import type {
  ConversationCancellationReason,
  ConversationRuntimeEvent,
  ConversationRuntimeTurn,
} from "@discord-meeting/meeting-core";

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
  private expectedEventSequence = 0;
  private queuedAudioBytes = 0;
  private paused = false;
  private terminal = false;

  public constructor(
    private readonly call: ConversationDuplexCall,
    private readonly turnId: string,
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
    await this.write(createGrpcConversationStartMessage(request));
  }

  public abortBeforeStart(): void {
    this.call.cancel();
    this.complete();
  }

  public cancel(reason: ConversationCancellationReason): Promise<void> {
    if (this.terminal) {
      return Promise.resolve();
    }
    if (this.attemptId !== undefined) {
      void this.write(
        createGrpcConversationCancellationMessage(this.turnId, this.attemptId, reason),
      ).catch(() => {
        // The transport is cancelled below; the protocol write is best-effort.
      });
      this.eventBuffer.push({
        attemptId: this.attemptId,
        reason,
        type: "cancelled",
      });
    }
    this.call.cancel();
    this.complete();
    return Promise.resolve();
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
    this.call.end();
    this.eventBuffer.close();
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
}
