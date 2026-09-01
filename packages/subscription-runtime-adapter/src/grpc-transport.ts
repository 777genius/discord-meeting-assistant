import { fileURLToPath } from "node:url";

import {
  Client,
  credentials,
  loadPackageDefinition,
  Metadata,
  type CallOptions,
  type ClientUnaryCall,
  type ServiceClientConstructor,
  type ServiceError,
  type MethodDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { SubscriptionRuntimeGroundedAnswerAdapter,
  type KnowledgeAnswerProviderExchangeIdentity,
  type KnowledgeAnswerWireObservationPort,
  type SubscriptionRuntimeGroundedAnswerAdapterOptions } from
  "./subscription-runtime-grounded-answer-adapter.js";
import {
  type SubscriptionRuntimeAgentTaskRequest,
  type SubscriptionRuntimeHealthResult,
  type SubscriptionRuntimeTaskResult,
  type SubscriptionRuntimeTransportPort,
  type KnowledgeAnswerQualificationExecutionBinding,
} from "./subscription-runtime-contract.js";
import { recordValue } from "./grpc-value-readers.js";
import { fromGrpcHealthResponse, fromGrpcTaskResponse, toGrpcTaskRequest } from
  "./subscription-runtime-grpc-mapping.js";
export { fromGrpcTaskResponse, toGrpcTaskRequest } from
  "./subscription-runtime-grpc-mapping.js";

type UnaryMethod = (
  request: unknown,
  metadata: Metadata,
  options: CallOptions,
  callback: (error: ServiceError | null, response?: unknown) => void,
) => ClientUnaryCall;

interface AgentRuntimeClient extends Client {
  readonly checkHealth: UnaryMethod;
  readonly runAgentTask: UnaryMethod;
}

interface GrpcTransportOptions {
  readonly address: string;
  readonly serviceToken: string;
}

export class GrpcSubscriptionRuntimeTransport
  implements SubscriptionRuntimeTransportPort
{
  readonly #client: AgentRuntimeClient;
  readonly #metadata: Metadata;
  readonly #runAgentTaskDefinition: MethodDefinition<unknown, unknown>;
  readonly #qualificationExchangeIdentities = new Set<string>();

  public constructor(options: GrpcTransportOptions) {
    if (options.serviceToken.trim().length < 16) {
      throw new Error("Subscription runtime service token is too short");
    }
    const definition = loadSync(
      fileURLToPath(new URL("../proto/agent_runtime.proto", import.meta.url)),
      {
        defaults: true,
        enums: String,
        keepCase: false,
        longs: String,
        oneofs: true,
      },
    );
    const root = loadPackageDefinition(definition) as Record<string, unknown>;
    const service = readNestedService(root);
    this.#runAgentTaskDefinition = readRunAgentTaskDefinition(service);
    this.#client = new service(
      options.address,
      credentials.createInsecure(),
    ) as unknown as AgentRuntimeClient;
    this.#metadata = new Metadata();
    this.#metadata.set("authorization", `Bearer ${options.serviceToken}`);
    productionGrpcTransports.add(this);
    Object.freeze(this);
  }

  public async execute(
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SubscriptionRuntimeTaskResult> {
    const response = await callUnary(
      this.#client.runAgentTask.bind(this.#client),
      toGrpcTaskRequest(request),
      this.#metadata,
      request.timeoutMs,
      options.signal,
    );
    return fromGrpcTaskResponse(response);
  }

  public async checkHealth(): Promise<SubscriptionRuntimeHealthResult> {
    return fromGrpcHealthResponse(await callUnary(
        this.#client.checkHealth.bind(this.#client),
        { service: "discord-meeting-summary" },
        this.#metadata,
        5_000,
      ));
  }

  public close(): void {
    this.#qualificationExchangeIdentities.clear();
    this.#client.close();
  }

  public claimQualificationExchange(identity: KnowledgeAnswerProviderExchangeIdentity): void {
    const key = exchangeIdentityKey(identity);
    if (this.#qualificationExchangeIdentities.has(key)) {
      throw new Error("knowledge answer gRPC exchange is duplicated or replayed");
    }
    this.#qualificationExchangeIdentities.add(key);
  }

  public async executeQualificationCall(
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal },
    capture: MutableWireCapture,
  ): Promise<SubscriptionRuntimeTaskResult> {
    const definition = this.#runAgentTaskDefinition;
    const response = await callUnary(
      (value, metadata, callOptions, callback) => this.#client.makeUnaryRequest(
        definition.path,
        (input) => captureRequestBytes(capture, definition.requestSerialize(input)),
        (bytes) => definition.responseDeserialize(captureResponseBytes(capture, bytes)),
        value,
        metadata,
        callOptions,
        callback,
      ),
      toGrpcTaskRequest(request),
      this.#metadata,
      request.timeoutMs,
      options.signal,
    );
    return fromGrpcTaskResponse(response);
  }
}

