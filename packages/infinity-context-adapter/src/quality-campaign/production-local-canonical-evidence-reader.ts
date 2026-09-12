import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { createFocusedRetrievalGroundingPlan } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { buildSubscriptionRuntimeKnowledgeAnswerRequest, serializeSubscriptionRuntimeTaskRequest,
  knowledgeAnswerExchangeInventorySha256, stableSubscriptionRuntimeId,
  subscriptionRuntimeTranscriptVersionFromRequestBytes } from
  "@discord-meeting/subscription-runtime-adapter";

import { canonicalJson, digest, exactRecord, sha256 as canonicalSha256 } from "./canonical.js";
import { custodyDigest, custodyJson, validateCanonicalRetrievalBinding, validateCanonicalRetrievalObservation,
  validateCanonicalScopeResolutionObservation,
  type SemanticQualityV4ArtifactKind, type SemanticQualityV4ArtifactReceipt } from
  "./canonical-execution-artifact-validation.js";
import { readProductionCanonicalArtifact } from
  "./production-canonical-execution-evidence.js";
import { decodeQualificationQuestionOutcome } from
  "./execute-admitted-qualification-question.js";
import type { MainCanonicalEvidenceProjection, MainCanonicalEvidenceVerificationPort,
  QualificationScopeTopology, QualificationScopeTopologyPort } from "./production-ports.js";
import { attemptIdentity } from "./execution.js";

const REQUIRED_V1_KINDS = Object.freeze(["capability_request", "capability_response",
  "retrieval_request", "retrieval_response", "retrieval_observation", "scope_resolution_observation",
  "answer_normalized_outcome"] as const satisfies readonly SemanticQualityV4ArtifactKind[]);

/** Read-only authentication of artifacts emitted by the installed main canonical SDK chain. */
export function createProductionLocalCanonicalEvidenceReader(input: { readonly artifactKey: Uint8Array;
  readonly artifactKeyId: string; readonly artifactRoot: string;
  readonly topology?: QualificationScopeTopologyPort | (() => Promise<QualificationScopeTopologyPort>) }):
MainCanonicalEvidenceVerificationPort {
  if (input.artifactKey.byteLength !== 32 || input.artifactKeyId.trim() === "") {
    throw new Error("canonical artifact key is invalid");
  }
  const key = new Uint8Array(input.artifactKey);
  let topologyAdmission: Promise<QualificationScopeTopologyPort> | undefined;
  return Object.freeze({ project: async (projection: Parameters<
    MainCanonicalEvidenceVerificationPort["project"]>[0]) => {
    return Object.freeze({ ...projection, topology: null, diagnosticCustody: null });
  }, readScopeObservation: async (identity: Parameters<
    MainCanonicalEvidenceVerificationPort["readScopeObservation"]>[0]) => {
    const opened = await readProductionCanonicalArtifact({ artifactKey: key,
      artifactKeyId: input.artifactKeyId, artifactRoot: input.artifactRoot,
      attemptId: identity.attemptId, kind: "scope_resolution_observation",
      rootBindingSha256: identity.campaignRootSha256 });
    return Object.freeze({ observation: decodeScopeObservation(opened.plaintext), receipt: opened.receipt });
  }, verify: async (verification: Parameters<
    MainCanonicalEvidenceVerificationPort["verify"]>[0]) => {
    const { attempts, campaignRootSha256 } = verification;
    digest(campaignRootSha256, "local canonical evidence campaign root");
    if (attempts.length === 0 || new Set(attempts.map(({ attemptId }) => attemptId)).size !==
      attempts.length || attempts.some((attempt) => attempt.campaignRootSha256 !==
        campaignRootSha256)) {
      throw new Error("local canonical evidence inventory is empty, duplicated, or foreign");
    }
    const receipts = (await mapBounded(attempts, 8, async (attempt) =>
      await verifyAttempt(input.artifactRoot, key, input.artifactKeyId, attempt, async () => {
        if (input.topology === undefined) {
          throw new Error("canonical evidence topology admission is unavailable");
        }
        topologyAdmission ??= typeof input.topology === "function" ? input.topology() :
          Promise.resolve(input.topology);
        const packet = attempt.executionPacket;
        return await (await topologyAdmission).resolve(packet.scopeTopologyReference,
          packet.questionId, packet.schemaVersion ===
            "meeting_knowledge.qualification_execution_packet.v2" ? {
              topologyDocumentSha256: packet.scopeTopologyDocumentSha256,
              topologyGeneration: packet.scopeTopologyGeneration,
            } : undefined);
      })))
      .flat().toSorted(compareReceipt);
    return Object.freeze({ inventorySha256: sha256(receipts) });
  } });
}

