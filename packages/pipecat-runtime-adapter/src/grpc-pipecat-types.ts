import type { Metadata } from "@grpc/grpc-js";

export type RawMessage = Record<string, unknown>;
type RawListener = (value: RawMessage) => void;
type ErrorListener = (error: Error) => void;
type VoidListener = () => void;

export interface ConversationDuplexCall {
  cancel(): void;
  end(): void;
  pause(): this;
  resume(): this;
  on(event: "data", listener: RawListener): this;
  on(event: "end", listener: VoidListener): this;
  on(event: "error", listener: ErrorListener): this;
  write(message: RawMessage, callback: (error?: Error | null) => void): boolean;
}

export interface ConversationDuplexCallFactory {
  checkHealth?(metadata: Metadata): Promise<RawMessage>;
  create(metadata: Metadata): ConversationDuplexCall;
  close(): void;
}

export interface GrpcPipecatConversationRuntimeOptions {
  readonly address: string;
  readonly cancellationTimeoutMs?: number;
  readonly serviceToken: string;
  readonly callFactory?: ConversationDuplexCallFactory;
  readonly protoPath?: string;
}