interface MutableWireCapture {
  requestBytes: Uint8Array | null;
  responseBytes: Uint8Array | null;
}

const productionGrpcTransports = new WeakSet<GrpcSubscriptionRuntimeTransport>();
const qualifiedAnswerAdapters = new WeakSet<SubscriptionRuntimeGroundedAnswerAdapter>();

export function createGrpcQualifiedGroundedAnswerAdapter(input: {
  readonly beforeProviderCall: (identity: KnowledgeAnswerProviderExchangeIdentity) => Promise<void>;
  readonly options: SubscriptionRuntimeGroundedAnswerAdapterOptions;
  readonly executionBinding?: KnowledgeAnswerQualificationExecutionBinding;
  readonly transport: GrpcSubscriptionRuntimeTransport;
}): SubscriptionRuntimeGroundedAnswerAdapter {
  if (!productionGrpcTransports.has(input.transport)) {
    throw new Error("knowledge answer qualification requires the repository gRPC transport");
  }
  const observation = new GrpcKnowledgeAnswerWireObservation(input.transport,
    input.beforeProviderCall);
  const answer = new SubscriptionRuntimeGroundedAnswerAdapter(input.transport, input.options,
    observation, input.executionBinding);
  qualifiedAnswerAdapters.add(answer);
  return answer;
}

export function assertGrpcQualifiedGroundedAnswerAdapter(value: unknown): void {
  if (typeof value !== "object" || value === null ||
    !qualifiedAnswerAdapters.has(value as SubscriptionRuntimeGroundedAnswerAdapter)) {
    throw new Error("knowledge answer qualification requires a transport-issued gRPC adapter");
  }
}

class GrpcKnowledgeAnswerWireObservation implements KnowledgeAnswerWireObservationPort {
  private readonly attempts = new Map<string, {
    original: KnowledgeAnswerProviderExchangeIdentity | null;
    repair: KnowledgeAnswerProviderExchangeIdentity | null;
  }>();
  private readonly captures = new Map<string, MutableWireCapture>();

  public constructor(
    private readonly transport: GrpcSubscriptionRuntimeTransport,
    private readonly beforeProviderCall: (identity: KnowledgeAnswerProviderExchangeIdentity) =>
      Promise<void>,
  ) {}

  public async execute(
    identity: KnowledgeAnswerProviderExchangeIdentity,
    request: SubscriptionRuntimeAgentTaskRequest,
    options: { readonly signal?: AbortSignal },
  ): Promise<SubscriptionRuntimeTaskResult> {
    assertExchangeIdentityMatchesRequest(identity, request);
    this.transport.claimQualificationExchange(identity);
    const key = exchangeIdentityKey(identity);
    if (this.captures.has(key)) {
      throw new Error("knowledge answer gRPC exchange is duplicated or replayed");
    }
    const attempt = this.attempts.get(identity.attemptId);
    if (identity.callOrdinal === "original") {
      if (attempt !== undefined) {
        throw new Error("knowledge answer original gRPC exchange is duplicated or stale");
      }
      this.attempts.set(identity.attemptId, { original: identity, repair: null });
    } else {
      if (attempt === undefined || attempt.original === null || attempt.repair !== null ||
        attempt.original.purpose !== identity.purpose ||
        JSON.stringify(attempt.original.runtimeProfile) !== JSON.stringify(identity.runtimeProfile) ||
        attempt.original.runId === identity.runId) {
        throw new Error("knowledge answer repair gRPC exchange is swapped or unbound");
      }
      attempt.repair = identity;
    }
    const capture: MutableWireCapture = { requestBytes: null, responseBytes: null };
    this.captures.set(key, capture);
    await this.beforeProviderCall(identity);
    return await this.transport.executeQualificationCall(request, options, capture);
  }

