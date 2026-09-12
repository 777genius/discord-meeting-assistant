import { InfinityRetrievalScopeResolution } from "../src/infinity-retrieval-scope-resolution.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildHistoricalIndexPlan, canonicalHistoricalPlannerJson, createHistoricalReleaseBinding,
  historicalEmbeddingTokenProfile, PrepareFocusedLocatorRetrievalV2Request } from "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresDiagnosticFinalEvidence } from "@discord-meeting/postgres-adapter";
import { createGrpcQualifiedGroundedAnswerAdapter, GrpcSubscriptionRuntimeTransport } from "@discord-meeting/subscription-runtime-adapter";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
import { HmacHistoricalOpaqueIds, InfinityContextHistoricalMemoryAdapter, PinnedMultilingualMiniLmTokenizer } from "../src/index.js";
import { InfinityContextRetrievalV2Adapter } from "../src/infinity-context-retrieval-v2.js";
import { DiagnosticFrozenStore } from "../src/quality-campaign/diagnostic-frozen-store.js";
import { createDiagnosticCanonicalQuestionChain, createProductionCanonicalQuestionChain } from "../src/quality-campaign/production-canonical-question-chain.js";
import { DISPOSABLE_RETRIEVAL_V2_BINDING, startDisposableInfinityHttpService } from "./test-support.js";
import { testHistoricalActorKeys } from "./historical-e2e-test-kit.js";

