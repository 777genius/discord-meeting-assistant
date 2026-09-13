import { createHash } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { createFocusedRetrievalGroundingPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { buildSubscriptionRuntimeKnowledgeAnswerRequest, knowledgeAnswerExchangeInventorySha256,
  serializeSubscriptionRuntimeTaskRequest } from
  "@discord-meeting/subscription-runtime-adapter";

import { absentAnswerRequestIntentBytes, absentAnswerRequestIntentSha256,
  preparedAnswerRequestIntentBytes } from
  "../src/quality-campaign/canonical-answer-artifact-validation.js";
import { canonicalJson, sha256 as canonicalSha256 } from
  "../src/quality-campaign/canonical.js";
import { attemptIdentity } from "../src/quality-campaign/execution.js";
import { createProductionCanonicalExecutionEvidence } from
  "../src/quality-campaign/production-canonical-execution-evidence.js";
import { createProductionLocalCanonicalEvidenceReader } from
  "../src/quality-campaign/production-local-canonical-evidence-reader.js";

const campaignRootSha256 = "b".repeat(64);
const executionPacket = { locale: "en" as const, questionId: "q-1",
  questionText: "What synthetic evidence was retained?",
  scopeTopologyReference: "synthetic-topology-reference", source: "automatic" as const };
const identity = attemptIdentity({ callKind: "answer", callOrdinal: 0, campaignRootSha256,
  questionDigestSha256: canonicalSha256(executionPacket), questionId: executionPacket.questionId,
  releaseRootSha256: "d".repeat(64), repetition: 1,
  spendReservationSha256: "e".repeat(64) });
const attemptId = identity.attemptId;

describe("production local canonical evidence reader", () => {
  it("authenticates the exact SDK exchange and normalized outcome into a deterministic inventory",
    async () => {
      const fixture = await localFixture();
      const verified = await fixture.reader.verify({ attempts: [fixture.projection],
        campaignRootSha256 });
      expect(verified.inventorySha256).toMatch(/^[a-f0-9]{64}$/u);
      await expect(fixture.reader.readReservedAnswerSpendClaims!([identity])).resolves.toEqual([]);
      await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
        retrievalLatencyUs: fixture.projection.retrievalLatencyUs - 1 }], campaignRootSha256 }))
        .rejects.toThrow("differs from measured canonical SDK operation");
      await expect(fixture.reader.readReservedAnswerSpendClaims!([identity]))
        .rejects.toThrow("lack their verified local receipt inventory");
      const foreignKeyReader = createProductionLocalCanonicalEvidenceReader({ artifactKey:
        new Uint8Array(32).fill(7), artifactKeyId: "another-key", artifactRoot:
        fixture.artifactRoot });
      await expect(foreignKeyReader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
        .rejects.toThrow("key identity differs");
    });

  it("fails closed for an extra observation key and a mismatched receipt byte size", async () => {
    const extra = await localFixture({ extraObservationKey: true });
    await expect(extra.reader.verify({ attempts: [extra.projection], campaignRootSha256 }))
      .rejects.toThrow("canonical retrieval observation has an invalid shape");

    const fixture = await localFixture();
    const path = join(fixture.artifactRoot, "receipts", attemptId, "retrieval_response.json");
    const receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, canonicalJson({ ...receipt, sizeBytes: Number(receipt.sizeBytes) + 1 }),
      { mode: 0o600 });
    await expect(fixture.reader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
      .rejects.toThrow("size or envelope digest differs");
  });

  it("rejects authenticated unknown or unprepared scope metadata", async () => {
    for (const options of [{ scopeStatus: "interrupted" },
      { scopeReadStatus: "outcome_unknown" },
      { scopeValue: { schemaVersion: "meeting_knowledge.scope_resolution.v1",
        status: "unavailable", reads: [{ kind: "scope_spaces",
          requestSha256: "1".repeat(64), responseSha256: null, responseBytes: 0,
          status: "outcome_unknown" }] } }]) {
      const fixture = await localFixture(options);
      await expect(fixture.reader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
        .rejects.toThrow("canonical scope resolution observation");
    }
  });

  it.each(["missing", "substituted", "corrupt"])("rejects %s scope metadata artifacts", async (mode) => {
    const fixture = await localFixture();
    const path = join(fixture.artifactRoot, "receipts", attemptId, "scope_resolution_observation.json");
    const receipt = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (mode === "missing") { await unlink(path); }
    else if (mode === "substituted") {
      await writeFile(path, canonicalJson({ ...receipt, artifactKind: "retrieval_observation" }));
    } else {
      await writeFile(join(fixture.artifactRoot, `${String(receipt.envelopeSha256)}.enc.json`), "corrupt");
    }
    await expect(fixture.reader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
      .rejects.toThrow();
  });

  it("rejects authenticated malformed and oversized metadata observations", async () => {
    const read = { kind: "scope_spaces", requestSha256: "1".repeat(64),
      responseSha256: "2".repeat(64), responseBytes: 12, status: "received" };
    const valid = { schemaVersion: "meeting_knowledge.scope_resolution.v1", status: "prepared",
      reads: [read, { ...read, kind: "scope_memory_scopes" }] };
    for (const scopeValue of [{ ...valid, reads: [read] }, { ...valid, reads: [read, read] },
      { ...valid, reads: [{ ...read, responseBytes: 65_537 }, valid.reads[1]] },
      { ...valid, reads: [{ ...read, requestSha256: "invalid" }, valid.reads[1]] },
      { ...valid, extra: "x".repeat(5000) }]) {
      const fixture = await localFixture({ scopeValue });
      await expect(fixture.reader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
        .rejects.toThrow();
    }
  });

  it("rejects outcome and attempt projections that do not match retained local bytes", async () => {
    const fixture = await localFixture();
    await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
      rankedLocatorIds: ["another-locator"] }], campaignRootSha256 }))
      .rejects.toThrow("locators or turns differ");
    await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
      retrievalResponseSha256: "c".repeat(64) }], campaignRootSha256 }))
      .rejects.toThrow("differs from external terminal evidence");
    await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
      answerAbstained: true }], campaignRootSha256 }))
      .rejects.toThrow("differs from external outcome evidence");
    await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
      attemptId: `sqv4-${"d".repeat(64)}` }], campaignRootSha256 })).rejects.toThrow();
    const failed = await localFixture({ outcomeStatus: "failed" });
    const failedVerification = await failed.reader.verify({ attempts: [failed.projection],
      campaignRootSha256 });
    expect(failedVerification.inventorySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects missing indices and corrupt envelopes without scanning for replacements", async () => {
    const missing = await localFixture();
    await unlink(join(missing.artifactRoot, "receipts", attemptId, "capability_response.json"));
    await expect(missing.reader.verify({ attempts: [missing.projection], campaignRootSha256 }))
      .rejects.toThrow();

    const corrupt = await localFixture();
    const receipt = JSON.parse(await readFile(join(corrupt.artifactRoot, "receipts", attemptId,
      "retrieval_request.json"), "utf8")) as { envelopeSha256: string };
    await writeFile(join(corrupt.artifactRoot, `${receipt.envelopeSha256}.enc.json`), "corrupt",
      { mode: 0o600 });
    await expect(corrupt.reader.verify({ attempts: [corrupt.projection], campaignRootSha256 }))
      .rejects.toThrow();

    const foreignKind = await localFixture();
    const indexPath = join(foreignKind.artifactRoot, "receipts", attemptId,
      "retrieval_response.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>;
    await writeFile(indexPath, canonicalJson({ ...index, artifactKind: "retrieval_request" }),
      { mode: 0o600 });
    await expect(foreignKind.reader.verify({ attempts: [foreignKind.projection],
      campaignRootSha256 })).rejects.toThrow("foreign or substituted");
  });

  it.each(["empty", "unavailable"] as const)(
    "retains an authenticated pre-retrieval %s failure without fake transport exchanges",
    async (status) => {
      const fixture = await earlyFailureFixture(status);
      const verification = await fixture.reader.verify({ attempts: [fixture.projection],
        campaignRootSha256 });
      expect(verification.inventorySha256).toMatch(/^[a-f0-9]{64}$/u);
      await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
        terminalAnswerRequestSha256: "0".repeat(64) }], campaignRootSha256 }))
        .rejects.toThrow("unprepared answer intent differs");
      await fixture.evidence.audit.seal({ attemptId: fixture.projection.attemptId,
        kind: "capability_request", plaintext: new Uint8Array() });
      await expect(fixture.reader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
        .rejects.toThrow("contains unopened artifacts");
    });

  it("rejects non-empty metadata substituted into an empty pre-retrieval branch", async () => {
    const fixture = await earlyFailureFixture("empty", [{ kind: "scope_spaces",
      requestSha256: "1".repeat(64), responseBytes: 0, responseSha256: null,
      status: "failed" }]);
    await expect(fixture.reader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
      .rejects.toThrow("canonical scope resolution observation is incomplete");
  });

  it("rejects missing V1 answer intent and execution observation custody", async () => {
    const missingIntent = await localFixture();
    await unlink(join(missingIntent.artifactRoot, "receipts", attemptId,
      "answer_request_intent.json"));
    await expect(missingIntent.reader.verify({ attempts: [missingIntent.projection],
      campaignRootSha256 })).rejects.toThrow();

    const missingObservation = await localFixture();
    await unlink(join(missingObservation.artifactRoot, "receipts", attemptId,
      "answer_execution_observation.json"));
    await expect(missingObservation.reader.verify({ attempts: [missingObservation.projection],
      campaignRootSha256 })).rejects.toThrow();
  });

  it("rejects foreign V1 retained generation and unknown answer execution custody", async () => {
    const foreignGeneration = await localFixture({
      selectedMemoryGeneration: "foreign-memory-generation" });
    await expect(foreignGeneration.reader.verify({ attempts: [foreignGeneration.projection],
      campaignRootSha256 })).rejects.toThrow("independently reconstructed evidence");

    const unknownOutcome = await localFixture({ outcomeCertain: false });
    await expect(unknownOutcome.reader.verify({ attempts: [unknownOutcome.projection],
      campaignRootSha256 })).rejects.toThrow("outcome remains unknown");

    const unknownNoSend = await localFixture({ omitAnswerExchange: true,
      outcomeStatus: "failed" });
    await expect(unknownNoSend.reader.verify({ attempts: [unknownNoSend.projection],
      campaignRootSha256 }))
      .rejects.toThrow("terminal reason differs from proven provider call inventory");
  });

  it("requires V2 topology binding and exact zero retrieval latency before retrieval", async () => {
    const legacy = await earlyFailureFixture("empty", [], { legacy: true });
    await expect(legacy.reader.verify({ attempts: [legacy.projection], campaignRootSha256 }))
      .rejects.toThrow("generation-bound V2");
    const altered = await earlyFailureFixture("empty", [], { alteredTopology: true });
    await expect(altered.reader.verify({ attempts: [altered.projection], campaignRootSha256 }))
      .rejects.toThrow("topology differs");
    const nonzero = await earlyFailureFixture("empty");
    await expect(nonzero.reader.verify({ attempts: [{ ...nonzero.projection,
      retrievalLatencyUs: 1 }], campaignRootSha256 })).rejects.toThrow("pre-retrieval outcome");
  });
});

