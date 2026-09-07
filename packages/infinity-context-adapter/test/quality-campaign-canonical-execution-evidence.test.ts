import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrepareFocusedLocatorRetrievalV2Request } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresHistoricalEvidenceAuthority, PostgresHistoricalMemoryStore } from
  "@discord-meeting/postgres-adapter";
import { createGrpcQualifiedGroundedAnswerAdapter, GrpcSubscriptionRuntimeTransport } from
  "@discord-meeting/subscription-runtime-adapter";
import type { HttpRequest, HttpResponse, HttpTransport, JsonValue } from "@infinity-context/sdk";
import { describe, expect, it } from "vitest";

import { HmacHistoricalOpaqueIds } from "../src/hmac-historical-ids.js";
import { InfinityContextRetrievalV2Adapter, type InfinityContextRetrievalV2Request } from
  "../src/infinity-context-retrieval-v2.js";
import { validateCanonicalRetrievalObservation } from
  "../src/quality-campaign/canonical-execution-artifact-validation.js";
import { SemanticQualityV4EncryptedArtifactStore } from
  "../src/quality-campaign/canonical-execution-evidence-store.js";
import { createProductionCanonicalExecutionEvidence, recoverProductionCanonicalOutcome } from
  "../src/quality-campaign/production-canonical-execution-evidence.js";
import { createProductionCanonicalQuestionChain } from
  "../src/quality-campaign/production-canonical-question-chain.js";
import { ExecuteAdmittedQualificationQuestion } from
  "../src/quality-campaign/execute-admitted-qualification-question.js";

const attemptId = `sqv4-${"1".repeat(64)}`;
const rootBindingSha256 = "2".repeat(64);
const require = createRequire(import.meta.url);
const capability = JSON.parse(readFileSync(require.resolve(
  "@infinity-context/sdk/fixtures/context_retrieval_v2/capability.json"), "utf8")) as
  Record<string, unknown>;
const successfulResponse = JSON.parse(readFileSync(require.resolve(
  "@infinity-context/sdk/fixtures/context_retrieval_v2/success.json"), "utf8")) as
  Record<string, unknown>;

