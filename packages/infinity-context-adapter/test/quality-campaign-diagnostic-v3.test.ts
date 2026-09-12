import { afterEach, expect, it, vi } from "vitest";
import { retrievalCapabilityFingerprint, type HttpTransport } from "@infinity-context/sdk";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeDiagnosticManifest, decodeDiagnosticManifestV2, decodeVersionedDiagnosticManifest } from "../src/quality-campaign/diagnostic-manifest.js";
import { awaitDiagnosticIndexReadiness, awaitDiagnosticIndexReadinessV3 } from "../src/quality-campaign/diagnostic-index-readiness.js";
import { runDiagnosticCli } from "../src/quality-campaign/diagnostic-run.js";
import { sha256 } from "../src/quality-campaign/canonical.js";
const questions = Array.from({ length: 40 }, (_, i) => ({ locale: "en", questionId: `q${i}`,
  questionText: "What was decided?", scopeTopologyReference: "diagnostic:scope" }));
function manifestFixture(artifactRoot: string) {
  const roster = {humans:["human"], automation:["bot"]};
  return {
    schemaVersion:"meeting_knowledge.real40_diagnostic.v1",
    authorityKind:"owner_authorized_nonqualifying_diagnostic",
    runId:"diagnostic:test", sourceRevision:"a".repeat(40), sdkVersion:"0.2.4",
    model:"gpt-5.6-terra", reasoningEffort:"low", serviceTier:"default",
    frozen:{meetingId:"test-meeting", snapshotSha256:"a".repeat(64),
      transcriptSha256:"b".repeat(64), transcriptVersion:2, roster,
      scopeId:"diagnostic:scope", roomId:"diagnostic:room", releaseId:"diagnostic-release"},
    rosterSha256:sha256(roster),
    providerBinding:{capabilityFingerprint:"a".repeat(64), indexProfileDigest:"b".repeat(64),
      contractVersion:"context-retrieval.v2", profileId: "locator-v2-full-"+"b".repeat(64),
      rankingPolicy:"weighted_rrf_canonical_preferences.v1",
      requiredProviderLanes:["postgres_keyword","qdrant_dense"], serviceRevision:"test-revision"},
    questions,
    connections:{artifactRoot, artifactKeyPath:"/missing-test-key",
      topologyKeyPath:"/missing-test-topology", postgresUrlPath:"/missing-test-pg",
      infinityTokenPath:"/missing-test-infinity", runtimeTokenPath:"/missing-test-runtime",
      infinityBaseUrl:"http://127.0.0.1:1", runtimeAddress:"127.0.0.1:1",
      expectedRuntimeLauncherSha256:"c".repeat(64)},
  };
}