async function earlyFailureFixture(status: "empty" | "unavailable",
  reads: readonly unknown[] = status === "unavailable" ? [{ kind: "scope_spaces",
    requestSha256: "1".repeat(64), responseBytes: 0, responseSha256: null,
    status: "failed" }] : [], options: { readonly alteredTopology?: boolean;
      readonly legacy?: boolean } = {}) {
  const versionedPacket = { ...executionPacket,
    schemaVersion: "meeting_knowledge.qualification_execution_packet.v2" as const,
    scopeTopologyDocumentSha256: "9".repeat(64), scopeTopologyGeneration: "generation-1" };
  const packet = options.legacy === true ? executionPacket : versionedPacket;
  const earlyIdentity = attemptIdentity({ callKind: "answer", callOrdinal: 0, campaignRootSha256,
    questionDigestSha256: canonicalSha256(packet), questionId: packet.questionId,
    releaseRootSha256: "d".repeat(64), repetition: 1,
    spendReservationSha256: "e".repeat(64) });
  const root = await mkdtemp(join(tmpdir(), "canonical-early-reader-"));
  const artifactRoot = join(root, "artifacts");
  const artifactKey = new Uint8Array(32).fill(7);
  const evidence = createProductionCanonicalExecutionEvidence({ answerJournalRoot:
    join(root, "answer"), artifactKey, artifactKeyId: "synthetic-key", artifactRoot,
    attemptId: earlyIdentity.attemptId, questionId: packet.questionId, repetition: 1,
    retrievalJournalRoot: join(root, "retrieval"), rootBindingSha256: campaignRootSha256 });
  const reason = `request_${status}`;
  const outcome = { citations: [], claims: [], rawRetrievalResponseSha256: null,
    reason, retrievalCandidates: [], selectedTurns: [], status: "failed" as const };
  for (const [kind, plaintext] of [
    ["scope_resolution_observation", bytes(canonicalJson({ reads,
      schemaVersion: "meeting_knowledge.scope_resolution.v1", status }))],
    ["answer_request_intent", absentAnswerRequestIntentBytes(earlyIdentity.attemptId, reason)],
    ["answer_normalized_outcome", bytes(JSON.stringify(outcome))],
  ] as const) {
    await evidence.audit.seal({ attemptId: earlyIdentity.attemptId, kind, plaintext });
  }
  const topology = { currentMeetingId: "synthetic-meeting", roomId: "synthetic-room",
    scopeId: "synthetic-scope", memoryScopeId: "internal-memory-scope", spaceId: "internal-space",
    topologyDocumentSha256: versionedPacket.scopeTopologyDocumentSha256,
    topologyGeneration: options.alteredTopology === true ? "altered-generation" :
      versionedPacket.scopeTopologyGeneration };
  const reader = createProductionLocalCanonicalEvidenceReader({ artifactKey,
    artifactKeyId: "synthetic-key", artifactRoot, topology: { resolve: async () => topology } });
  return { evidence, reader, projection: { answerAbstained: false, attemptId: earlyIdentity.attemptId,
    campaignRootSha256, capabilityRequestSha256: null,
    capabilityResponseSha256: null, citationLocatorIds: [],
    diagnosticCustody: null, evidenceLocatorIds: [], evidenceTurnIds: [], executionPacket: packet,
    identity: earlyIdentity, providerCallInventory: [], rankedLocatorIds: [], retrievalLatencyUs: 0,
    retrievalRequestSha256: null, retrievalResponseSha256: null,
    terminalAnswerRequestSha256: absentAnswerRequestIntentSha256(earlyIdentity.attemptId, reason),
    terminalAnswerResponseSha256: knowledgeAnswerExchangeInventorySha256([]), terminalReason: reason,
    terminalStatus: "failed" as const, topology: null } };
}