describe("canonical execution evidence durability", () => {
  it("fsyncs a create-only reservation before a provider phase can continue", async () => {
    const fixture = await evidenceFixture();
    await fixture.evidence.journal.reserve({ attemptId, payloadSha256: "3".repeat(64),
      phase: "retrieval" });
    const reservation = JSON.parse(await readFile(join(fixture.retrievalJournalRoot,
      attemptId, "provider_reserved.json"), "utf8")) as Record<string, unknown>;
    expect(reservation).toMatchObject({ attemptId, phase: "retrieval",
      state: "provider_reserved" });
    await fixture.evidence.journal.terminal({ attemptId, payloadSha256: "4".repeat(64),
      phase: "retrieval", state: "succeeded" });
    await expect(readFile(join(fixture.retrievalJournalRoot, attemptId, "terminal.json"),
      "utf8")).resolves.toContain('"state":"succeeded"');
  });

  it("treats a crash-surviving reservation as terminal unknown and never fresh-retries", async () => {
    const fixture = await evidenceFixture();
    await fixture.evidence.journal.reserve({ attemptId, payloadSha256: "3".repeat(64),
      phase: "answer" });
    const reopened = createProductionCanonicalExecutionEvidence(fixture.input);
    await expect(reopened.journal.reserve({ attemptId, payloadSha256: "3".repeat(64),
      phase: "answer" })).rejects.toThrow("cannot be retried");
  });

  it("recovers an authenticated normalized outcome without reopening either provider effect",
    async () => {
      const fixture = await evidenceFixture();
      const outcome = { citations: [], claims: [], rawRetrievalResponseSha256: "4".repeat(64),
        reason: "zero_admissible_evidence", retrievalCandidates: [], selectedTurns: [],
        status: "abstained" as const };
      await fixture.evidence.audit.seal({ attemptId, kind: "answer_normalized_outcome",
        plaintext: new TextEncoder().encode(JSON.stringify(outcome)) });
      await expect(recoverProductionCanonicalOutcome({ answerJournalRoot:
        fixture.input.answerJournalRoot, artifactKey: fixture.input.artifactKey,
        artifactKeyId: fixture.input.artifactKeyId, artifactRoot: fixture.input.artifactRoot,
        attemptId, questionId: fixture.input.questionId,
        repetition: fixture.input.repetition, retrievalJournalRoot:
        fixture.input.retrievalJournalRoot, rootBindingSha256 }))
        .resolves.toEqual(outcome);
    });

  it("fails closed for traversal and foreign artifact-kind reads before resolving a path",
    async () => {
      const fixture = await evidenceFixture();
      const read = async (attempt: string, kind: string) => await import(
        "../src/quality-campaign/production-canonical-execution-evidence.js").then(async (module) =>
        await module.readProductionCanonicalArtifact({ artifactKey: fixture.input.artifactKey,
          artifactKeyId: fixture.input.artifactKeyId, artifactRoot: fixture.input.artifactRoot,
          attemptId: attempt, kind: kind as never, rootBindingSha256 }));
      await expect(read("../foreign", "answer_normalized_outcome"))
        .rejects.toThrow("attempt ID is invalid");
      await expect(read(attemptId, "../../foreign")).rejects.toThrow("artifact kind is invalid");
    });

  it.each(["receipt", "envelope"] as const)(
    "treats a present outcome pointer with a missing %s as corruption", async (missing) => {
      const fixture = await evidenceFixture();
      const outcome = { citations: [], claims: [], rawRetrievalResponseSha256: "4".repeat(64),
        reason: "zero_admissible_evidence", retrievalCandidates: [], selectedTurns: [],
        status: "abstained" as const };
      await fixture.evidence.audit.seal({ attemptId, kind: "answer_normalized_outcome",
        plaintext: new TextEncoder().encode(JSON.stringify(outcome)) });
      const receiptPath = join(fixture.input.artifactRoot, "receipts", attemptId,
        "answer_normalized_outcome.json");
      if (missing === "receipt") {await unlink(receiptPath);} else {
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as { envelopeSha256: string };
        await unlink(join(fixture.input.artifactRoot, `${receipt.envelopeSha256}.enc.json`));
      }
      await expect(recoverProductionCanonicalOutcome({ answerJournalRoot:
        fixture.input.answerJournalRoot, artifactKey: fixture.input.artifactKey,
        artifactKeyId: fixture.input.artifactKeyId, artifactRoot: fixture.input.artifactRoot,
        attemptId, questionId: fixture.input.questionId, repetition: fixture.input.repetition,
        retrievalJournalRoot: fixture.input.retrievalJournalRoot, rootBindingSha256 }))
        .rejects.toMatchObject({ code: "ENOENT" });
    });

  it("seals the exact empty-body capability request without admitting other empty artifacts",
    async () => {
      const fixture = await evidenceFixture();
      await expect(fixture.evidence.audit.seal({ attemptId, kind: "capability_request",
        plaintext: new Uint8Array() })).resolves.toBeUndefined();
      await expect(fixture.evidence.audit.seal({ attemptId, kind: "retrieval_request",
        plaintext: new Uint8Array() })).rejects.toThrow("artifact binding is invalid");
      await expect(fixture.evidence.audit.seal({ attemptId, kind: "capability_request",
        plaintext: new Uint8Array() })).rejects.toThrow();
    });

  it("durably syncs each new receipt directory name before publishing its receipt", async () => {
    const fixture = await evidenceFixture();
    const events: string[] = [];
    const evidence = createProductionCanonicalExecutionEvidence({ ...fixture.input,
      durabilityFaults: { afterDirectorySync: (path) => {events.push(`directory:${path}`);},
        afterFileSync: (path) => {events.push(`file:${path}`);} } });
    await evidence.audit.seal({ attemptId, kind: "capability_request",
      plaintext: new Uint8Array() });
    const receiptDirectory = join(fixture.input.artifactRoot, "receipts", attemptId);
    const receiptFile = join(receiptDirectory, "capability_request.json");
    expect(events.indexOf(`directory:${join(fixture.input.artifactRoot, "receipts")}`))
      .toBeLessThan(events.indexOf(`file:${receiptFile}`));
    expect(events.indexOf(`directory:${receiptDirectory}`))
      .toBeLessThan(events.indexOf(`file:${receiptFile}`));
    expect(events.lastIndexOf(`directory:${receiptDirectory}`))
      .toBeGreaterThan(events.indexOf(`file:${receiptFile}`));
  });

  it("persists attempt/root-bound encrypted canonical measured retrieval telemetry", async () => {
    const fixture = await evidenceFixture();
    const { exchange, observation } = await realAdapterObservation();
    const artifact = validateCanonicalRetrievalObservation({ attemptId,
      exchange, observation });
    await fixture.evidence.audit.seal({ attemptId, kind: "retrieval_observation",
      plaintext: new TextEncoder().encode(JSON.stringify(artifact)) });

    const files = await artifactEnvelopes(fixture.input.artifactRoot);
    const envelope = files.find((value) => value.artifactKind === "retrieval_observation");
    expect(envelope).toMatchObject({ attemptId, rootBindingSha256 });
    const store = new SemanticQualityV4EncryptedArtifactStore(fixture.input.artifactRoot);
    const plaintext = await store.open({ envelopeSha256: envelope!.envelopeSha256,
      key: fixture.input.artifactKey });
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
      attemptId, capabilityAndRetrievalLatencyUs: observation.capabilityAndRetrievalLatencyUs,
      capabilityBytes: observation.capabilityBytes, capabilitySha256: observation.capabilitySha256,
      requestBytes: exchange.requestBytes.byteLength, requestSha256: sha256(exchange.requestBytes),
      responseBytes: exchange.responseBytes.byteLength,
      responseSha256: sha256(exchange.responseBytes), routeLatencyUs: observation.routeLatencyUs,
      schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v1",
    });
  });

  it("rejects absent, unsafe, or exchange-substituted retrieval observations", () => {
    const bytes = new TextEncoder().encode('{"exact":1}');
    const valid = { capabilityAndRetrievalLatencyUs: 2, capabilityBytes: bytes.byteLength,
      capabilitySha256: sha256(bytes), requestBytes: bytes.byteLength,
      requestSha256: sha256(bytes), responseBytes: bytes.byteLength,
      responseSha256: sha256(bytes), routeLatencyUs: 1 };
    const exchange = { capabilityRequestBytes: new Uint8Array(), capabilityResponseBytes: bytes,
      requestBytes: bytes, responseBytes: bytes };
    expect(() => validateCanonicalRetrievalObservation({ attemptId, exchange,
      observation: null })).toThrow("observation is absent");
    expect(() => validateCanonicalRetrievalObservation({ attemptId, exchange,
      observation: { ...valid, routeLatencyUs: -1 } })).toThrow("timing is invalid");
    expect(() => validateCanonicalRetrievalObservation({ attemptId, exchange: {
      ...exchange, responseBytes: new TextEncoder().encode("another question") },
      observation: valid })).toThrow("does not match exact exchange");
  });

  it("has the canonical chain persist the concrete observation after its exact HTTP bytes",
    async () => {
      const events: string[] = [];
      const endpoint = new SyntheticUnavailableEndpoint(events);
      const fixture = await canonicalChainFixture(new ObservedExactAdapter(endpoint), events);
      try {
        await expect(fixture.executor.execute(executionPacket, executionOptions)).resolves
          .toMatchObject({ reason: "provider_unavailable", status: "failed" });
        const envelopes = await artifactEnvelopes(fixture.input.artifactRoot);
        const telemetry = envelopes.find(({ artifactKind }) =>
          artifactKind === "retrieval_observation");
        expect(telemetry).toBeDefined();
        const plaintext = await new SemanticQualityV4EncryptedArtifactStore(
          fixture.input.artifactRoot,
        ).open({ envelopeSha256: telemetry!.envelopeSha256, key: fixture.input.artifactKey });
        const artifact = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
        const requests = envelopes.find(({ artifactKind }) => artifactKind === "retrieval_request");
        const responses = envelopes.find(({ artifactKind }) => artifactKind === "retrieval_response");
        expect(artifact).toMatchObject({ attemptId,
          requestSha256: requests!.plaintextSha256,
          responseSha256: responses!.plaintextSha256 });
        const { capabilityAndRetrievalLatencyUs, routeLatencyUs } = artifact;
        expect(typeof capabilityAndRetrievalLatencyUs).toBe("number");
        expect(typeof routeLatencyUs).toBe("number");
        if (typeof capabilityAndRetrievalLatencyUs !== "number" ||
          typeof routeLatencyUs !== "number") {
          throw new TypeError("persisted retrieval timing is not numeric");
        }
        expect(Number.isSafeInteger(capabilityAndRetrievalLatencyUs)).toBe(true);
        expect(Number.isSafeInteger(routeLatencyUs)).toBe(true);
        expect(routeLatencyUs).toBeGreaterThanOrEqual(0);
        expect(capabilityAndRetrievalLatencyUs).toBeGreaterThanOrEqual(routeLatencyUs);
        expect(fixture.events).toEqual([
          "spend:capability", "spend:retrieval", "journal:reserve", "http:capability",
          "http:retrieval", "seal:capability_request", "seal:capability_response",
          "seal:retrieval_request", "seal:retrieval_response", "seal:retrieval_observation",
          "journal:failed", "seal:answer_normalized_outcome",
        ]);
        expect(fixture.answerCalls()).toBe(0);
      } finally {
        fixture.close();
      }
    });

  it.each(["absent", "tampered"] as const)(
    "retains exact HTTP artifacts and the provider code when telemetry is %s", async (fault) => {
    const events: string[] = [];
    const endpoint = new SyntheticUnavailableEndpoint(events);
    const fixture = await canonicalChainFixture(fault === "absent" ?
      new MissingObservationAdapter(endpoint) : new TamperedObservationAdapter(endpoint), events);
    try {
      await expect(fixture.executor.execute(executionPacket, executionOptions)).resolves
        .toMatchObject({ reason: "provider_unavailable", status: "failed" });
      const envelopes = await artifactEnvelopes(fixture.input.artifactRoot);
      expect(envelopes.map(({ artifactKind }) => artifactKind)).toEqual(expect.arrayContaining([
        "capability_request", "capability_response", "retrieval_request", "retrieval_response",
      ]));
      expect(envelopes.some(({ artifactKind }) => artifactKind === "retrieval_observation"))
        .toBe(false);
      expect(fixture.events.indexOf("seal:retrieval_response"))
        .toBeLessThan(fixture.events.indexOf("journal:failed"));
      expect(fixture.answerCalls()).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it("makes a missing exact exchange outcome unknown and prevents replay", async () => {
    const events: string[] = [];
    const endpoint = new SyntheticUnavailableEndpoint(events);
    const fixture = await canonicalChainFixture(new MissingExchangeAdapter(endpoint), events);
    try {
      await expect(fixture.executor.execute(executionPacket, executionOptions))
        .rejects.toThrow("external effect is unknown and terminal");
      expect(fixture.events.filter((event) => event === "http:retrieval")).toHaveLength(1);
      expect(fixture.events.some((event) => event.startsWith("seal:"))).toBe(false);
      expect(await readFile(join(fixture.input.retrievalJournalRoot, attemptId, "terminal.json"),
        "utf8")).toContain('"state":"outcome_unknown"');
      await expect(fixture.executor.execute(executionPacket, executionOptions))
        .rejects.toThrow("cannot be retried");
      expect(fixture.events.filter((event) => event === "http:retrieval")).toHaveLength(1);
      expect(fixture.answerCalls()).toBe(0);
    } finally {
      fixture.close();
    }
  });
});

const executionPacket = Object.freeze({ locale: "en" as const, questionId: "q-1",
  questionText: "What was approved?", scopeTopologyReference: "signed-scope:v1:abc",
  source: "independent_review" as const });
const executionOptions = Object.freeze({ attemptId, signal: new AbortController().signal });

class FixedPreparer extends PrepareFocusedLocatorRetrievalV2Request {
  public constructor() {super({} as never);}
  public override async prepare(): Promise<Awaited<ReturnType<
    PrepareFocusedLocatorRetrievalV2Request["prepare"]>>> {
    const request = retrievalRequest() as InfinityContextRetrievalV2Request & {
      readonly status: "prepared" };
    Object.defineProperty(request, "status", { enumerable: false, value: "prepared" });
    return request;
  }
}

class ObservedExactAdapter extends InfinityContextRetrievalV2Adapter {
  public constructor(private readonly endpoint: SyntheticUnavailableEndpoint) {
    super({ baseUrl: "https://synthetic-infinity.invalid", operationTimeoutMs: 1_000,
      requestTimeoutMs: 1_000, transport: endpoint });
  }
  public override takeExactExchange(): ReturnType<InfinityContextRetrievalV2Adapter[
    "takeExactExchange"]> {
    return syntheticExactExchange(this.endpoint.response);
  }
}

class TamperedObservationAdapter extends ObservedExactAdapter {
  public override takeObservation(): ReturnType<InfinityContextRetrievalV2Adapter[
    "takeObservation"]> {
    return Object.freeze({ ...super.takeObservation(), responseSha256: "0".repeat(64) });
  }
}

class MissingObservationAdapter extends ObservedExactAdapter {
  public override takeObservation(): ReturnType<InfinityContextRetrievalV2Adapter[
    "takeObservation"]> {
    super.takeObservation();
    throw new Error("synthetic observation loss");
  }
}

class MissingExchangeAdapter extends ObservedExactAdapter {
  public override takeExactExchange(): ReturnType<InfinityContextRetrievalV2Adapter[
    "takeExactExchange"]> {
    throw new Error("synthetic exact exchange loss");
  }
}

async function canonicalChainFixture(retrieval: InfinityContextRetrievalV2Adapter,
  events: string[]) {
  const evidence = await evidenceFixture();
  const transport = new GrpcSubscriptionRuntimeTransport({ address: "127.0.0.1:1",
    serviceToken: "synthetic-token-1234" });
  let answerCalls = 0;
  const answer = createGrpcQualifiedGroundedAnswerAdapter({
    beforeProviderCall: async () => {answerCalls += 1;},
    options: { expectedLauncherSha256: "5".repeat(64) }, transport,
  });
  const chain = createProductionCanonicalQuestionChain({ answer,
    audit: { seal: async (value) => {events.push(`seal:${value.kind}`);
      await evidence.evidence.audit.seal(value);} },
    evidenceAuthority: new PostgresHistoricalEvidenceAuthority({} as never),
    ids: new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(9)),
    journal: { reserve: async (value) => {events.push("journal:reserve");
      await evidence.evidence.journal.reserve(value);},
    terminal: async (value) => {events.push(`journal:${value.state}`);
      await evidence.evidence.journal.terminal(value);} },
    preparer: new FixedPreparer(), retrieval,
    spend: { reserve: async ({ effectKind }) => {events.push(`spend:${effectKind}`);} },
    store: new PostgresHistoricalMemoryStore({} as never),
    topology: { resolve: async () => ({ currentMeetingId: "meeting-1", roomId: "room-1",
      scopeId: "scope-1" }) },
  });
  return { answerCalls: () => answerCalls, close: () => {transport.close();},
    events, executor: new ExecuteAdmittedQualificationQuestion(chain), input: evidence.input };
}