async function verifyAttempt(artifactRoot: string, artifactKey: Uint8Array,
  artifactKeyId: string, expected: MainCanonicalEvidenceProjection,
  resolveTopology: () => Promise<QualificationScopeTopology>):
Promise<readonly SemanticQualityV4ArtifactReceipt[]> {
  const opened = new Map<SemanticQualityV4ArtifactKind, Awaited<ReturnType<
    typeof readProductionCanonicalArtifact>>>();
  for (const kind of REQUIRED_V1_KINDS) {
    opened.set(kind, await readProductionCanonicalArtifact({ artifactKey, artifactKeyId, artifactRoot,
      attemptId: expected.attemptId, kind, rootBindingSha256: expected.campaignRootSha256 }));
  }
  const bytes = (kind: typeof REQUIRED_V1_KINDS[number]) => opened.get(kind)!.plaintext;
  decodeScopeObservation(bytes("scope_resolution_observation"));
  const hashes = [
    ["capability request", bytes("capability_request"), expected.capabilityRequestSha256],
    ["capability response", bytes("capability_response"), expected.capabilityResponseSha256],
    ["retrieval request", bytes("retrieval_request"), expected.retrievalRequestSha256],
    ["retrieval response", bytes("retrieval_response"), expected.retrievalResponseSha256],
  ] as const;
  for (const [label, value, expectedHash] of hashes) {
    if (sha256Bytes(value) !== digest(expectedHash, `external ${label}`)) {
      throw new Error(`local canonical ${label} differs from external terminal evidence`);
    }
  }
  const observationValue = parseJson(bytes("retrieval_observation"),
    "canonical retrieval observation");
  if (observationValue === null || typeof observationValue !== "object" ||
    Array.isArray(observationValue)) {
    throw new Error("canonical retrieval observation has an invalid shape");
  }
  const observationVersion = (observationValue as Record<string, unknown>).schemaVersion;
  const observationKeys = observationVersion === "meeting_knowledge.canonical_retrieval_observation.v2"
    ? ["attemptId", "capabilityAndRetrievalLatencyUs", "capabilityBytes", "capabilityRoute",
      "capabilitySemantics", "capabilitySha256", "contractVersion", "requestBytes", "requestSha256",
      "responseBytes", "responseSha256", "retrievalRoute", "routeLatencyUs", "schemaVersion"]
    : ["attemptId", "capabilityAndRetrievalLatencyUs", "capabilityBytes", "capabilitySha256",
      "requestBytes", "requestSha256", "responseBytes", "responseSha256", "routeLatencyUs",
      "schemaVersion"];
  const observationRecord = exactRecord(observationValue, observationKeys,
    "canonical retrieval observation");
  const v3 = observationRecord.schemaVersion ===
    "meeting_knowledge.canonical_retrieval_observation.v2";
  if (observationRecord.attemptId !== expected.attemptId || (!v3 && observationRecord.schemaVersion !==
    "meeting_knowledge.canonical_retrieval_observation.v1")) {
    throw new Error("canonical retrieval observation is foreign");
  }
  if (v3 && (observationRecord.contractVersion !== "context-retrieval.v3" ||
    observationRecord.capabilityRoute !== "/v1/context/retrieve-v3/capability" ||
    observationRecord.retrievalRoute !== "/v1/context/retrieve-v3" ||
    observationRecord.capabilitySemantics !== "bare_descriptor")) {
    throw new Error("canonical V3 retrieval observation is foreign");
  }
  const rawExchange = { capabilityRequestBytes: bytes("capability_request"),
      capabilityResponseBytes: bytes("capability_response"),
      requestBytes: bytes("retrieval_request"), responseBytes: bytes("retrieval_response") };
  const v3Exchange = v3 ? { ...rawExchange, schemaVersion: 2 as const,
    contractVersion: "context-retrieval.v3" as const,
    capabilityRoute: "/v1/context/retrieve-v3/capability" as const,
    retrievalRoute: "/v1/context/retrieve-v3" as const } : null;
  const exchange = v3Exchange ?? rawExchange;
  const commonObservation = { capabilityAndRetrievalLatencyUs: numberField(observationRecord,
      "capabilityAndRetrievalLatencyUs"), capabilityBytes: numberField(observationRecord,
      "capabilityBytes"), capabilitySha256: stringField(observationRecord, "capabilitySha256"),
    requestBytes: numberField(observationRecord, "requestBytes"), requestSha256:
      stringField(observationRecord, "requestSha256"), responseBytes:
      numberField(observationRecord, "responseBytes"), responseSha256:
      stringField(observationRecord, "responseSha256"), routeLatencyUs:
      numberField(observationRecord, "routeLatencyUs") };
  const observation = validateCanonicalRetrievalObservation({ attemptId: expected.attemptId,
    exchange, observation: v3 ? { ...commonObservation, schemaVersion: 2,
      exchangeSource: "exact_transport", contractVersion: "context-retrieval.v3",
      capabilityRoute: "/v1/context/retrieve-v3/capability",
      retrievalRoute: "/v1/context/retrieve-v3" } : commonObservation });
  if (observation.capabilityAndRetrievalLatencyUs !== expected.retrievalLatencyUs) {
    throw new Error("external retrieval latency differs from measured canonical SDK operation");
  }
  const outcome = decodeQualificationQuestionOutcome(JSON.parse(new TextDecoder("utf-8", {
    fatal: true }).decode(bytes("answer_normalized_outcome"))) as unknown);
  assertExactOutcomeRecords(outcome);
  if ((outcome.status === "abstained") !== expected.answerAbstained ||
    (outcome.rawRetrievalResponseSha256 !== observation.responseSha256 &&
      !(outcome.status === "failed" && outcome.rawRetrievalResponseSha256 === null))) {
    throw new Error("normalized canonical outcome differs from external outcome evidence");
  }
  const ranked = outcome.retrievalCandidates.map(({ locatorId }) => locatorId);
  const evidenceLocators = outcome.selectedTurns.map(({ sourceLocatorId }) => sourceLocatorId);
  const turnIds = outcome.selectedTurns.map(({ turnId }) => turnId);
  const byTurn = new Map(outcome.selectedTurns.map((turn) => [turn.turnId, turn.sourceLocatorId]));
  const citationLocators = outcome.citations.map((turnId) => byTurn.get(turnId));
  if (v3) {
    assertExpectedAttempt(expected);
    const topology = Object.freeze({ ...await resolveTopology() });
    const retained = await readProductionCanonicalArtifact({ artifactKey, artifactKeyId, artifactRoot,
      attemptId: expected.attemptId, kind: "retrieval_binding",
      rootBindingSha256: expected.campaignRootSha256 });
    opened.set("retrieval_binding", retained);
    const bindingValue = parseCanonicalCustodyJson(retained.plaintext,
      "canonical retrieval binding") as Record<string, unknown>;
    const diagnosticPlanSha256 = expected.diagnosticCustody === null ? null : custodyDigest({
      plan: expected.diagnosticCustody.frozenPlan,
      remoteDocumentIds: expected.diagnosticCustody.appliedDocumentIds,
    });
    const binding = await validateCanonicalRetrievalBinding(bindingValue, {
      attemptId: expected.attemptId,
      packet: expected.executionPacket,
      topology,
      diagnosticPlanSha256,
      exchange: v3Exchange! });
    if ((binding.providerStatus === "available") !==
        (outcome.rawRetrievalResponseSha256 !== null) ||
      binding.rawCapabilitySha256 !== expected.capabilityResponseSha256 ||
      binding.rawRequestSha256 !== expected.retrievalRequestSha256 ||
      binding.rawResponseSha256 !== expected.retrievalResponseSha256 ||
      custodyJson(binding.candidates) !== custodyJson(outcome.retrievalCandidates)) {
      throw new Error("canonical V3 retrieval binding differs from retained outcome inventory");
    }
    const selectedExpected = outcome.status !== "failed" || outcome.selectedTurns.length > 0;
    if (selectedExpected) {
      await openArtifact(opened, "selected_canonical_turns", expected, artifactRoot,
        artifactKey, artifactKeyId);
      if (canonicalJson(parseJson(opened.get("selected_canonical_turns")!.plaintext,
        "selected canonical turns")) !== canonicalJson(outcome.selectedTurns)) {
        throw new Error("selected canonical turns differ from the normalized outcome");
      }
    }
    const answerInventory = await openAnswerInventory(opened, expected, artifactRoot,
      artifactKey, artifactKeyId);
    const modelRequired = outcome.status === "answered" ||
      outcome.status === "abstained" && outcome.reason !== "zero_admissible_evidence";
    if (modelRequired && !answerInventory.originalPresent ||
      outcome.reason === "zero_admissible_evidence" &&
        (outcome.status !== "abstained" || outcome.selectedTurns.length !== 0 ||
          answerInventory.originalPresent)) {
      throw new Error("canonical V3 answer branch inventory differs from normalized outcome");
    }
    if (answerInventory.originalPresent) {
      await verifyAnswerArtifacts(opened, expected, outcome,
        binding.request.filters.sourceGenerations[0]!.projectionGeneration,
        answerInventory.repairPresent);
    }
    if (knowledgeAnswerExchangeInventorySha256(answerInventory.exchanges) !==
      expected.terminalAnswerResponseSha256) {
      throw new Error("answer exchange inventory differs from external terminal evidence");
    }
    await assertClosedV3ReceiptInventory(artifactRoot, expected.attemptId,
      [...opened.keys()]);
  }
  if (citationLocators.some((value) => value === undefined) ||
    canonicalJson(ranked) !== canonicalJson(expected.rankedLocatorIds) ||
    canonicalJson(evidenceLocators) !== canonicalJson(expected.evidenceLocatorIds) ||
    canonicalJson(turnIds) !== canonicalJson(expected.evidenceTurnIds) ||
    canonicalJson(citationLocators) !== canonicalJson(expected.citationLocatorIds)) {
    throw new Error("canonical outcome locators or turns differ from external evidence");
  }
  return [...opened.values()].map(({ receipt }) => receipt);
}

