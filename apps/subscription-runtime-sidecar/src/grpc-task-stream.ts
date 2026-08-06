import { timingSafeEqual } from "node:crypto";

import {
  status,
  type handleServerStreamingCall,
  type Metadata,
} from "@grpc/grpc-js";

import {
  reconstructCanonicalRequest,
  type RequestPolicyOptions,
} from "./policy.js";
import type {
  SidecarStreamingExecutorPort,
} from "./types.js";

type RawMessage = Record<string, unknown>;
type StreamingHandler = handleServerStreamingCall<RawMessage, RawMessage>;

const protocolVersion = 1;
const maximumDeltaBytes = 16 * 1_024;
const maximumDeltaEvents = 256;

interface StreamingHandlerOptions extends RequestPolicyOptions {
  readonly serviceToken: string;
}

export function createGrpcTaskStreamHandler(input: {
  readonly options: StreamingHandlerOptions;
  readonly streamingExecutor?: SidecarStreamingExecutorPort;
  readonly toGrpcTaskResponse: (
    result: Awaited<
      ReturnType<SidecarStreamingExecutorPort["executeStreaming"]>
    >,
  ) => RawMessage;
}): StreamingHandler {
  return (call): void => {
    if (!isAuthorized(call.metadata, input.options.serviceToken)) {
      call.destroy(grpcError(status.UNAUTHENTICATED, "Unauthorized"));
      return;
    }
    if (input.streamingExecutor === undefined) {
      call.destroy(
        grpcError(status.UNIMPLEMENTED, "Streaming runtime is unavailable"),
      );
      return;
    }
    let request;
    try {
      request = reconstructCanonicalRequest(
        streamTaskRequest(call.request),
        input.options,
      );
    } catch {
      call.destroy(
        grpcError(
          status.INVALID_ARGUMENT,
          "Agent task request violates sidecar policy",
        ),
      );
      return;
    }
    const cancellation = new AbortController();
    const abort = (): void => {
      cancellation.abort();
    };
    call.once("cancelled", abort);
    const writer = new BoundedGrpcTaskStreamWriter(call);
    void executeGrpcTaskStream({
      abort,
      call,
      cancellation,
      executor: input.streamingExecutor,
      request,
      toGrpcTaskResponse: input.toGrpcTaskResponse,
      writer,
    });
  };
}

function streamTaskRequest(request: RawMessage): RawMessage {
  const task = request.task;
  if (typeof task !== "object" || task === null || Array.isArray(task)) {
    throw new Error("Streaming task request is missing its task payload");
  }
  return task as RawMessage;
}

async function executeGrpcTaskStream(input: {
  readonly abort: () => void;
  readonly call: Parameters<StreamingHandler>[0];
  readonly cancellation: AbortController;
  readonly executor: SidecarStreamingExecutorPort;
  readonly request: Parameters<SidecarStreamingExecutorPort["executeStreaming"]>[0];
  readonly toGrpcTaskResponse: (
    result: Awaited<ReturnType<SidecarStreamingExecutorPort["executeStreaming"]>>,
  ) => RawMessage;
  readonly writer: BoundedGrpcTaskStreamWriter;
}): Promise<void> {
  try {
    const result = await input.executor.executeStreaming(
      input.request,
      input.writer,
      input.cancellation.signal,
    );
    if (!input.cancellation.signal.aborted) {
      input.writer.complete(input.toGrpcTaskResponse(result));
    }
  } catch {
    if (!input.cancellation.signal.aborted) {
      input.call.destroy(
        grpcError(status.UNAVAILABLE, "Subscription runtime is unavailable"),
      );
    }
  } finally {
    input.call.removeListener("cancelled", input.abort);
  }
}

class BoundedGrpcTaskStreamWriter {
  private sequence = 0;
  private deltaBytes = 0;
  private deltaEvents = 0;
  private started = false;
  private terminal = false;

  public constructor(
    private readonly call: Parameters<StreamingHandler>[0],
  ) {}

  public onProviderTaskStarted = (): void => {
    if (this.started || this.terminal) {
      throw new Error("Provider task start event is out of order");
    }
    this.started = true;
    this.write({ started: {} });
  };

  public onProviderTextDelta = (text: string): void => {
    if (!this.started || this.terminal || text.length === 0) {
      throw new Error("Provider text delta is out of order");
    }
    this.deltaEvents += 1;
    this.deltaBytes += Buffer.byteLength(text, "utf8");
    if (
      this.deltaEvents > maximumDeltaEvents ||
      this.deltaBytes > maximumDeltaBytes
    ) {
      throw new Error("Provider text delta stream exceeded its bounded contract");
    }
    this.write({ textDelta: { text } });
  };

  public complete(response: RawMessage): void {
    if (this.terminal) {
      throw new Error("Provider task stream already completed");
    }
    this.terminal = true;
    this.write({ completed: response });
    this.call.end();
  }

  private write(event: RawMessage): void {
    this.sequence += 1;
    this.call.write({
      schemaVersion: protocolVersion,
      sequence: String(this.sequence),
      ...event,
    });
  }
}

function isAuthorized(metadata: Metadata, serviceToken: string): boolean {
  const values = metadata.get("authorization");
  if (values.length !== 1 || typeof values[0] !== "string") {
    return false;
  }
  const supplied = Buffer.from(values[0], "utf8");
  const expected = Buffer.from(`Bearer ${serviceToken}`, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function grpcError(code: status, message: string): Error & { readonly code: status } {
  return Object.assign(new Error(message), { code });
}