class SyntheticUnavailableEndpoint implements HttpTransport {
  public readonly response = unavailableResponse();
  public constructor(private readonly events: string[]) {}
  public async send(request: HttpRequest): Promise<HttpResponse> {
    const capabilityRequest = request.url.pathname.endsWith("/v1/capabilities");
    this.events.push(capabilityRequest ? "http:capability" : "http:retrieval");
    return { body: JSON.stringify(capabilityRequest ? { context: { retrieval: capability } } :
      this.response), headers: new Headers({ "content-type": "application/json" }), status: 200 };
  }
}

function unavailableResponse(): Record<string, unknown> {
  const response = structuredClone(successfulResponse);
  Object.assign(response, { candidates: [], status: "unavailable" });
  Object.assign(response.applied_bounds as Record<string, unknown>, { deadline_ms: 1_000,
    neighbor_radius: 0, returned_neighbors: 0, returned_seeds: 0 });
  response.provider_outcomes = (response.provider_outcomes as Record<string, unknown>[])
    .map((outcome) => ({ ...outcome, reason_code: "provider_unavailable",
      status: "unavailable" }));
  return response;
}

function syntheticExactExchange(response: Record<string, unknown>) {
  const request = retrievalRequest();
  const sdkRequest = { bounds: { candidateLimit: request.budgets.candidateLimit,
    deadlineMs: request.budgets.deadlineMs, neighborRadius: request.budgets.neighborRadius,
    responseByteLimit: request.budgets.responseByteLimit, resultLimit: request.budgets.resultLimit },
  capabilityFingerprint: request.binding.capabilityFingerprint,
  contractVersion: request.binding.contractVersion, filters: request.filters,
  profileId: request.binding.profileId, queries: request.queries, scope: request.scope,
  softPreferences: request.softPreferences };
  return { capabilityRequestBytes: new Uint8Array(),
    capabilityResponseBytes: encodeJson({ context: { retrieval: capability } } as JsonValue),
    requestBytes: encodeJson(sdkRequest),
    responseBytes: encodeJson(response as JsonValue) };
}