function assertExpectedAttempt(expected: MainCanonicalEvidenceProjection): void {
  const { attemptId: _attemptId, ...identityInput } = expected.identity;
  const reconstructed = attemptIdentity(identityInput);
  if (reconstructed.attemptId !== expected.attemptId || expected.identity.callKind !== "answer" ||
    expected.identity.callOrdinal !== 0 || expected.identity.questionId !==
      expected.executionPacket.questionId || expected.identity.questionDigestSha256 !==
      canonicalSha256(expected.executionPacket) || expected.executionPacket.locale.trim() === "" ||
    expected.executionPacket.questionText.trim() === "") {
    throw new Error("local canonical attempt differs from independently admitted execution");
  }
}

async function verifyAnswerArtifacts(opened: Map<SemanticQualityV4ArtifactKind, Awaited<ReturnType<
  typeof readProductionCanonicalArtifact>>>, expected: MainCanonicalEvidenceProjection,
  outcome: ReturnType<typeof decodeQualificationQuestionOutcome>, memoryGeneration: string,
  repairPresent: boolean): Promise<void> {
  const artifactBytes = (kind: SemanticQualityV4ArtifactKind) => opened.get(kind)!.plaintext;
  const reconstructed = reconstructAnswerRequest(expected, outcome,
    subscriptionRuntimeTranscriptVersionFromRequestBytes(artifactBytes("answer_original_request")),
    memoryGeneration);
  if (!Buffer.from(serializeSubscriptionRuntimeTaskRequest(reconstructed)).equals(
    artifactBytes("answer_original_request"))) {
    throw new Error("original answer request differs from independently reconstructed evidence");
  }
  assertModelSurface(reconstructed, artifactBytes("answer_original_model_surface"), "original");
  if (canonicalSha256({ effectKind: "answer", request: reconstructed }) !==
    expected.terminalAnswerRequestSha256) {
    throw new Error("original answer request differs from external terminal evidence");
  }
  if (repairPresent) {
    const repairRequest = repairRequestFrom(reconstructed);
    if (!Buffer.from(serializeSubscriptionRuntimeTaskRequest(repairRequest)).equals(
      artifactBytes("answer_repair_request"))) {
      throw new Error("repair answer request is substituted or swapped with original");
    }
    assertModelSurface(repairRequest, artifactBytes("answer_repair_model_surface"), "repair");
  }
}