function v2() {
  const { sdkVersion: _, ...old } = manifestFixture("/tmp/synthetic-artifacts");
  return { ...old, schemaVersion: "meeting_knowledge.real40_diagnostic.v2",
    sdkIdentity: { packageName: "@infinity-context/sdk", version: "0.3.0-synthetic",
      sourceRevision: "a".repeat(40), tarballSha256: "b".repeat(64), manifestSha256: "c".repeat(64) },
    threadSelector: { mode: "any" }, providerBinding: { ...old.providerBinding, serviceRevision: "a".repeat(40), contractVersion: "context-retrieval.v3" } };
}
it("retains V1 bytes and closed dispatch while explicitly parsing V2", () => {
  const old = manifestFixture("/tmp/synthetic-artifacts");
  const { roster, ...frozen } = old.frozen;
  expect(JSON.stringify(decodeDiagnosticManifest(old))).toBe(JSON.stringify({ ...old, frozen: { ...frozen, roster } }));
  expect(decodeVersionedDiagnosticManifest(old)).toEqual(old);
  expect(() => decodeDiagnosticManifest(v2())).toThrow();
  const parsed = decodeDiagnosticManifestV2(v2());
  expect(parsed.threadSelector).toEqual({ mode: "any" });
  expect(parsed.frozen).toEqual(decodeDiagnosticManifest(old).frozen);
  expect(Object.isFrozen(parsed.sdkIdentity)).toBe(true);
  expect(decodeVersionedDiagnosticManifest(v2())).toEqual(parsed);
});
it.each([
  { threadSelector: { mode: "exact", id: null } }, { threadSelector: { mode: "any", id: null } },
  { sdkIdentity: null }, { sdkVersion: "0.2.4" }, { model: "other" }, { questions: [] },
  { schemaVersion: "future" }, { gold: [] },
])("rejects incompatible V2 fields %j", change => {
  expect(() => decodeDiagnosticManifestV2({ ...v2(), ...change })).toThrow();
});
it("authenticates the installed SDK before reserving the V2 report", async () => {
  const root = await mkdtemp(join(tmpdir(), "diagnostic-v3-sdk-preflight-"));
  try {
    const manifestPath = join(root, "manifest.json"), reportPath = join(root, "report.json");
    await writeFile(manifestPath, JSON.stringify({ ...v2(), connections: {
      ...v2().connections, artifactRoot: join(root, "artifacts") } }));
    await expect(runDiagnosticCli(["diagnostic", manifestPath, reportPath])).resolves.toBe(1);
    await expect(access(reportPath)).rejects.toThrow();
  } finally { await rm(root, { force: true, recursive: true }); }
});
async function setup() {
  const value = {
  "endpoint": "/v1/context/retrieve",
  "contract_version": "context-retrieval.v2",
  "ranking_policy": "weighted_rrf_canonical_preferences.v1",
  "ranking_parameters": {
    "rank_constant": 60,
    "weight_scale_micros": 1000000,
    "score_scale_picos": 1000000000000,
    "preference_scale_micros": 1000000,
    "max_preference_boost_micros": 250000,
    "contribution_rounding": "round_half_even",
    "preference_rounding": "floor",
    "canonical_signal_match_policy": "canonical_exact_key_interval_overlap.v1"
  },
  "capability_fingerprint": "522cf13b82d20b8cf8f37b6e9fb3f4dc5752e24c9802c35b0f2fc30482083fae",
  "profile_id": "locator-v2-pairs-relative-22222222",
  "service_revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "sdk_revision": "cccccccccccccccccccccccccccccccccccccccc",
  "attribute_schema": "document-retrieval-projection.v1",
  "index_profile_digest": "2222222222222222222222222222222222222222222222222222222222222222",
  "coverage": "top_k_only",
  "supports_neighbors": true,
  "bounds": {
    "query_variants": [1, 6],
    "query_characters": [1, 512],
    "provider_lanes": [1, 4],
    "provider_rank": [1, 1000],
    "source_generations": [1, 100],
    "candidate_limit": [1, 1000],
    "result_limit": [1, 50],
    "neighbor_radius": [0, 2],
    "response_byte_limit": [16384, 1048576],
    "deadline_ms": [1, 2000],
    "weight_micros": [100000, 10000000]
  },
  "hard_filter_signals": [
    "actor_keys",
    "category",
    "document_keys",
    "excluded_source_keys",
    "kinds",
    "relative_time_interval",
    "source_generations",
    "tags_all",
    "tags_any",
    "tags_none",
    "time_interval"
  ],
  "soft_preference_signals": [
    "actor_preferences",
    "relative_time_interval",
    "source_preferences",
    "time_interval"
  ],
  "required_provider_lanes": [
    "postgres_keyword",
    "qdrant_dense"
  ],
  "provider_lanes": [
    {
      "provider_id": "postgres_keyword",
      "required": true,
      "healthy": true,
      "weight_micros": 1000000,
      "profile_qualified": true
    },
    {
      "provider_id": "qdrant_dense",
      "required": true,
      "healthy": true,
      "weight_micros": 1000000,
      "profile_qualified": true
    }
  ]
};
  value.contract_version = "context-retrieval.v3"; value.endpoint = "/v1/context/retrieve-v3";
  value.profile_id = `locator-v2-full-${value.index_profile_digest}`;
  value.capability_fingerprint = await retrievalCapabilityFingerprint(value);
  const binding = { contractVersion: "context-retrieval.v3" as const, capabilityFingerprint: value.capability_fingerprint,
    indexProfileDigest: value.index_profile_digest, profileId: value.profile_id, rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
    requiredProviderLanes: value.required_provider_lanes, serviceRevision: value.service_revision };
  const retain = vi.fn(async () => undefined);
  const send = vi.fn<HttpTransport["send"]>();
  const input = { baseUrl: "http://synthetic.invalid", token: "synthetic", binding, custody: { retain }, transport: { send } };
  return { value, send, retain, input };
}
function response(value: unknown) { return { status: 200, headers: new Headers({ "content-type": "application/json" }), body: JSON.stringify(value) }; }
afterEach(() => vi.restoreAllMocks());
it("uses the bare public V3 route and refreshes readiness without any reservations", async () => {
  const { value, send, retain, input } = await setup(); send.mockResolvedValue(response(value));
  await expect(awaitDiagnosticIndexReadinessV3(input)).resolves.toMatchObject({ status: "ready", probes: 1 });
  await awaitDiagnosticIndexReadinessV3(input);
  expect(send).toHaveBeenCalledTimes(2); expect(retain).toHaveBeenCalledTimes(2);
  for (const [request] of send.mock.calls) { expect(request.method).toBe("GET");
    expect(request.url.pathname).toBe("/v1/context/retrieve-v3/capability"); expect(request.body).toBeUndefined(); }
});
it.each(["envelope", "revision", "index", "fingerprint", "profile", "lanes", "malformed", "duplicate"])(
  "fails closed without retry on %s", async kind => {
    const { value, send, input } = await setup();
    const changed = { ...value };
    if (kind === "revision") changed.service_revision = "f".repeat(40);
    if (kind === "index") changed.index_profile_digest = "f".repeat(64);
    if (kind === "fingerprint") changed.capability_fingerprint = "f".repeat(64);
    if (kind === "profile") changed.profile_id = "foreign";
    if (kind === "lanes") changed.required_provider_lanes = ["postgres_keyword"];
    if (kind === "malformed") Object.assign(changed, { supports_neighbors: "unknown" });
    send.mockResolvedValue(kind === "duplicate" ? { ...response(value), body: '{"endpoint":"/v1/context/retrieve-v3",' + JSON.stringify(value).slice(1) }
      : response(kind === "envelope" ? { context: { retrieval: value } } : changed));
    await expect(awaitDiagnosticIndexReadinessV3(input)).rejects.toMatchObject({ preparation: { status: "blocked", probes: 1 } });
    expect(send).toHaveBeenCalledTimes(1);
  });