const digest = (value: unknown) => createHash("sha256").update(canonicalHistoricalPlannerJson(value)).digest("hex");
const exec = promisify(execFile);
const container = `test-diagnostic-${randomUUID()}`;
let pool: Pool | undefined;
beforeAll(async () => {
  await exec("docker", ["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=synthetic", "-e", "POSTGRES_DB=meeting_test", "-p", "127.0.0.1::5432", "postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15"]);
  const { stdout } = await exec("docker", ["port", container, "5432/tcp"]);
  const port = Number(stdout.trim().split(":").at(-1));
  pool = new Pool({ host: "127.0.0.1", port, user: "postgres", password: "synthetic", database: "meeting_test" });
  for (let attempt = 0; ; attempt += 1) {
    try { await pool.query("SELECT 1"); break; }
    catch (error) { if (attempt >= 100) { throw error; } await setTimeout(100); }
  }
  await pool.query("CREATE SCHEMA meeting_core; CREATE TABLE meeting_core.meetings (meeting_id text PRIMARY KEY, revision bigint NOT NULL, snapshot jsonb NOT NULL)");
}, 30_000);
afterAll(async () => { await pool?.end(); await exec("docker", ["rm", "-f", container]); }, 30_000);
describe("nonqualifying diagnostic concrete boundaries", () => {
  it("indexes and retrieves through official SDK HTTP, then rehydrates only frozen PostgreSQL text", async () => {
    const database = pool;
    if (database === undefined) { throw new Error("disposable PostgreSQL did not initialize"); }
    const http = await startDisposableInfinityHttpService();
    const transport = new GrpcSubscriptionRuntimeTransport({ address: "127.0.0.1:1", serviceToken: "synthetic-token-1234" });
    try {
      const snapshot = { meetingId: "synthetic-diagnostic", revision: 7, transcriptionStage: { status: "succeeded" },
        transcript: { transcriptId: "synthetic-final", recordingId: "synthetic-recording", version: 1,
          turns: [{ turnId: "human-1", speakerId: "human-maya", startMs: 0, endMs: 1000,
            text: "Project Cedar launch is Tuesday; Maya owns the release." },
          { turnId: "bot-1", speakerId: "automation", startMs: 1000, endMs: 2000,
            text: "AUTOMATION TEXT MUST NEVER BECOME HUMAN EVIDENCE" }] } };
      await database.query("INSERT INTO meeting_core.meetings (meeting_id, revision, snapshot) VALUES ($1, $2, $3::jsonb)",
        [snapshot.meetingId, snapshot.revision, JSON.stringify(snapshot)]);
      const release = createHistoricalReleaseBinding({ acceptedMeetingRevision: 7, desiredGeneration: 1,
        meetingId: snapshot.meetingId, transcriptId: snapshot.transcript.transcriptId, transcriptVersion: 1,
        scopeId: "diagnostic:scope", roomId: "diagnostic:room" });
      const authority = new PostgresDiagnosticFinalEvidence(database, { meetingId: snapshot.meetingId,
        snapshotSha256: digest(snapshot), transcriptSha256: digest(snapshot.transcript), transcriptVersion: 1,
        roster: { humans: ["human-maya"], automation: ["automation"] }, scopeId: release.scopeId,
        roomId: release.roomId, releaseId: release.releaseId });
      const ids = new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(7));
      const tokenizer = new PinnedMultilingualMiniLmTokenizer();
      const plan = buildHistoricalIndexPlan(await authority.loadFrozenProjection(), ids, undefined, tokenizer);
      const indexer = new InfinityContextHistoricalMemoryAdapter({ baseUrl: http.baseUrl, actorKeys: testHistoricalActorKeys,
        embeddingTokenProfile: () => historicalEmbeddingTokenProfile(tokenizer), requestTimeoutMs: 5000, schemaVersion: 1 });
      const applied = await indexer.indexFinalMeeting(plan);
      expect(applied.status).toBe("applied");
      if (applied.status !== "applied") { throw new Error("synthetic index failed"); }
      const store = new DiagnosticFrozenStore(authority, plan, applied.remoteDocumentIds);
      const retrieval = new InfinityContextRetrievalV2Adapter({ baseUrl: http.baseUrl, operationTimeoutMs: 4000, requestTimeoutMs: 1000 });
      let answerCalls = 0;
      const answer = createGrpcQualifiedGroundedAnswerAdapter({ transport, options: { expectedLauncherSha256: "5".repeat(64) },
        beforeProviderCall: async () => { answerCalls += 1; throw new Error("model calls forbidden in this test"); } });
      const auditKinds: string[] = [];
      const input = { answer, evidenceAuthority: authority, ids, store, retrieval,
        preparer: new PrepareFocusedLocatorRetrievalV2Request({ scopeResolution: new InfinityRetrievalScopeResolution({
          baseUrl: http.baseUrl, token: "synthetic-token", operationTimeoutMs: 500, requestTimeoutMs: 500 }), ids, providerBinding: DISPOSABLE_RETRIEVAL_V2_BINDING, snapshot: store }),
        audit: { seal: async (value: { kind: string }) => { auditKinds.push(value.kind); } },
        journal: { reserve: async () => {}, terminal: async () => {} }, spend: { reserve: async () => {} },
        topology: { resolve: async () => ({ currentMeetingId: snapshot.meetingId, roomId: release.roomId, scopeId: release.scopeId }) } };
      expect(() => createProductionCanonicalQuestionChain(input as unknown as Parameters<typeof createProductionCanonicalQuestionChain>[0]))
        .toThrow("historical evidence authority");
      const chain = createDiagnosticCanonicalQuestionChain(input);
      const packet = { questionId: "synthetic-q1", questionText: "When is Project Cedar launch?", locale: "en" as const,
        scopeTopologyReference: "diagnostic:scope" };
      const options = { attemptId: `sqv4-${"a".repeat(64)}`, signal: new AbortController().signal };
      const beforeRetrieval = http.endpoint.requests.length;
      const result = await chain.retrieval.retrieve(packet, options);
      const retrievalRequests = http.endpoint.requests.slice(beforeRetrieval);
      expect(retrievalRequests.filter(({ path }) => path === "/v1/spaces" || path === "/v1/memory-scopes"))
        .toEqual([expect.objectContaining({ method: "GET", path: "/v1/spaces", query: "?limit=100" }),
          expect.objectContaining({ method: "GET", path: "/v1/memory-scopes", query: "?space_id=space-1&limit=100" })]);
      const contextRequests = retrievalRequests.filter(({ path }) => path === "/v1/context/retrieve");
      expect(contextRequests).toHaveLength(1);
      expect(contextRequests[0]?.method).toBe("POST");
      const requestBody = contextRequests[0]?.body;
      if (typeof requestBody !== "object" || requestBody === null || !("scope" in requestBody)) {
        throw new Error("Expected a retrieval request object");
      }
      expect(requestBody.scope).toEqual({ space_id: "space-1", memory_scope_id: "scope-1", thread_id: null });
      expect(plan.topology.spaceSlug).not.toBe("space-1");
      expect(plan.topology.roomScopeExternalRef).not.toBe("scope-1");
      if (result.status !== "completed") { throw new Error(`synthetic retrieval failed: ${result.reason}`); }
      expect(result.candidates.length).toBeGreaterThan(0);
      const locators = result.candidates.map(candidate => candidate.locatorId);
      const evidence = await chain.evidence.rehydrate({ locatorIds: locators, questionId: packet.questionId, scopeTopologyReference: packet.scopeTopologyReference }, options);
      expect(JSON.stringify(evidence)).toContain(snapshot.transcript.turns[0]!.text);
      expect(JSON.stringify(evidence)).not.toContain(snapshot.transcript.turns[1]!.text);
      expect(http.endpoint.requests.some(request => request.path === "/v1/documents")).toBe(true);
      expect(http.endpoint.requests.some(request => request.path === "/v1/context/retrieve")).toBe(true);
      expect(auditKinds).toContain("selected_canonical_turns");
      expect(answerCalls).toBe(0);
      await expect(store.findCurrentCandidates(release.scopeId, release.roomId, ["foreign-locator"])).rejects.toThrow();
      const staleOptions = { ...options, attemptId: `sqv4-${"b".repeat(64)}` };
      expect((await chain.retrieval.retrieve(packet, staleOptions)).status).toBe("completed");
      await database.query("UPDATE meeting_core.meetings SET snapshot = jsonb_set(snapshot, '{transcript,version}', '2') WHERE meeting_id = $1", [snapshot.meetingId]);
      await expect(chain.evidence.rehydrate({ locatorIds: locators, questionId: packet.questionId, scopeTopologyReference: packet.scopeTopologyReference }, staleOptions)).rejects.toThrow("changed");
    } finally { transport.close(); await http.close(); }
  }, 60_000);
});