function reconstructAnswerRequest(expected: MainCanonicalEvidenceProjection,
  outcome: ReturnType<typeof decodeQualificationQuestionOutcome>, transcriptVersion: number,
  memoryGeneration: string) {
  const binding = { canonicalEvidenceHash: canonicalSha256(
      outcome.selectedTurns.map(({ turnHash }) => turnHash)),
    memoryGeneration,
    transcriptVersion };
  const plan = createFocusedRetrievalGroundingPlan({ authorityGeneration: binding.memoryGeneration,
    coverage: "sufficient", humanActorIds: [...new Set(outcome.selectedTurns.map(({ speakerId }) => speakerId))],
    turns: outcome.selectedTurns });
  return buildSubscriptionRuntimeKnowledgeAnswerRequest({ attemptId: expected.attemptId, binding,
    locale: expected.executionPacket.locale, plan, question: expected.executionPacket.questionText }, {
    isolatedCwd: "/run/discord-meeting-subscription-runtime/workspace",
    maxOutputTokens: 2_048, timeoutMs: 180_000 });
}

function assertModelSurface(request: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>,
  retained: Uint8Array,
  label: string): void {
  const expected = [request.task.systemPrompt, request.task.prompt,
    JSON.stringify(request.task.controls.outputSchema)].join("\n");
  if (new TextDecoder("utf-8", { fatal: true }).decode(retained) !== expected) {
    throw new Error(`${label} answer model surface is substituted`);
  }
}

