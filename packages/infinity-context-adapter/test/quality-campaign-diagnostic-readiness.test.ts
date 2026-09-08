import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FetchTransport, type HttpRequest } from "@infinity-context/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { retrievalV2CapabilityFingerprint } from "../src/infinity-context-retrieval-v2.js";
import { runDiagnostic, runDiagnosticCli } from "../src/quality-campaign/diagnostic-run.js";
import { decodeDiagnosticManifest } from "../src/quality-campaign/diagnostic-manifest.js";
import { sha256 } from "../src/quality-campaign/canonical.js";

const state = vi.hoisted(() => ({ indexCalls: 0, questions: 0, modelCalls: 0, now: 0,
  firstQuestionAt: -1 }));
vi.mock("pg", () => ({ Pool: class { async end() {} } }));
vi.mock("@discord-meeting/postgres-adapter", async importOriginal => ({
  ...await importOriginal<typeof import("@discord-meeting/postgres-adapter")>(),
  PostgresDiagnosticFinalEvidence: class { async loadFrozenProjection() {return {};} },
  assertConstructedPostgresDiagnosticFinalEvidence: () => {},
}));
vi.mock("@discord-meeting/meeting-core/meeting-knowledge", async importOriginal => ({
  ...await importOriginal<typeof import("@discord-meeting/meeting-core/meeting-knowledge")>(),
  buildHistoricalIndexPlan: () => ({ binding: { scopeId: "diagnostic:scope" }, documents: [] }),
}));
vi.mock("../src/pinned-multilingual-minilm-tokenizer.js", () => ({
  PinnedMultilingualMiniLmTokenizer: class { readonly synthetic = true; },
}));
vi.mock("../src/infinity-context-historical-memory.js", () => ({
  InfinityContextHistoricalMemoryAdapter: class {
    async indexFinalMeeting() {
      state.indexCalls += 1;
      return { status: "applied", remoteDocumentIds: {} };
    }
  },
}));
vi.mock("@discord-meeting/subscription-runtime-adapter", async importOriginal => ({
  ...await importOriginal<typeof import("@discord-meeting/subscription-runtime-adapter")>(),
  GrpcSubscriptionRuntimeTransport: class { close() {} },
  createGrpcQualifiedGroundedAnswerAdapter: () => ({}),
}));
vi.mock("../src/quality-campaign/production-canonical-question-chain.js", () => ({
  createDiagnosticCanonicalQuestionChain: (input: { spend: { reserve: (value: unknown) => Promise<void> } }) => ({
    retrieval: { retrieve: async () => {
      if (state.firstQuestionAt < 0) {state.firstQuestionAt = state.now;}
      state.questions += 1;
      await input.spend.reserve({ effectKind: "retrieval" });
      state.now += 10;
      return { status: "completed", candidates: [] };
    } },
    evidence: { rehydrate: async () => {state.now += 20; return { turns: [] };} },
    answer: { generate: async () => {
      state.modelCalls += 1; state.now += 30;
      return { status: "abstained", claims: [], citations: [] };
    } },
  }),
}));
const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(require.resolve(
  "@infinity-context/sdk/fixtures/context_retrieval_v2/capability.json"), "utf8"));
