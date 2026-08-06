import {
  conversationRuntimeProtocolVersion,
  parseConversationRuntimeStartTurn,
  type ConversationRuntimeHealth,
} from "@discord-meeting/conversation-runtime-contracts";
import type {
  ConversationCancellationReason,
  ConversationRuntime,
  ConversationRuntimeTurn,
  ConversationStartOptions,
  ConversationStartRequest,
  PortResult,
} from "@discord-meeting/meeting-core";

import { parseGrpcConversationRuntimeHealth } from "./grpc-pipecat-protocol.js";
import { GrpcConversationRuntimeTurn } from "./grpc-pipecat-runtime-turn.js";
import { failure, safeErrorMessage } from "./grpc-pipecat-runtime-support.js";
import {
  createAuthorizationMetadata,
  createGrpcConversationDuplexCallFactory,
} from "./grpc-pipecat-transport.js";
import type {
  ConversationDuplexCall,
  ConversationDuplexCallFactory,
  GrpcPipecatConversationRuntimeOptions,
} from "./grpc-pipecat-types.js";

const defaultCancellationTimeoutMs = 5_000;

export type {
  ConversationDuplexCall,
  ConversationDuplexCallFactory,
  GrpcPipecatConversationRuntimeOptions,
} from "./grpc-pipecat-types.js";

/**
 * Provider adapter facade. It validates application input and delegates wire
 * framing and turn stream lifecycle to focused gRPC collaborators.
 */
export class GrpcPipecatConversationRuntime implements ConversationRuntime {
  private readonly callFactory: ConversationDuplexCallFactory;
  private readonly cancellationTimeoutMs: number;
  private readonly metadata: ReturnType<typeof createAuthorizationMetadata>;

  public constructor(options: GrpcPipecatConversationRuntimeOptions) {
    if (options.serviceToken.trim().length < 16) {
      throw new Error("Pipecat runtime service token is too short");
    }
    this.cancellationTimeoutMs = parseCancellationTimeout(
      options.cancellationTimeoutMs ?? defaultCancellationTimeoutMs,
    );
    this.callFactory = options.callFactory ?? createGrpcConversationDuplexCallFactory(options);
    this.metadata = createAuthorizationMetadata(options.serviceToken);
  }

  public async startTurn(
    request: ConversationStartRequest,
    options: ConversationStartOptions = {},
  ): Promise<PortResult<ConversationRuntimeTurn>> {
    if (signalIsAborted(options.signal)) {
      return failure(
        "CONVERSATION_RUNTIME_START_CANCELLED",
        "Conversation runtime start was cancelled",
        true,
      );
    }
    const transportRequest = this.parseStartRequest(request);
    if (!transportRequest.ok) {
      return transportRequest;
    }

    let call: ConversationDuplexCall;
    try {
      call = this.callFactory.create(this.metadata);
    } catch (error) {
      return failure(
        "CONVERSATION_RUNTIME_UNAVAILABLE",
        safeErrorMessage(error, "Conversation runtime is unavailable"),
        true,
      );
    }

    const turn = new GrpcConversationRuntimeTurn(
      call,
      transportRequest.value.turnId,
      this.cancellationTimeoutMs,
    );
    let abortRequested = signalIsAborted(options.signal);
    const recordAbort = () => {
      abortRequested = true;
    };
    options.signal?.addEventListener("abort", recordAbort, { once: true });
    try {
      await turn.start(transportRequest.value);
    } catch (error) {
      options.signal?.removeEventListener("abort", recordAbort);
      turn.abortBeforeStart();
      if (abortRequested || signalIsAborted(options.signal)) {
        return failure(
          "CONVERSATION_RUNTIME_START_CANCELLED",
          "Conversation runtime start was cancelled",
          true,
        );
      }
      return failure(
        "CONVERSATION_RUNTIME_TRANSPORT_ERROR",
        safeErrorMessage(error, "Conversation runtime start failed"),
        true,
      );
    }
    if (abortRequested || signalIsAborted(options.signal)) {
      await turn.cancel(cancellationReasonFromSignal(options.signal));
      options.signal?.removeEventListener("abort", recordAbort);
      return failure(
        "CONVERSATION_RUNTIME_START_CANCELLED",
        "Conversation runtime start was cancelled",
        true,
      );
    }
    options.signal?.removeEventListener("abort", recordAbort);
    return { ok: true, value: turn };
  }

  public async checkHealth(): Promise<ConversationRuntimeHealth> {
    if (this.callFactory.checkHealth === undefined) {
      throw new Error("Conversation runtime health transport is unavailable");
    }
    return parseGrpcConversationRuntimeHealth(await this.callFactory.checkHealth(this.metadata));
  }

  public close(): void {
    this.callFactory.close();
  }

  private parseStartRequest(
    request: ConversationStartRequest,
  ): PortResult<ReturnType<typeof parseConversationRuntimeStartTurn>> {
    try {
      return {
        ok: true,
        value: parseConversationRuntimeStartTurn({
          protocolVersion: conversationRuntimeProtocolVersion,
          ...request,
        }),
      };
    } catch (error) {
      return failure(
        "CONVERSATION_RUNTIME_INVALID_INPUT",
        safeErrorMessage(error, "Conversation request is invalid"),
        false,
      );
    }
  }
}

function parseCancellationTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Pipecat runtime cancellation timeout must be a positive integer");
  }
  return value;
}

function cancellationReasonFromSignal(
  signal: AbortSignal | undefined,
): ConversationCancellationReason {
  const reason: unknown = signal?.reason;
  switch (reason) {
    case "barge-in":
    case "meeting-ended":
    case "playback-failed":
    case "runtime-shutdown":
    case "superseded":
      return reason;
    default:
      return "runtime-shutdown";
  }
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