function repairRequestFrom(original: ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest>):
ReturnType<typeof buildSubscriptionRuntimeKnowledgeAnswerRequest> {
  const runId = stableSubscriptionRuntimeId("knowledge-answer-provider-output-repair",
    String(original.runId));
  return { ...original, context: { ...original.context, correlationId: runId }, runId,
    task: { ...original.task, systemPrompt: [original.task.systemPrompt,
      "A previous generation failed strict output validation. Regenerate once from the original supplied question and evidence and obey every schema bound exactly.",
      "In particular, claims=[] with status=answered is forbidden. Decide answerability before emitting claims: for an answerable question populate claims with at least one concise supported claim and its direct evidenceIds, then emit status=answered; otherwise keep claims=[] and emit insufficient_evidence or not_a_question.",
    ].join(" ") } };
}

async function openArtifact(opened: Map<SemanticQualityV4ArtifactKind, Awaited<ReturnType<
  typeof readProductionCanonicalArtifact>>>, kind: SemanticQualityV4ArtifactKind,
  expected: MainCanonicalEvidenceProjection, artifactRoot: string,
  artifactKey: Uint8Array, artifactKeyId: string): Promise<void> {
  opened.set(kind, await readProductionCanonicalArtifact({ artifactKey, artifactKeyId,
    artifactRoot, attemptId: expected.attemptId, kind,
    rootBindingSha256: expected.campaignRootSha256 }));
}

async function openAnswerInventory(opened: Map<SemanticQualityV4ArtifactKind, Awaited<ReturnType<
  typeof readProductionCanonicalArtifact>>>, expected: MainCanonicalEvidenceProjection,
  artifactRoot: string, artifactKey: Uint8Array, artifactKeyId: string) {
  const receiptNames = await readdir(join(artifactRoot, "receipts", expected.attemptId));
  const originalKinds = ["answer_original_model_surface", "answer_original_request",
    "answer_original_response"] as const;
  const repairKinds = ["answer_repair_model_surface", "answer_repair_request",
    "answer_repair_response"] as const;
  const presence = (kinds: readonly SemanticQualityV4ArtifactKind[]) =>
    kinds.map(kind => receiptNames.includes(`${kind}.json`));
  const originalPresence = presence(originalKinds);
  const repairPresence = presence(repairKinds);
  if (new Set(originalPresence).size !== 1 || new Set(repairPresence).size !== 1 ||
    repairPresence[0] === true && originalPresence[0] !== true) {
    throw new Error("answer exchange artifact inventory is incomplete or unordered");
  }
  for (const kind of [...originalKinds, ...repairKinds]) {
    if (receiptNames.includes(`${kind}.json`)) {
      await openArtifact(opened, kind, expected, artifactRoot, artifactKey, artifactKeyId);
    }
  }
  const artifactBytes = (kind: SemanticQualityV4ArtifactKind) => opened.get(kind)!.plaintext;
  const exchanges = originalPresence[0] === true ? [{ callOrdinal: "original" as const,
    requestBytes: artifactBytes("answer_original_request"),
    responseBytes: artifactBytes("answer_original_response") },
    ...(repairPresence[0] === true ? [{ callOrdinal: "repair" as const,
      requestBytes: artifactBytes("answer_repair_request"),
      responseBytes: artifactBytes("answer_repair_response") }] : [])] : [];
  return Object.freeze({ exchanges: Object.freeze(exchanges),
    originalPresent: originalPresence[0] === true, repairPresent: repairPresence[0] === true });
}