function encodeJson(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function evidenceFixture() {
  const root = await mkdtemp(join(tmpdir(), "canonical-execution-evidence-"));
  const answerJournalRoot = join(root, "answer-journal");
  const retrievalJournalRoot = join(root, "retrieval-journal");
  const input = { answerJournalRoot, artifactKey: new Uint8Array(32).fill(7),
    artifactKeyId: "artifact-key", artifactRoot: join(root, "artifacts"), attemptId,
    questionId: "q-1", repetition: 1 as const, retrievalJournalRoot, rootBindingSha256 };
  return { evidence: createProductionCanonicalExecutionEvidence(input), input,
    retrievalJournalRoot };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function artifactEnvelopes(root: string): Promise<Array<Record<string, unknown> & {
  envelopeSha256: string }>> {
  const { readdir } = await import("node:fs/promises");
  return await Promise.all((await readdir(root)).filter((name) => name.endsWith(".enc.json"))
    .map(async (name) => ({ ...JSON.parse(await readFile(join(root, name), "utf8")) as
      Record<string, unknown>, envelopeSha256: name.slice(0, -9) })));
}

async function realAdapterObservation() {
  const endpoint = new SyntheticUnavailableEndpoint([]);
  const adapter = new ObservedExactAdapter(endpoint);
  await expect(adapter.retrieve(retrievalRequest())).resolves.toMatchObject({
    code: "provider_unavailable", status: "unavailable" });
  return { exchange: adapter.takeExactExchange(), observation: adapter.takeObservation() };
}

function retrievalRequest(): InfinityContextRetrievalV2Request {
  return { binding: { capabilityFingerprint: capability.capability_fingerprint as string,
    contractVersion: "context-retrieval.v2",
    indexProfileDigest: capability.index_profile_digest as string,
    profileId: capability.profile_id as string,
    rankingPolicy: "weighted_rrf_canonical_preferences.v1",
    requiredProviderLanes: capability.required_provider_lanes as string[],
    serviceRevision: capability.service_revision as string },
  budgets: { candidateLimit: 100, deadlineMs: 1_000, evidenceByteLimit: 16_000,
    neighborRadius: 0, responseByteLimit: 16_384, resultLimit: 10 },
  filters: { actorKeys: [], category: null, documentKeys: [], excludedSourceKeys: [],
    kinds: ["record_block"], relativeTimeInterval: null,
    sourceGenerations: [{ projectionGeneration: "generation-1", sourceKey: "source-1" }],
    tagsAll: [], tagsAny: [], tagsNone: [], timeInterval: null },
  queries: [{ query: "actual measured request", queryId: "original-question" }],
  schemaVersion: 2, scope: { memoryScopeId: "scope-1", spaceId: "space-1", threadId: null },
  softPreferences: { actorPreferences: [], relativeTimeInterval: null, sourcePreferences: [],
    timeInterval: null, timeWeightMicros: null } };
}