const healthy = { ...fixture, profile_id: `locator-v2-full-${fixture.index_profile_digest}` };
healthy.capability_fingerprint = retrievalV2CapabilityFingerprint(healthy);
function unready(overrides: Record<string, unknown> = {}) {
  const value = { ...healthy, provider_lanes: healthy.provider_lanes.map(
    (lane: Record<string, unknown>) => lane.provider_id === "qdrant_dense"
      ? { ...lane, healthy: false, profile_qualified: false } : lane), ...overrides };
  return { ...value, capability_fingerprint: retrievalV2CapabilityFingerprint(value) };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-readiness-test-"));
  const secret = join(root, "synthetic-secret");
  await writeFile(secret, Buffer.alloc(32, 1).toString("base64"));
  const roster = { humans: ["human"], automation: ["bot"] };
  const manifest = decodeDiagnosticManifest({
    schemaVersion: "meeting_knowledge.real40_diagnostic.v1",
    authorityKind: "owner_authorized_nonqualifying_diagnostic", runId: "diagnostic:test",
    sourceRevision: "a".repeat(40), sdkVersion: "0.2.4",
    model: "gpt-5.6-terra", reasoningEffort: "low", serviceTier: "default",
    frozen: { meetingId: "test-meeting", snapshotSha256: "a".repeat(64),
      transcriptSha256: "b".repeat(64), transcriptVersion: 2, roster,
      scopeId: "diagnostic:scope", roomId: "diagnostic:room", releaseId: "diagnostic-release" },
    rosterSha256: sha256(roster),
    providerBinding: { capabilityFingerprint: healthy.capability_fingerprint,
      indexProfileDigest: healthy.index_profile_digest, contractVersion: healthy.contract_version,
      profileId: healthy.profile_id, rankingPolicy: healthy.ranking_policy,
      requiredProviderLanes: healthy.required_provider_lanes, serviceRevision: healthy.service_revision },
    questions: Array.from({ length: 40 }, (_, i) => ({ locale: "en", questionId: `q${i}`,
      questionText: "What was decided?", scopeTopologyReference: "diagnostic:scope" })),
    connections: { artifactRoot: join(root, "artifacts"), artifactKeyPath: secret,
      topologyKeyPath: secret, postgresUrlPath: secret, infinityTokenPath: secret,
      runtimeTokenPath: secret, infinityBaseUrl: "http://synthetic.invalid",
      runtimeAddress: "synthetic.invalid:1", expectedRuntimeLauncherSha256: "c".repeat(64) },
  });
  state.indexCalls = 0; state.questions = 0; state.modelCalls = 0;
  state.now = 0; state.firstQuestionAt = -1;
  vi.spyOn(performance, "now").mockImplementation(() => state.now);
  vi.spyOn(Date, "now").mockImplementation(() => state.now);
  return { root, manifest };
}
function endpoint(reply: () => unknown) {
  return vi.spyOn(FetchTransport.prototype, "send").mockImplementation(async (request: HttpRequest) => {
    expect(request.method).toBe("GET");
    expect(request.url.pathname).toBe("/v1/capabilities");
    expect(request.signal).toBeDefined();
    return { status: 200, headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ context: { retrieval: reply() } }) };
  });
}
afterEach(() => {vi.restoreAllMocks();});
describe("installed diagnostic preparation barrier", () => {
  it("waits for queued projection before all 40 effects; preparation stays outside question latency", async () => {
    const { root, manifest } = await setup();
    try {
      let probes = 0;
      endpoint(() => {
        expect(state.indexCalls).toBe(1);
        expect(state.questions).toBe(0);
        expect(state.modelCalls).toBe(0);
        state.now += 150;
        return ++probes === 1 ? unready() : healthy;
      });
      const report = await runDiagnostic(manifest);
      expect(probes).toBe(2);
      expect(report.indexPreparation).toMatchObject({ status: "ready", probes: 2, elapsedMs: 300 });
      expect(state.firstQuestionAt).toBe(300);
      expect(state.modelCalls).toBe(40);
      expect(report.questionDenominator).toBe(40);
      expect(report.questions.every(q => q.latencyMs.retrieval === 10 &&
        q.latencyMs.endToEnd === 60)).toBe(true);
      expect(state.indexCalls).toBe(1);
    } finally {await rm(root, { recursive: true, force: true });}
  });
  it.each(["timeout", "foreign", "malformed", "unready-malformed", "request-failure"] as const)(
    "blocks %s before any question reservation and resumes the retained index without reingest", async failure => {
      const { root, manifest } = await setup();
      try {
        const send = endpoint(() => {
          if (failure === "timeout") {state.now += 600_000; return unready();}
          if (failure === "foreign") {return unready({ service_revision: "b".repeat(40) });}
          if (failure === "unready-malformed") {return unready({ supports_neighbors: "invalid" });}
          if (failure === "request-failure") {throw new Error("private-secret-do-not-retain");}
          return { ...healthy, provider_lanes: "private-invalid-payload" };
        });
        const manifestPath = join(root, "manifest.json");
        await writeFile(manifestPath, JSON.stringify(manifest));
        const lines: string[] = [];
        expect(await runDiagnosticCli(["diagnostic-run", manifestPath, join(root, "blocked.json")],
          line => lines.push(line))).toBe(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect(lines.join("")).not.toContain("private-");
        expect(JSON.parse(lines[0]!).reason).toBe(failure === "timeout" ?
          "diagnostic_index_readiness_timeout" : "diagnostic_index_readiness_failed");
        expect(state.questions).toBe(0); expect(state.modelCalls).toBe(0);
        const before = await readdir(manifest.connections.artifactRoot);
        expect(before).toContain("applied-index.receipt.json");
        expect(before.filter(name => name.startsWith("question-"))).toHaveLength(0);
        expect(before.filter(name => name.startsWith("index-preparation-"))).toHaveLength(1);
        send.mockRestore();
        const resumed = endpoint(() => healthy);
        const report = await runDiagnostic(manifest);
        expect(state.indexCalls).toBe(1);
        expect(resumed).toHaveBeenCalledTimes(1);
        expect(report.questions).toHaveLength(40);
        expect(state.modelCalls).toBe(40);
        // A retained success does not authorize a new invocation without a fresh probe.
        resumed.mockRestore();
        const drift = endpoint(() => unready({ index_profile_digest: "d".repeat(64) }));
        await expect(runDiagnostic(manifest)).rejects.toThrow("diagnostic_index_readiness_failed");
        expect(drift).toHaveBeenCalledTimes(1);
        expect(state.indexCalls).toBe(1); expect(state.modelCalls).toBe(40);
        expect(await readFile(join(root, "blocked.json"), "utf8")).toBe("");
      } finally {await rm(root, { recursive: true, force: true });}
    });
  it("bounds a hung capability request and preserves timeout evidence without retry", async () => {
    const { root, manifest } = await setup();
    try {
      const send = vi.spyOn(FetchTransport.prototype, "send").mockImplementation(request =>
        new Promise((_resolve, reject) => {request.signal?.addEventListener("abort",
          () => reject(request.signal?.reason), { once: true });}));
      await expect(runDiagnostic(manifest)).rejects.toMatchObject({
        preparation: { status: "blocked", probes: 1, lastProbeCode: "request_timeout" } });
      expect(send).toHaveBeenCalledTimes(1);
      expect(state.questions).toBe(0); expect(state.modelCalls).toBe(0);
    } finally {await rm(root, { recursive: true, force: true });}
  });
  it.each(["capability_fingerprint", "profile_id", "required_provider_lanes"] as const)(
    "rejects healthy substituted %s without retries", async key => {
      const { root, manifest } = await setup();
      try {
        const replacement = key === "required_provider_lanes" ? ["postgres_keyword"] :
          key === "profile_id" ? "foreign-profile" : "f".repeat(64);
        const send = endpoint(() => ({ ...healthy, [key]: replacement }));
        await expect(runDiagnostic(manifest)).rejects.toThrow("diagnostic_index_readiness_failed");
        expect(send).toHaveBeenCalledTimes(1);
        expect(state.questions).toBe(0); expect(state.modelCalls).toBe(0);
      } finally {await rm(root, { recursive: true, force: true });}
    });
});