async function assertClosedV3ReceiptInventory(artifactRoot: string, attemptId: string,
  kinds: readonly SemanticQualityV4ArtifactKind[]): Promise<void> {
  const actual = (await readdir(join(artifactRoot, "receipts", attemptId))).toSorted();
  const expected = kinds.map(kind => `${kind}.json`).toSorted();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("canonical V3 receipt inventory is incomplete or contains unopened artifacts");
  }
}

function decodeScopeObservation(bytes: Uint8Array) {
  if (bytes.byteLength > 1024) {
    throw new Error("canonical scope resolution observation exceeds its byte bound");
  }
  const scope = validateCanonicalScopeResolutionObservation(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  if (scope.status !== "prepared") {
    throw new Error("canonical scope resolution observation is not prepared");
  }
  return scope;
}

async function mapBounded<T, U>(values: readonly T[], concurrency: number,
  task: (value: T) => Promise<U>): Promise<U[]> {
  const results = Array.from<U>({ length: values.length });
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await task(values[index]!);
    }
  }));
  return results;
}

function assertExactOutcomeRecords(outcome: ReturnType<typeof decodeQualificationQuestionOutcome>): void {
  for (const candidate of outcome.retrievalCandidates) {
    exactRecord(candidate, ["contributions", "fusedScore", "locatorId", "providerRank"],
      "canonical retrieval candidate");
    if (typeof candidate.fusedScore !== "number" || !Number.isFinite(candidate.fusedScore)) {
      throw new Error("canonical retrieval candidate score is invalid");
    }
    for (const contribution of candidate.contributions) {
      exactRecord(contribution, ["contributionScorePicos", "providerLaneId", "providerRank",
        "queryId", "rawScoreKind", "rawScoreValue"], "canonical retrieval contribution");
    }
  }
  for (const turn of outcome.selectedTurns) {
    exactRecord(turn, ["endMs", "sourceLocatorId", "speakerId", "startMs", "text", "turnHash",
      "turnId"], "canonical selected turn");
    if (![turn.endMs, turn.startMs].every(Number.isSafeInteger) || turn.startMs < 0 ||
      turn.endMs < turn.startMs || [turn.sourceLocatorId, turn.speakerId, turn.text, turn.turnHash,
        turn.turnId].some((value) => typeof value !== "string" || value.length === 0)) {
      throw new Error("canonical selected turn is invalid");
    }
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;}
  catch (error) {throw new Error(`${label} is invalid`, { cause: error });}
}
function parseCanonicalCustodyJson(bytes: Uint8Array, label: string): unknown {
  let text: string;
  let value: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
    if (text !== custodyJson(value)) {throw new Error("noncanonical custody plaintext");}
  } catch (error) {throw new Error(`${label} is invalid or noncanonical`, { cause: error });}
  return value;
}
function numberField(record: Readonly<Record<string, unknown>>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") {throw new Error("canonical retrieval observation is invalid");}
  return value;
}
function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {throw new Error("canonical retrieval observation is invalid");}
  return value;
}

function compareReceipt(left: SemanticQualityV4ArtifactReceipt,
  right: SemanticQualityV4ArtifactReceipt): number {
  return left.attemptId.localeCompare(right.attemptId) ||
    left.artifactKind.localeCompare(right.artifactKind);
}
function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
