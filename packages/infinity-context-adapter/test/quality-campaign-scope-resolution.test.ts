import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { HttpTransport, JsonValue } from "@infinity-context/sdk";
import { buildHistoricalIndexPlan, PrepareFocusedLocatorRetrievalV2Request } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresHistoricalEvidenceAuthority, PostgresHistoricalMemoryStore } from
  "@discord-meeting/postgres-adapter";
import { createGrpcQualifiedGroundedAnswerAdapter, GrpcSubscriptionRuntimeTransport } from
  "@discord-meeting/subscription-runtime-adapter";
import { HmacHistoricalOpaqueIds } from "../src/hmac-historical-ids.js";
import { InfinityContextRetrievalV2Adapter } from "../src/infinity-context-retrieval-v2.js";
import { InfinityRetrievalScopeResolution } from "../src/infinity-retrieval-scope-resolution.js";
import { createProductionCanonicalQuestionChain } from
  "../src/quality-campaign/production-canonical-question-chain.js";
import { canonicalJson } from "../src/quality-campaign/canonical.js";
import { finalMeeting } from "./historical-e2e-test-kit.js";
import { DisposableInfinityEndpoint, DISPOSABLE_RETRIEVAL_V2_BINDING } from "./test-support.js";

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") { return true; }
  if (typeof value === "number") { return Number.isFinite(value); }
  if (Array.isArray(value)) { return value.every((item: unknown) => isJsonValue(item)); }
  return typeof value === "object" && Object.values(value).every((item: unknown) => isJsonValue(item));
}

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

