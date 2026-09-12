import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { knowledgeAnswerExchangeInventorySha256 } from
  "@discord-meeting/subscription-runtime-adapter";

import { canonicalJson, digest, exactRecord } from "./canonical.js";
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
import { assertExpectedAttempt, verifyAnswerArtifacts, verifyAnswerRequestIntent } from
  "./canonical-answer-artifact-validation.js";
import { assertCanonicalOutcomeProjection, verifyPreRetrievalFailureProjection } from
  "./canonical-pre-retrieval-artifact-validation.js";

const INITIAL_KINDS = Object.freeze(["scope_resolution_observation",
  "answer_normalized_outcome"] as const satisfies readonly SemanticQualityV4ArtifactKind[]);
const REQUIRED_RETRIEVAL_KINDS = Object.freeze(["capability_request", "capability_response",
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

type OpenedArtifacts = Map<SemanticQualityV4ArtifactKind, Awaited<ReturnType<
  typeof readProductionCanonicalArtifact>>>;

interface AttemptVerificationSource {
  readonly artifactRoot: string;
  readonly artifactKey: Uint8Array;
  readonly artifactKeyId: string;
  readonly expected: MainCanonicalEvidenceProjection;
  readonly resolveTopology: () => Promise<QualificationScopeTopology>;
}

async function verifyAttempt(artifactRoot: string, artifactKey: Uint8Array,
  artifactKeyId: string, expected: MainCanonicalEvidenceProjection,
  resolveTopology: () => Promise<QualificationScopeTopology>):
Promise<readonly SemanticQualityV4ArtifactReceipt[]> {
  const source = { artifactRoot, artifactKey, artifactKeyId, expected, resolveTopology };
  const opened = await openRequiredArtifacts(source);
  const scope = decodeScopeObservation(opened.get("scope_resolution_observation")!.plaintext);
  const outcome = decodeOutcome(opened.get("answer_normalized_outcome")!.plaintext);
  if (scope.status !== "prepared") {
    await verifyPreRetrievalFailure(opened, source, scope, outcome);
    assertCanonicalOutcomeProjection(outcome, expected);
    return [...opened.values()].map(({ receipt }) => receipt);
  }
  for (const kind of REQUIRED_RETRIEVAL_KINDS) {
    if (!opened.has(kind)) {await openArtifact(opened, kind, source);}
  }
  const validated = validateBaseArtifacts(opened, expected, outcome);
  if (validated.v3Exchange !== null) {
    await verifyV3Artifacts(opened, source, validated.outcome, validated.v3Exchange);
  }
  assertCanonicalOutcomeProjection(validated.outcome, expected);
  return [...opened.values()].map(({ receipt }) => receipt);
}

async function openRequiredArtifacts(source: AttemptVerificationSource): Promise<OpenedArtifacts> {
  const opened: OpenedArtifacts = new Map();
  for (const kind of INITIAL_KINDS) {
    await openArtifact(opened, kind, source);
  }
  return opened;
}

async function verifyPreRetrievalFailure(opened: OpenedArtifacts,
  source: AttemptVerificationSource,
  scope: ReturnType<typeof validateCanonicalScopeResolutionObservation>,
  outcome: ReturnType<typeof decodeQualificationQuestionOutcome>): Promise<void> {
  const { expected } = source;
  await verifyPreRetrievalFailureProjection({ expected, outcome,
    resolveTopology: source.resolveTopology, scope });
  await openArtifact(opened, "answer_request_intent", source);
  const intent = verifyAnswerRequestIntent(opened.get("answer_request_intent")!.plaintext,
    expected, outcome, null);
  if (intent.prepared) {
    throw new Error("pre-retrieval failure cannot contain a prepared answer intent");
  }
  if (knowledgeAnswerExchangeInventorySha256([]) !== expected.terminalAnswerResponseSha256) {
    throw new Error("pre-retrieval answer exchange inventory is not empty");
  }
  await assertClosedV3ReceiptInventory(source.artifactRoot, expected.attemptId, [...opened.keys()]);
}

function decodeOutcome(bytes: Uint8Array) {
  const outcome = decodeQualificationQuestionOutcome(parseJson(bytes, "answer normalized outcome"));
  assertExactOutcomeRecords(outcome);
  return outcome;
}

function validateBaseArtifacts(opened: OpenedArtifacts,
  expected: MainCanonicalEvidenceProjection,
  outcome: ReturnType<typeof decodeQualificationQuestionOutcome>) {
  const bytes = (kind: typeof REQUIRED_RETRIEVAL_KINDS[number]) => opened.get(kind)!.plaintext;
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
  const { observationRecord, v3 } = parseObservationRecord(
    bytes("retrieval_observation"), expected.attemptId);
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
  if ((outcome.status === "abstained") !== expected.answerAbstained ||
    (outcome.rawRetrievalResponseSha256 !== observation.responseSha256 &&
      !(outcome.status === "failed" && outcome.rawRetrievalResponseSha256 === null))) {
    throw new Error("normalized canonical outcome differs from external outcome evidence");
  }
  return { outcome, v3Exchange };
}

function parseObservationRecord(bytes: Uint8Array, attemptId: string) {
  const value = parseJson(bytes, "canonical retrieval observation");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("canonical retrieval observation has an invalid shape");
  }
  const version = (value as Record<string, unknown>).schemaVersion;
  const keys = version === "meeting_knowledge.canonical_retrieval_observation.v2"
    ? ["attemptId", "capabilityAndRetrievalLatencyUs", "capabilityBytes", "capabilityRoute",
      "capabilitySemantics", "capabilitySha256", "contractVersion", "requestBytes", "requestSha256",
      "responseBytes", "responseSha256", "retrievalRoute", "routeLatencyUs", "schemaVersion"]
    : ["attemptId", "capabilityAndRetrievalLatencyUs", "capabilityBytes", "capabilitySha256",
      "requestBytes", "requestSha256", "responseBytes", "responseSha256", "routeLatencyUs",
      "schemaVersion"];
  const observationRecord = exactRecord(value, keys, "canonical retrieval observation");
  const v3 = observationRecord.schemaVersion ===
    "meeting_knowledge.canonical_retrieval_observation.v2";
  if (observationRecord.attemptId !== attemptId || !v3 && observationRecord.schemaVersion !==
    "meeting_knowledge.canonical_retrieval_observation.v1") {
    throw new Error("canonical retrieval observation is foreign");
  }
  if (v3 && (observationRecord.contractVersion !== "context-retrieval.v3" ||
    observationRecord.capabilityRoute !== "/v1/context/retrieve-v3/capability" ||
    observationRecord.retrievalRoute !== "/v1/context/retrieve-v3" ||
    observationRecord.capabilitySemantics !== "bare_descriptor")) {
    throw new Error("canonical V3 retrieval observation is foreign");
  }
  return { observationRecord, v3 };
}

async function verifyV3Artifacts(opened: OpenedArtifacts, source: AttemptVerificationSource,
  outcome: ReturnType<typeof decodeQualificationQuestionOutcome>,
  v3Exchange: NonNullable<ReturnType<typeof validateBaseArtifacts>["v3Exchange"]>): Promise<void> {
  const { expected } = source;
  assertExpectedAttempt(expected);
  const topology = Object.freeze({ ...await source.resolveTopology() });
  await openArtifact(opened, "retrieval_binding", source);
  const bindingValue = parseCanonicalCustodyJson(opened.get("retrieval_binding")!.plaintext,
    "canonical retrieval binding") as Record<string, unknown>;
  const diagnosticPlanSha256 = expected.diagnosticCustody === null ? null : custodyDigest({
    plan: expected.diagnosticCustody.frozenPlan,
    remoteDocumentIds: expected.diagnosticCustody.appliedDocumentIds,
  });
  const binding = await validateCanonicalRetrievalBinding(bindingValue, {
    attemptId: expected.attemptId, packet: expected.executionPacket, topology,
    diagnosticPlanSha256, exchange: v3Exchange });
  if ((binding.providerStatus === "available") !== (outcome.rawRetrievalResponseSha256 !== null) ||
    binding.rawCapabilitySha256 !== expected.capabilityResponseSha256 ||
    binding.rawRequestSha256 !== expected.retrievalRequestSha256 ||
    binding.rawResponseSha256 !== expected.retrievalResponseSha256 ||
    custodyJson(binding.candidates) !== custodyJson(outcome.retrievalCandidates)) {
    throw new Error("canonical V3 retrieval binding differs from retained outcome inventory");
  }
  const selectedExpected = outcome.status !== "failed" || outcome.selectedTurns.length > 0;
  if (selectedExpected) {
    await openArtifact(opened, "selected_canonical_turns", source);
    if (canonicalJson(parseJson(opened.get("selected_canonical_turns")!.plaintext,
      "selected canonical turns")) !== canonicalJson(outcome.selectedTurns)) {
      throw new Error("selected canonical turns differ from the normalized outcome");
    }
  }
  const answerInventory = await openAnswerInventory(opened, expected, source.artifactRoot,
    source.artifactKey, source.artifactKeyId);
  assertAnswerInventory(outcome, answerInventory.originalPresent);
  await openArtifact(opened, "answer_request_intent", source);
  const answerIntent = verifyAnswerRequestIntent(
    opened.get("answer_request_intent")!.plaintext, expected, outcome,
    binding.request.filters.sourceGenerations[0]!.projectionGeneration);
  if (answerIntent.prepared !== (outcome.selectedTurns.length > 0)) {
    throw new Error("answer request intent differs from the normalized branch");
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
  await assertClosedV3ReceiptInventory(source.artifactRoot, expected.attemptId, [...opened.keys()]);
}

function assertAnswerInventory(outcome: ReturnType<typeof decodeQualificationQuestionOutcome>,
  originalPresent: boolean): void {
  const modelRequired = outcome.status === "answered" ||
    outcome.status === "abstained" && outcome.reason !== "zero_admissible_evidence";
  if (modelRequired && !originalPresent || outcome.reason === "zero_admissible_evidence" &&
    (outcome.status !== "abstained" || outcome.selectedTurns.length !== 0 || originalPresent)) {
    throw new Error("canonical V3 answer branch inventory differs from normalized outcome");
  }
}

async function openArtifact(opened: Map<SemanticQualityV4ArtifactKind, Awaited<ReturnType<
  typeof readProductionCanonicalArtifact>>>, kind: SemanticQualityV4ArtifactKind,
  source: { readonly expected: MainCanonicalEvidenceProjection; readonly artifactRoot: string;
    readonly artifactKey: Uint8Array; readonly artifactKeyId: string }): Promise<void> {
  opened.set(kind, await readProductionCanonicalArtifact({ artifactKey: source.artifactKey,
    artifactKeyId: source.artifactKeyId, artifactRoot: source.artifactRoot,
    attemptId: source.expected.attemptId, kind,
    rootBindingSha256: source.expected.campaignRootSha256 }));
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
      await openArtifact(opened, kind, { expected, artifactRoot, artifactKey, artifactKeyId });
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
  return validateCanonicalScopeResolutionObservation(JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
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