  public take(identity: KnowledgeAnswerProviderExchangeIdentity): MutableWireCapture {
    const key = exchangeIdentityKey(identity);
    const capture = this.captures.get(key);
    this.captures.delete(key);
    if (capture === undefined) {
      throw new Error("knowledge answer gRPC exchange is missing, stale, or substituted");
    }
    const result = { requestBytes: capture.requestBytes === null ? null :
      Uint8Array.from(capture.requestBytes), responseBytes: capture.responseBytes === null ? null :
      Uint8Array.from(capture.responseBytes) };
    capture.requestBytes?.fill(0);
    capture.responseBytes?.fill(0);
    return result;
  }

  public finish(attemptId: string): void {
    this.attempts.delete(attemptId);
    for (const [key, capture] of this.captures) {
      if (key.startsWith(`${attemptId}\u0000`)) {
        capture.requestBytes?.fill(0);
        capture.responseBytes?.fill(0);
        this.captures.delete(key);
      }
    }
  }
}

function readNestedService(root: Record<string, unknown>): ServiceClientConstructor {
  const socialMonitor = recordValue(root.social_monitor, "social_monitor package");
  const agentRuntime = recordValue(socialMonitor.agent_runtime, "agent_runtime package");
  const version = recordValue(agentRuntime.v1, "agent runtime v1 package");
  if (typeof version.AgentRuntimeService !== "function") {
    throw new Error("Agent runtime gRPC service definition is unavailable");
  }
  return version.AgentRuntimeService as ServiceClientConstructor;
}

function readRunAgentTaskDefinition(
  service: ServiceClientConstructor,
): MethodDefinition<unknown, unknown> {
  const definition = service.service.RunAgentTask;
  if (definition === undefined || definition.requestStream || definition.responseStream) {
    throw new Error("Agent runtime unary task definition is unavailable");
  }
  return definition as MethodDefinition<unknown, unknown>;
}

function captureRequestBytes(capture: MutableWireCapture, bytes: Buffer): Buffer {
  if (capture.requestBytes !== null) {
    throw new Error("Agent runtime request was serialized more than once");
  }
  capture.requestBytes = Uint8Array.from(bytes);
  return bytes;
}

function captureResponseBytes(capture: MutableWireCapture, bytes: Buffer): Buffer {
  if (capture.responseBytes !== null) {
    throw new Error("Agent runtime response was deserialized more than once");
  }
  capture.responseBytes = Uint8Array.from(bytes);
  return bytes;
}

function exchangeIdentityKey(identity: KnowledgeAnswerProviderExchangeIdentity): string {
  return `${identity.attemptId}\u0000${identity.callOrdinal}\u0000${identity.runId}`;
}

function assertExchangeIdentityMatchesRequest(
  identity: KnowledgeAnswerProviderExchangeIdentity,
  request: SubscriptionRuntimeAgentTaskRequest,
): void {
  const profile = identity.runtimeProfile;
  if (!/^sqv4-[a-f0-9]{64}$/u.test(identity.attemptId) ||
    identity.purpose !== request.context.purpose || identity.runId !== request.runId ||
    profile.maxOutputTokens !== request.task.controls.maxOutputTokens ||
    profile.model !== request.task.controls.model ||
    profile.outputSchemaName !== request.task.controls.outputSchemaName ||
    profile.policyVersion !== request.task.metadata.policyVersion ||
    profile.reasoningEffort !== request.task.controls.reasoningEffort) {
    throw new Error("knowledge answer gRPC exchange identity does not match the runtime request");
  }
}

async function callUnary(
  method: UnaryMethod,
  request: unknown,
  metadata: Metadata,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    let settled = false;
    let call: ClientUnaryCall | undefined;
    const finish = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      outcome();
    };
    const abort = (): void => {
      call?.cancel();
      finish(() => {
        reject(signal?.reason ?? new Error("Subscription runtime task cancelled"));
      });
    };
    call = method(request, metadata, { deadline: Date.now() + timeoutMs }, (error, response) => {
      if (error !== null) {
        finish(() => {
          reject(new Error("Subscription runtime transport failed", { cause: error }));
        });
      } else {
        finish(() => {
          resolve(response);
        });
      }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) {
      abort();
    }
  });
}
