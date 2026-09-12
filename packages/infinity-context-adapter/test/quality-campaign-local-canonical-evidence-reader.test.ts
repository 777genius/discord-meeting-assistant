import { createHash } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { knowledgeAnswerExchangeInventorySha256 } from
  "@discord-meeting/subscription-runtime-adapter";

import { absentAnswerRequestIntentBytes, absentAnswerRequestIntentSha256 } from
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
      await expect(fixture.reader.verify({ attempts: [{ ...fixture.projection,
        retrievalLatencyUs: fixture.projection.retrievalLatencyUs - 1 }], campaignRootSha256 }))
        .rejects.toThrow("differs from measured canonical SDK operation");
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
      { scopeReadStatus: "outcome_unknown" }]) {
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
    await expect(failed.reader.verify({ attempts: [failed.projection], campaignRootSha256 }))
      .resolves.toMatchObject({ inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
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
      await expect(fixture.reader.verify({ attempts: [fixture.projection], campaignRootSha256 }))
        .resolves.toMatchObject({ inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
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
});

async function earlyFailureFixture(status: "empty" | "unavailable",
  reads: readonly unknown[] = status === "unavailable" ? [{ kind: "scope_spaces",
    requestSha256: "1".repeat(64), responseBytes: 0, responseSha256: null,
    status: "failed" }] : []) {
  const packet = { ...executionPacket,
    schemaVersion: "meeting_knowledge.qualification_execution_packet.v2" as const,
    scopeTopologyDocumentSha256: "9".repeat(64), scopeTopologyGeneration: "generation-1" };
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
    topologyDocumentSha256: packet.scopeTopologyDocumentSha256,
    topologyGeneration: packet.scopeTopologyGeneration };
  const reader = createProductionLocalCanonicalEvidenceReader({ artifactKey,
    artifactKeyId: "synthetic-key", artifactRoot, topology: { resolve: async () => topology } });
  return { evidence, reader, projection: { answerAbstained: false, attemptId: earlyIdentity.attemptId,
    campaignRootSha256, capabilityRequestSha256: "1".repeat(64),
    capabilityResponseSha256: "2".repeat(64), citationLocatorIds: [],
    diagnosticCustody: null, evidenceLocatorIds: [], evidenceTurnIds: [], executionPacket: packet,
    identity: earlyIdentity, rankedLocatorIds: [], retrievalLatencyUs: 0,
    retrievalRequestSha256: "3".repeat(64), retrievalResponseSha256: "4".repeat(64),
    terminalAnswerRequestSha256: absentAnswerRequestIntentSha256(earlyIdentity.attemptId, reason),
    terminalAnswerResponseSha256: knowledgeAnswerExchangeInventorySha256([]), topology: null } };
}

async function localFixture(options: { readonly extraObservationKey?: boolean;
  readonly scopeStatus?: string; readonly scopeReadStatus?: string; readonly scopeValue?: unknown;
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
    text: "Synthetic evidence", turnHash: "turn-hash", turnId: "turn-1" };
  const outcome = { citations: options.outcomeStatus === "failed" ? [] : ["turn-1"],
    claims: options.outcomeStatus === "failed" ? [] : ["Synthetic claim"],
    rawRetrievalResponseSha256: sha(retrievalResponse), retrievalCandidates: [{ contributions: [],
      fusedScore: 1, locatorId: "locator-1", providerRank: 0 }], selectedTurns: [turn],
    ...(options.outcomeStatus === "failed" ? { reason: "synthetic_failure" } : {}),
    status: options.outcomeStatus ?? "answered" };
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
    ["answer_normalized_outcome", bytes(JSON.stringify(outcome))]] as const) {
    await evidence.audit.seal({ attemptId, kind, plaintext });
  }
  return { artifactRoot, reader: createProductionLocalCanonicalEvidenceReader({ artifactKey,
    artifactKeyId: "synthetic-key", artifactRoot }), projection: { answerAbstained: false,
    attemptId, campaignRootSha256,
    capabilityRequestSha256: sha(capabilityRequest), capabilityResponseSha256: sha(capabilityResponse),
    citationLocatorIds: options.outcomeStatus === "failed" ? [] : ["locator-1"],
    evidenceLocatorIds: ["locator-1"],
    diagnosticCustody: null, evidenceTurnIds: ["turn-1"], executionPacket, identity,
    rankedLocatorIds: ["locator-1"], retrievalLatencyUs: 12,
    retrievalRequestSha256: sha(retrievalRequest), retrievalResponseSha256:
      sha(retrievalResponse), terminalAnswerRequestSha256: sha(bytes("synthetic-answer-request")),
    terminalAnswerResponseSha256: sha(bytes("synthetic-answer-response")), topology: {
      currentMeetingId: "synthetic-meeting", roomId: "synthetic-room",
      scopeId: "synthetic-scope" } } };
}
function bytes(value: string): Uint8Array {return new TextEncoder().encode(value);}
function sha(value: Uint8Array): string {return createHash("sha256").update(value).digest("hex");}
