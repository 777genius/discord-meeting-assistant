import { fileURLToPath } from "node:url";

import {
  QuestionBinding,
  createFocusedRetrievalGroundingPlan,
  focusedMemoryGeneration,
  type GroundedAnswerGenerationRequest,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
  type MethodDefinition,
  type ServiceDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { afterEach, describe, expect, it } from "vitest";
import * as subscriptionRuntimeExports from "@discord-meeting/subscription-runtime-adapter";

import {
  GrpcSubscriptionRuntimeTransport,
  assertGrpcQualifiedGroundedAnswerAdapter,
  createGrpcQualifiedGroundedAnswerAdapter,
} from "../src/adapters/outbound/subscription-runtime-grpc-transport.js";

const servers: Server[] = [];
const transports: GrpcSubscriptionRuntimeTransport[] = [];

afterEach(async () => {
  for (const transport of transports.splice(0)) {transport.close();}
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve) => {server.tryShutdown(() => {resolve();});});
  }));
});

describe("qualified subscription runtime gRPC wire observation", () => {
  it("captures the protobuf bytes at the serializer and deserializer boundaries", async () => {
    const rawResponse = { schemaVersion: 1,
      status: "AGENT_RUNTIME_TASK_STATUS_WAITING_FOR_INPUT" };
    const fixture = await grpcFixture((_call, callback) => {callback(null, rawResponse);});
    const reservations: string[] = [];
    const answer = createGrpcQualifiedGroundedAnswerAdapter({
      beforeProviderCall: async (identity) => {reservations.push(identity.callOrdinal);},
      options: { expectedLauncherSha256: "a".repeat(64) }, transport: fixture.transport,
    });
    const request = generationRequest("sqv4-" + "1".repeat(64));

    expect(() => Object.assign(answer as object, { transport: { execute: async () => {
      throw new Error("post-construction fake must not execute");
    } }, wireObservation: { execute: async () => {
      throw new Error("post-construction fake observation must not execute");
    } } })).toThrow(TypeError);

    await answer.generate(request);
    const observation = answer.takeQualificationObservation(request.attemptId);
    const grpcRequest = fixture.calls[0];
    const expectedRequest = fixture.method.requestSerialize(grpcRequest);
    const expectedResponse = fixture.method.responseSerialize(rawResponse);

    expect(reservations).toEqual(["original"]);
    expect(observation.exchanges.repair).toBeNull();
    expect(Buffer.from(observation.exchanges.original.requestBytes)).toEqual(expectedRequest);
    expect(Buffer.from(observation.exchanges.original.responseBytes)).toEqual(expectedResponse);
    expect(observation.exchanges.original.requestBytes).not.toEqual(
      Buffer.from(JSON.stringify(grpcRequest)),
    );
    expect(observation.exchanges.original.responseBytes).not.toEqual(
      Buffer.from(JSON.stringify(rawResponse)),
    );
  });

  it("binds original and repair calls to one attempt and reserves before both sends", async () => {
    const events: string[] = [];
    let call = 0;
    const fixture = await grpcFixture((_request, callback) => {
      events.push(`send:${call === 0 ? "original" : "repair"}`);
      callback(null, call++ === 0 ? {
        failure: { code: "provider_output_invalid", reconnectRequired: false,
          retryable: false, safeMessage: "invalid" },
        schemaVersion: 1, status: "AGENT_RUNTIME_TASK_STATUS_FAILED",
      } : { schemaVersion: 1, status: "AGENT_RUNTIME_TASK_STATUS_WAITING_FOR_INPUT" });
    });
    const answer = createGrpcQualifiedGroundedAnswerAdapter({
      beforeProviderCall: async (identity) => {events.push(`reserve:${identity.callOrdinal}`);},
      options: { expectedLauncherSha256: "a".repeat(64) }, transport: fixture.transport,
    });
    const request = generationRequest("sqv4-" + "2".repeat(64));

    await answer.generate(request);
    const observation = answer.takeQualificationObservation(request.attemptId);

    expect(events).toEqual([
      "reserve:original", "send:original", "reserve:repair", "send:repair",
    ]);
    expect(observation.exchanges.original.identity).toMatchObject({
      attemptId: request.attemptId, callOrdinal: "original",
      purpose: "discord_meeting.knowledge.answer.v1",
    });
    expect(observation.exchanges.repair?.identity).toMatchObject({
      attemptId: request.attemptId, callOrdinal: "repair",
    });
    expect(observation.exchanges.repair?.identity.runId).not.toBe(
      observation.exchanges.original.identity.runId,
    );
    expect(() => answer.takeQualificationObservation(request.attemptId)).toThrow(/absent/u);

    await answer.generate(request);
    expect(fixture.calls).toHaveLength(2);
    expect(answer.takeQualificationObservation(request.attemptId)).toMatchObject({
      outcomeCertain: false, providerBytesSent: false,
    });
  });

  it("does not let constructor clones or compatible transports mint provenance", async () => {
    const fixture = await grpcFixture((_call, callback) => {callback(null, {
      schemaVersion: 1, status: "AGENT_RUNTIME_TASK_STATUS_WAITING_FOR_INPUT",
    });});
    const compatibleFake = { checkHealth: async () => ({ status: "serving" }), close() {},
      execute: async () => ({ protocolVersion: 1, status: "waiting_for_input" }) };
    const prototypeClone = Object.create(GrpcSubscriptionRuntimeTransport.prototype) as
      GrpcSubscriptionRuntimeTransport;

    expect(() => {createGrpcQualifiedGroundedAnswerAdapter({ beforeProviderCall: async () => {},
      options: { expectedLauncherSha256: "a".repeat(64) },
      transport: compatibleFake as never });}).toThrow(/repository gRPC transport/u);
    expect(() => {createGrpcQualifiedGroundedAnswerAdapter({ beforeProviderCall: async () => {},
      options: { expectedLauncherSha256: "a".repeat(64) }, transport: prototypeClone });})
      .toThrow(/repository gRPC transport/u);
    expect(() => {assertGrpcQualifiedGroundedAnswerAdapter(compatibleFake);})
      .toThrow(/transport-issued/u);
    expect(() => {assertGrpcQualifiedGroundedAnswerAdapter(fixture.transport);})
      .toThrow(/transport-issued/u);
    expect("registerProductionKnowledgeAnswerTransport" in subscriptionRuntimeExports).toBe(false);
  });
});