it.each(["postgres_keyword", "qdrant_dense"])("waits only for explicit temporary %s health", async laneId => {
  const { value, send, input, retain } = await setup();
  const unhealthy = { ...value, provider_lanes: value.provider_lanes.map((lane: { provider_id: string; healthy: boolean }) => lane.provider_id === laneId ? { ...lane, healthy: false } : lane) };
  unhealthy.capability_fingerprint = await retrievalCapabilityFingerprint(unhealthy);
  send.mockResolvedValueOnce(response(unhealthy)).mockImplementationOnce(async () => {
    expect(retain).not.toHaveBeenCalled(); return response(value);
  });
  await expect(awaitDiagnosticIndexReadinessV3(input)).resolves.toMatchObject({ status: "ready", probes: 2 });
});
it("rejects success arriving at the total deadline", async () => {
  const { value, send, input } = await setup(); let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  send.mockImplementation(async () => { now = 600_000; return response(value); });
  await expect(awaitDiagnosticIndexReadinessV3(input)).rejects.toMatchObject({ preparation: {
    status: "blocked", reason: "diagnostic_index_readiness_timeout", probes: 1 } });
});
it("bounds a hung call to two seconds without retry", async () => {
  const { send, input } = await setup();
  send.mockImplementation(request => new Promise((_resolve, reject) => {
    request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
  }));
  await expect(awaitDiagnosticIndexReadinessV3(input)).rejects.toMatchObject({ preparation: {
    status: "blocked", probes: 1, lastProbeCode: "request_timeout" } });
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(["foreign", "malformed", "duplicate", "unknown-health"])("never retries unhealthy %s", async kind => {
  const { value, send, input } = await setup();
  const changed = { ...value, provider_lanes: value.provider_lanes.map(lane => ({ ...lane, healthy: false })) };
  if (kind === "foreign") changed.service_revision = "f".repeat(40);
  if (kind === "malformed") Object.assign(changed, { extra: true });
  if (kind === "unknown-health") Object.assign(changed.provider_lanes[0]!, { healthy: "unknown" });
  changed.capability_fingerprint = await retrievalCapabilityFingerprint(changed);
  send.mockResolvedValue(kind === "duplicate" ? { ...response(changed),
    body: '{"endpoint":"/v1/context/retrieve-v3",' + JSON.stringify(changed).slice(1) } : response(changed));
  await expect(awaitDiagnosticIndexReadinessV3(input)).rejects.toMatchObject({ preparation: { probes: 1, status: "blocked" } });
  expect(send).toHaveBeenCalledTimes(1);
});

it("keeps the V1 envelope route and preparation bytes", async () => {
  const { value, send, input } = await setup();
  const old = { ...value, contract_version: "context-retrieval.v2", endpoint: "/v1/context/retrieve" };
  old.capability_fingerprint = await retrievalCapabilityFingerprint(old);
  send.mockResolvedValue(response({ context: { retrieval: old } }));
  vi.spyOn(performance, "now").mockReturnValue(0);
  const result = await awaitDiagnosticIndexReadiness({ ...input,
    custody: input.custody as unknown as Parameters<typeof awaitDiagnosticIndexReadiness>[0]["custody"],
    binding: { ...input.binding, contractVersion: "context-retrieval.v2", capabilityFingerprint: old.capability_fingerprint } });
  expect(JSON.stringify(result)).toBe('{"status":"ready","reason":null,"elapsedMs":0,"probes":1,"lastProbeCode":"ready"}');
  expect(send.mock.calls[0]![0].url.pathname).toBe("/v1/capabilities");
});
it("stops at the total barrier after a bounded temporary-health backoff", async () => {
  const { value, send, input, retain } = await setup();
  const unhealthy = { ...value, provider_lanes: value.provider_lanes.map(lane => ({ ...lane, healthy: false })) };
  unhealthy.capability_fingerprint = await retrievalCapabilityFingerprint(unhealthy);
  let now = 0; vi.spyOn(performance, "now").mockImplementation(() => now);
  const timer = globalThis.setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
    if (delay === 1_000) { expect(retain).not.toHaveBeenCalled(); now = 600_000; return timer(callback, 0); }
    return timer(callback, delay);
  }) as typeof setTimeout);
  send.mockResolvedValue(response(unhealthy));
  await expect(awaitDiagnosticIndexReadinessV3(input)).rejects.toMatchObject({ preparation: {
    status: "blocked", reason: "diagnostic_index_readiness_timeout", elapsedMs: 600_000, probes: 1 } });
  expect(send).toHaveBeenCalledTimes(1);
});