describe("canonical scope preparation before retrieval identity", () => {
  it.each([true, false])("resolves=%s with real preparer and SDK, without database or model calls", async (found) => {
    const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(7));
    const meeting = finalMeeting(1, "Tuesday");
    const plan = buildHistoricalIndexPlan(meeting, ids);
    const endpoint = new DisposableInfinityEndpoint();
    const events: string[] = [];
    const transport: HttpTransport = { send: async (request) => {
      events.push(`send:${request.url.pathname}`);
      if (request.url.pathname === "/v1/spaces" || request.url.pathname === "/v1/memory-scopes") {
        expect(request.method).toBe("GET");
        const isSpace = request.url.pathname === "/v1/spaces";
        if (!isSpace) { expect(request.url.searchParams.get("space_id")).toBe("internal-space"); }
        const row = isSpace ? { id: "internal-space", slug: plan.topology.spaceSlug } :
          { id: "internal-room", space_id: "internal-space", external_ref: plan.topology.roomScopeExternalRef };
        return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: JSON.stringify({ data: found ? [{ ...row, name: "Synthetic", status: "active", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] : [] }) };
      }
      const result = await endpoint.send(request);
      if (request.url.pathname !== "/v1/context/retrieve") { return result; }
      // SDK 0.2.4 represents healthy lanes with zero candidates as unqualified.
      const response: unknown = JSON.parse(typeof result.body === "string"
        ? result.body : new TextDecoder().decode(result.body));
      if (typeof response !== "object" || response === null || Array.isArray(response)) {
        throw new Error("Expected a retrieval response object");
      }
      return { ...result, body: JSON.stringify({ ...response, status: "unqualified" }) };
    } };
    let retrievalWireBytes = "";
    const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (request.method !== "GET" && request.method !== "POST") {
        response.writeHead(405).end(); return;
      }
      const chunks: Buffer[] = [];
      const incoming: AsyncIterable<unknown> = request;
      for await (const chunk of incoming) {
        if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
          throw new Error("Invalid HTTP request chunk");
        }
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.url === "/v1/context/retrieve") { retrievalWireBytes = body; }
      const value: unknown = body.length === 0 ? null : JSON.parse(body);
      if (!isJsonValue(value)) { throw new Error("Invalid JSON request body"); }
      const result = await transport.send({ method: request.method,
        url: new URL(request.url ?? "/", "http://127.0.0.1"),
        headers: new Headers(), ...(body.length === 0 ? {} : { body: { kind: "json", value } }) });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(result.body);
    };
    const server = createServer((request, response) => {
      void handleRequest(request, response).catch(() => { response.writeHead(500).end(); });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") { throw new Error("No test HTTP address"); }
    const config = { baseUrl: `http://127.0.0.1:${address.port}/v1`, operationTimeoutMs: 500,
      requestTimeoutMs: 500 };
    const preparer = new PrepareFocusedLocatorRetrievalV2Request({ ids,
      providerBinding: DISPOSABLE_RETRIEVAL_V2_BINDING,
      scopeResolution: new InfinityRetrievalScopeResolution(config),
      snapshot: { loadRoomAuthoritySnapshot: async () => ({ schemaVersion: 1, status: "current",
        entries: [{ acceptedMeeting: meeting, binding: meeting.binding, plan, remoteDocumentIds: {} }] }) } });
    const pool = new Pool();
    const query = vi.spyOn(pool, "query");
    const grpc = new GrpcSubscriptionRuntimeTransport({ address: "127.0.0.1:1", serviceToken: "synthetic-only-token" });
    const model = vi.fn(async () => { throw new Error("model calls forbidden"); });
    const answer = createGrpcQualifiedGroundedAnswerAdapter({ transport: grpc,
      options: { expectedLauncherSha256: "5".repeat(64) }, beforeProviderCall: model });
    const artifacts = new Map<string, unknown>();
    const artifactBytes = new Map<string, string>();
    const reservations: { effectKind: string; payloadSha256: string }[] = [];
    const journal = vi.fn(async () => { events.push("journal:retrieval"); });
    const chain = createProductionCanonicalQuestionChain({ answer, ids, preparer,
      retrieval: new InfinityContextRetrievalV2Adapter({ ...config, operationTimeoutMs: 4000, requestTimeoutMs: 2000 }),
      evidenceAuthority: new PostgresHistoricalEvidenceAuthority(pool), store: new PostgresHistoricalMemoryStore(pool),
      topology: { resolve: async () => ({ currentMeetingId: "current", roomId: meeting.binding.roomId,
        scopeId: meeting.binding.scopeId }) },
      spend: { reserve: async (effect) => { events.push(`reserve:${effect.effectKind}`); reservations.push(effect); } },
      journal: { reserve: journal, terminal: async () => {} },
      audit: { seal: async ({ kind, plaintext }) => { artifactBytes.set(kind, new TextDecoder().decode(plaintext));
        artifacts.set(kind, JSON.parse(new TextDecoder().decode(plaintext))); } },
    });
    try {
      const result = await chain.retrieval.retrieve({ questionId: "synthetic-q", questionText: "When is launch?",
        locale: "en", source: "automatic", scopeTopologyReference: "synthetic-topology" },
      { attemptId: `sqv4-${"a".repeat(64)}`, signal: new AbortController().signal });
      expect(query).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
      if (!found) {
        expect(result.status).toBe("failed");
        expect(events).toEqual(["reserve:scope_spaces", "send:/v1/spaces"]);
        expect(journal).not.toHaveBeenCalled();
        expect(endpoint.requests).toHaveLength(0);
        return;
      }
      expect(events.slice(0, 4)).toEqual(["reserve:scope_spaces", "send:/v1/spaces",
        "reserve:scope_memory_scopes", "send:/v1/memory-scopes"]);
      expect(events.indexOf("journal:retrieval")).toBeGreaterThan(3);
      expect(result, JSON.stringify(result)).toEqual({ status: "failed", reason: "provider_unqualified" });
      const wire = artifacts.get("retrieval_request") as { scope: unknown };
      expect(wire.scope).toEqual({ space_id: "internal-space", memory_scope_id: "internal-room", thread_id: null });
      expect(retrievalWireBytes.length).toBeGreaterThan(0);
      expect(artifactBytes.get("retrieval_request")).toBe(retrievalWireBytes);
      const prepared = await preparer.prepare({ currentMeetingId: "current", question: "When is launch?",
        scopeId: meeting.binding.scopeId, roomId: meeting.binding.roomId });
      expect(prepared.status).toBe("prepared");
      expect(reservations.find(({ effectKind }) => effectKind === "retrieval")?.payloadSha256)
        .toBe(digest({ effectKind: "retrieval", request: prepared }));
      expect(artifacts.get("scope_resolution_observation")).toMatchObject({ status: "prepared",
        reads: [{ kind: "scope_spaces", status: "received" }, { kind: "scope_memory_scopes", status: "received" }] });
    } finally {
      grpc.close(); await pool.end();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) { reject(error); } else { resolve(); } });
        server.closeAllConnections();
      });
    }
  });
});