async function grpcFixture(handler: (request: unknown,
  callback: (error: Error | null, response?: unknown) => void) => void) {
  const definition = loadSync(fileURLToPath(new URL("../proto/agent_runtime.proto",
    import.meta.url)), { defaults: true, enums: String, keepCase: false, longs: String,
    oneofs: true });
  const root = loadPackageDefinition(definition) as Record<string, unknown>;
  const service = (((root.social_monitor as Record<string, unknown>).agent_runtime as
    Record<string, unknown>).v1 as Record<string, unknown>).AgentRuntimeService as {
      service: ServiceDefinition };
  const calls: unknown[] = [];
  const server = new Server();
  server.addService(service.service, { runAgentTask: (call: { request: unknown }, callback:
    (error: Error | null, response?: unknown) => void) => {
    calls.push(call.request);
    handler(call.request, callback);
  } });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, value) => {
      if (error === null) {resolve(value);} else {reject(error);}
    });
  });
  servers.push(server);
  const transport = new GrpcSubscriptionRuntimeTransport({ address: `127.0.0.1:${port}`,
    serviceToken: "test-service-token" });
  transports.push(transport);
  return { calls, method: service.service.RunAgentTask as MethodDefinition<unknown, unknown>,
    transport };
}

function generationRequest(attemptId: string): GroundedAnswerGenerationRequest {
  const canonicalEvidenceHash = "c".repeat(64);
  return { attemptId,
    binding: QuestionBinding.create({ authorizationDigest: "b".repeat(64),
      authorizationPolicyVersion: "discord.participant-current-results.v1",
      authorizationPrincipalRef: "opaque-principal", botApplicationIdentity: "11111111111111111",
      canonicalEvidenceHash, deliveryContainerId: "22222222222222222", expectedLocale: "en",
      finalProjectionEpoch: "final-epoch-1", finalProjectionReceipt:
        "discord:v2:channel:22222222222222222:message:33333333333333333",
      humanActorIds: ["77777777777777777"], meetingId: "meeting-1", meetingRevision: 4,
      memoryGeneration: focusedMemoryGeneration(canonicalEvidenceHash),
      policyVersion: "discord.participant-current-results.v1",
      projectionTargetContainerId: "22222222222222222", questionHash: "d".repeat(64),
      questionId: "44444444444444444", requesterSubject: "e".repeat(64),
      roomId: "55555555555555555", scopeId: "66666666666666666",
      transcriptId: "transcript-1", transcriptVersion: 1 }).toSnapshot(),
    locale: "en", plan: createFocusedRetrievalGroundingPlan({
      authorityGeneration: focusedMemoryGeneration(canonicalEvidenceHash), coverage: "sufficient",
      humanActorIds: ["77777777777777777"], turns: [{ endMs: 2_000,
        speakerId: "77777777777777777", startMs: 0, text: "The release is Monday.",
        turnHash: "1".repeat(64), turnId: "turn-1" }] }),
    question: "When is the release?" };
}