async function localFixture(options: { readonly extraObservationKey?: boolean;
  readonly omitAnswerExchange?: boolean; readonly outcomeCertain?: boolean;
  readonly scopeStatus?: string; readonly scopeReadStatus?: string; readonly scopeValue?: unknown;
  readonly selectedMemoryGeneration?: string;
  readonly outcomeStatus?: "answered" | "failed" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "canonical-local-reader-"));
  const artifactRoot = join(root, "artifacts"); const artifactKey = new Uint8Array(32).fill(7);
  const evidence = createProductionCanonicalExecutionEvidence({ answerJournalRoot:
    join(root, "answer"), artifactKey, artifactKeyId: "synthetic-key", artifactRoot, attemptId,
  questionId: "q-1", repetition: 1, retrievalJournalRoot: join(root, "retrieval"),
  rootBindingSha256: campaignRootSha256 });
  const capabilityRequest = new Uint8Array();
  const capabilityResponse = bytes(canonicalJson({ capability: "synthetic" }));
  const retrievalRequest = bytes(canonicalJson({ query: "synthetic" }));
  const retrievalResponse = bytes(canonicalJson({ locators: ["locator-1"] }));
  const observation = { attemptId, capabilityAndRetrievalLatencyUs: 12,
    capabilityBytes: capabilityResponse.byteLength, capabilitySha256: sha(capabilityResponse),
    requestBytes: retrievalRequest.byteLength, requestSha256: sha(retrievalRequest),
    responseBytes: retrievalResponse.byteLength, responseSha256: sha(retrievalResponse),
    routeLatencyUs: 7,
    schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v1",
    ...(options.extraObservationKey === true ? { unexpected: true } : {}) };
  const turn = { endMs: 2, sourceLocatorId: "locator-1", speakerId: "speaker-1", startMs: 1,
    text: "Synthetic evidence", turnHash: "d".repeat(64), turnId: "turn-1" };
  const outcome = { citations: options.outcomeStatus === "failed" ? [] : ["turn-1"],
    claims: options.outcomeStatus === "failed" ? [] : ["Synthetic claim"],
    rawRetrievalResponseSha256: sha(retrievalResponse), retrievalCandidates: [{ contributions: [],
      fusedScore: 1, locatorId: "locator-1", providerRank: 0 }], selectedTurns: [turn],
    ...(options.outcomeStatus === "failed" ? { reason: "synthetic_failure" } : {}),
    status: options.outcomeStatus ?? "answered" };
  const memoryGeneration = "postgres-memory-generation-1";
  const answerBinding = { canonicalEvidenceHash: canonicalSha256([turn.turnHash]),
    memoryGeneration, transcriptVersion: 1 };
  const answerPlan = createFocusedRetrievalGroundingPlan({ authorityGeneration: memoryGeneration,
    coverage: "sufficient", humanActorIds: [turn.speakerId], turns: [turn] });
  const answerRequest = buildSubscriptionRuntimeKnowledgeAnswerRequest({ attemptId,
    binding: answerBinding, locale: executionPacket.locale, plan: answerPlan,
    question: executionPacket.questionText }, {
    isolatedCwd: "/run/discord-meeting-subscription-runtime/workspace",
    maxOutputTokens: 2_048, timeoutMs: 180_000 });
  const answerResponse = bytes("synthetic-runtime-response");
  const answerSurface = bytes([answerRequest.task.systemPrompt, answerRequest.task.prompt,
    JSON.stringify(answerRequest.task.controls.outputSchema)].join("\n"));
  const terminalReason = options.outcomeStatus === "failed" ? "synthetic_failure" : null;
  for (const [kind, plaintext] of [["capability_request", capabilityRequest],
    ["capability_response", capabilityResponse], ["retrieval_request", retrievalRequest],
    ["retrieval_response", retrievalResponse], ["retrieval_observation", bytes(canonicalJson(observation))],
    ["scope_resolution_observation", bytes(canonicalJson(options.scopeValue ?? {
      schemaVersion: "meeting_knowledge.scope_resolution.v1", status: options.scopeStatus ?? "prepared",
      reads: ["scope_spaces", "scope_memory_scopes"].map((readKind) => ({ kind: readKind,
        requestSha256: "1".repeat(64), responseSha256: options.scopeReadStatus === "outcome_unknown" ?
          null : "2".repeat(64), responseBytes: options.scopeReadStatus === "outcome_unknown" ? 0 : 12,
        status: options.scopeReadStatus ?? "received" })),
    }))],
    ["selected_canonical_turns", bytes(JSON.stringify({ attemptId,
      memoryGeneration: options.selectedMemoryGeneration ?? memoryGeneration,
      schemaVersion: "meeting_knowledge.selected_canonical_turns.v2", turns: [turn] }))],
    ["answer_request_intent", preparedAnswerRequestIntentBytes(attemptId, answerRequest,
      memoryGeneration)],
    ["answer_execution_observation", bytes(canonicalJson({ attemptId,
      outcomeCertain: options.outcomeCertain ?? true,
      providerBytesSent: options.omitAnswerExchange !== true,
      schemaVersion: "meeting_knowledge.canonical_answer_execution_observation.v2",
      terminalReason }))],
    ["answer_original_model_surface", answerSurface],
    ["answer_original_request", serializeSubscriptionRuntimeTaskRequest(answerRequest)],
    ["answer_original_response", answerResponse],
    ["answer_normalized_outcome", bytes(JSON.stringify(outcome))]] as const) {
    if (options.omitAnswerExchange === true && kind.startsWith("answer_original_")) {continue;}
    await evidence.audit.seal({ attemptId, kind, plaintext });
  }
  return { artifactRoot, evidence, reader: createProductionLocalCanonicalEvidenceReader({ artifactKey,
    artifactKeyId: "synthetic-key", artifactRoot }), projection: { answerAbstained: false,
    attemptId, campaignRootSha256,
    capabilityRequestSha256: sha(capabilityRequest), capabilityResponseSha256: sha(capabilityResponse),
    citationLocatorIds: options.outcomeStatus === "failed" ? [] : ["locator-1"],
    evidenceLocatorIds: ["locator-1"],
    diagnosticCustody: null, evidenceTurnIds: ["turn-1"], executionPacket, identity,
    providerCallInventory: [{ callKind: "capability" as const, callOrdinal: 0 as const },
      { callKind: "retrieval" as const, callOrdinal: 0 as const },
      ...(options.omitAnswerExchange === true ? [] :
        [{ callKind: "answer" as const, callOrdinal: 0 as const }])],
    rankedLocatorIds: ["locator-1"], retrievalLatencyUs: 12,
    retrievalRequestSha256: sha(retrievalRequest), retrievalResponseSha256:
      sha(retrievalResponse), terminalAnswerRequestSha256: canonicalSha256({
        effectKind: "answer", request: answerRequest }),
    terminalAnswerResponseSha256: knowledgeAnswerExchangeInventorySha256(
      options.omitAnswerExchange === true ? [] : [{
        callOrdinal: "original", requestBytes: serializeSubscriptionRuntimeTaskRequest(answerRequest),
        responseBytes: answerResponse }]),
    terminalReason: options.outcomeStatus === "failed" ? "synthetic_failure" : null,
    terminalStatus: options.outcomeStatus === "failed" ? "failed" as const : "answered" as const,
    topology: {
      currentMeetingId: "synthetic-meeting", roomId: "synthetic-room",
      scopeId: "synthetic-scope" } } };
}
function bytes(value: string): Uint8Array {return new TextEncoder().encode(value);}
function sha(value: Uint8Array): string {return createHash("sha256").update(value).digest("hex");}
