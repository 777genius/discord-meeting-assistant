import {
  conversationRuntimeProtocolVersion,
  parseConversationRuntimeStartTurn,
  type ConversationRuntimeHealth,
} from "@discord-meeting/conversation-runtime-contracts";
import type {
  ConversationRuntime,
  ConversationRuntimeTurn,
  ConversationStartOptions,
  ConversationStartRequest,
  PortResult,
} from "@discord-meeting/meeting-core";

import { parseGrpcConversationRuntimeHealth } from "./grpc-pipecat-protocol.js";
import { GrpcConversationRuntimeTurn } from "./grpc-pipecat-runtime-turn.js";
import {
  failure,
  isAbortRequested,
  rejectWhenAborted,
  safeErrorMessage,
} from "./grpc-pipecat-runtime-support.js";
import {
  createAuthorizationMetadata,
  createGrpcConversationDuplexCallFactory,
} from "./grpc-pipecat-transport.js";
import type {
  ConversationDuplexCall,
  ConversationDuplexCallFactory,
  GrpcPipecatConversationRuntimeOptions,
} from "./grpc-pipecat-types.js";

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
  private readonly metadata: ReturnType<typeof createAuthorizationMetadata>;

  public constructor(options: GrpcPipecatConversationRuntimeOptions) {
    if (options.serviceToken.trim().length < 16) {
      throw new Error("Pipecat runtime service token is too short");
    }
    this.callFactory = options.callFactory ?? createGrpcConversationDuplexCallFactory(options);
    this.metadata = createAuthorizationMetadata(options.serviceToken);
  }

  public async startTurn(
    request: ConversationStartRequest,
    options: ConversationStartOptions = {},
  ): Promise<PortResult<ConversationRuntimeTurn>> {
    if (options.signal?.aborted === true) {
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

    const turn = new GrpcConversationRuntimeTurn(call, transportRequest.value.turnId);
    try {
      await rejectWhenAborted(turn.start(transportRequest.value), options.signal);
    } catch (error) {
      turn.abortBeforeStart();
      if (isAbortRequested(options.signal)) {
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
