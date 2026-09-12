import { validateFocusedLocatorRetrievalV3Request,
  type FocusedLocatorRetrievalRequestSnapshot, type FocusedLocatorRetrievalV3RequestSnapshot } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { InfinityContextClient, decodeRetrievalV3Capability, retrievalV3RequestPayload,
  type RetrievalV3Capability } from "@infinity-context/sdk";
import { retrievalV3InputFromSnapshot, retrievalV3LocatorCandidates,
  retrievalV3CapabilityFingerprint } from "../infinity-context-retrieval-v3.js";
import type { InfinityContextRetrievalV3ExactExchange } from "../infinity-context-retrieval-exchange.js";
import type { QualificationExecutionPacket, QualificationRetrievalCandidate } from
  "./execute-admitted-qualification-question.js";
import { validateQualificationExecutionPacket } from "./qualification-corpus-packets.js";
import type { DiagnosticQuestion } from "./diagnostic-manifest.js";
import { createHash } from "node:crypto";

import type { SemanticQualityV4ArtifactKind, SemanticQualityV4ArtifactReceipt } from
  "./canonical-metadata-contract.js";
import { canonicalJson, safeId } from "./canonical.js";

export type { SemanticQualityV4ArtifactKind, SemanticQualityV4ArtifactReceipt } from
  "./canonical-metadata-contract.js";
export { validateCanonicalScopeResolutionObservation } from "./canonical-metadata-contract.js";

interface CanonicalRetrievalObservationArtifactCommon {
  readonly attemptId: string;
  readonly capabilityAndRetrievalLatencyUs: number;
  readonly capabilityBytes: number;
  readonly capabilitySha256: string;
  readonly requestBytes: number;
  readonly requestSha256: string;
  readonly responseBytes: number;
  readonly responseSha256: string;
  readonly routeLatencyUs: number;
}

export type CanonicalRetrievalObservationArtifact =
  CanonicalRetrievalObservationArtifactCommon & ({
    readonly schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v1";
  } | {
    readonly schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v2";
    readonly contractVersion: "context-retrieval.v3";
    readonly capabilityRoute: "/v1/context/retrieve-v3/capability";
    readonly retrievalRoute: "/v1/context/retrieve-v3";
    readonly capabilitySemantics: "bare_descriptor";
  });

interface CanonicalRetrievalObservationCommon {
  readonly capabilityAndRetrievalLatencyUs: number;
  readonly capabilityBytes: number;
  readonly capabilitySha256: string;
  readonly requestBytes: number;
  readonly requestSha256: string;
  readonly responseBytes: number;
  readonly responseSha256: string;
  readonly routeLatencyUs: number;
}

type CanonicalRetrievalObservationInput = CanonicalRetrievalObservationCommon & ({
  readonly schemaVersion?: never;
  readonly exchangeSource?: never;
  readonly contractVersion?: never;
  readonly capabilityRoute?: never;
  readonly retrievalRoute?: never;
} | {
  readonly schemaVersion: 2;
  readonly exchangeSource: "exact_transport" | "injected_transport_projection";
  readonly contractVersion: "context-retrieval.v3";
  readonly capabilityRoute: "/v1/context/retrieve-v3/capability";
  readonly retrievalRoute: "/v1/context/retrieve-v3";
});

type CanonicalRetrievalExchangeInput = {
  readonly capabilityRequestBytes: Uint8Array;
  readonly capabilityResponseBytes: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly responseBytes: Uint8Array;
} & ({
  readonly schemaVersion?: never;
  readonly contractVersion?: never;
  readonly capabilityRoute?: never;
  readonly retrievalRoute?: never;
} | {
  readonly schemaVersion: 2;
  readonly contractVersion: "context-retrieval.v3";
  readonly capabilityRoute: "/v1/context/retrieve-v3/capability";
  readonly retrievalRoute: "/v1/context/retrieve-v3";
});

export interface SemanticQualityV4ArtifactEnvelope {
  readonly algorithm: "A256GCM";
  readonly artifactKind: SemanticQualityV4ArtifactKind;
  readonly attemptId: string;
  readonly ciphertextBase64: string;
  readonly exchangeBindingSha256?: string;
  readonly keyId: string;
  readonly nonceBase64: string;
  readonly plaintextSha256: string;
  readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_artifact_envelope.v1";
  readonly tagBase64: string;
}

const digestPattern = /^[a-f0-9]{64}$/u;
const attemptPattern = /^sqv4-[a-f0-9]{64}$/u;
const artifactKinds = new Set<unknown>([
  "adjudication", "answer", "answer_normalized_outcome", "answer_original_model_surface",
  "answer_original_request", "answer_original_response", "answer_repair_model_surface",
  "answer_repair_request", "answer_repair_response", "capability_request",
  "capability_response", "evidence", "original_model_input", "original_provider_request",
  "original_provider_response", "repair_model_input", "repair_provider_request",
  "repair_provider_response", "raw_outcome", "response_runtime", "retrieval_request",
  "retrieval_response", "retrieval_binding", "scope_resolution_observation", "retrieval_observation", "selected_canonical_turns",
]);

export function validateCanonicalRetrievalObservation(input: {
  readonly attemptId: string;
  readonly exchange: CanonicalRetrievalExchangeInput;
  readonly observation: CanonicalRetrievalObservationInput | null;
}): CanonicalRetrievalObservationArtifact {
  if (input.observation === null) {
    throw new Error("canonical retrieval observation is absent");
  }
  const observation = input.observation;
  const v3 = observation.schemaVersion === 2 || input.exchange.schemaVersion === 2;
  if (v3 && (observation.schemaVersion !== 2 || input.exchange.schemaVersion !== 2 ||
    observation.exchangeSource !== "exact_transport" ||
    [observation, input.exchange].some(value => value.contractVersion !== "context-retrieval.v3" ||
      value.capabilityRoute !== "/v1/context/retrieve-v3/capability" ||
      value.retrievalRoute !== "/v1/context/retrieve-v3") ||
    input.exchange.capabilityRequestBytes.byteLength !== 0)) {
    throw new Error("canonical V3 route or exact transport pairing is invalid");
  }
  if (!attemptPattern.test(input.attemptId)) {
    throw new Error("canonical retrieval observation attempt is invalid");
  }
  if (![observation.capabilityAndRetrievalLatencyUs, observation.routeLatencyUs]
    .every((value) => Number.isSafeInteger(value) && value >= 0) ||
    observation.routeLatencyUs > observation.capabilityAndRetrievalLatencyUs) {
    throw new Error("canonical retrieval observation timing is invalid");
  }
  let canonicalCapabilityBytes: Uint8Array;
  try {
    const descriptor = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.exchange.capabilityResponseBytes),
    ) as unknown;
    if (v3) { decodeRetrievalV3Capability(descriptor); }
    canonicalCapabilityBytes = new TextEncoder().encode(v3 ? custodyJson(descriptor) : canonicalJson(descriptor));
  } catch {
    throw new Error("canonical retrieval observation does not match exact exchange");
  }
  const measured = [
    [observation.capabilityBytes, observation.capabilitySha256, canonicalCapabilityBytes],
    [observation.requestBytes, observation.requestSha256, input.exchange.requestBytes],
    [observation.responseBytes, observation.responseSha256, input.exchange.responseBytes],
  ] as const;
  if (measured.some(([size, expectedDigest, bytes]) => !Number.isSafeInteger(size) || size < 0 ||
    size !== bytes.byteLength || !isDigest(expectedDigest) || sha256(bytes) !== expectedDigest)) {
    throw new Error("canonical retrieval observation does not match exact exchange");
  }
  const common = { attemptId: input.attemptId,
    capabilityAndRetrievalLatencyUs: observation.capabilityAndRetrievalLatencyUs,
    capabilityBytes: observation.capabilityBytes,
    capabilitySha256: observation.capabilitySha256,
    requestBytes: observation.requestBytes, requestSha256: observation.requestSha256,
    responseBytes: observation.responseBytes, responseSha256: observation.responseSha256,
    routeLatencyUs: observation.routeLatencyUs };
  return v3 ? Object.freeze({ ...common,
      schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v2" as const,
      contractVersion: "context-retrieval.v3" as const,
      capabilityRoute: "/v1/context/retrieve-v3/capability" as const,
      retrievalRoute: "/v1/context/retrieve-v3" as const,
      capabilitySemantics: "bare_descriptor" as const }) : Object.freeze({ ...common,
      schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v1" as const });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && digestPattern.test(value);
}

function isOptionalDigest(value: unknown): value is string | undefined {
  return value === undefined || isDigest(value);
}

function isArtifactKind(value: unknown): value is SemanticQualityV4ArtifactKind {
  return artifactKinds.has(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return canonicalJson(Object.keys(record).toSorted()) === canonicalJson([...keys].toSorted());
}

function isArtifactEnvelopeRecord(record: Record<string, unknown>): boolean {
  const keys = ["algorithm", "artifactKind", "attemptId", "ciphertextBase64", "keyId",
    "nonceBase64", "plaintextSha256", "rootBindingSha256", "schemaVersion", "tagBase64",
    ...(record.exchangeBindingSha256 === undefined ? [] : ["exchangeBindingSha256"])];
  return hasExactKeys(record, keys) && record.algorithm === "A256GCM" &&
    record.schemaVersion === "meeting_knowledge.semantic_quality_artifact_envelope.v1" &&
    isArtifactKind(record.artifactKind) && typeof record.attemptId === "string" &&
    typeof record.ciphertextBase64 === "string" && typeof record.keyId === "string" &&
    typeof record.nonceBase64 === "string" && typeof record.tagBase64 === "string" &&
    isDigest(record.plaintextSha256) && isDigest(record.rootBindingSha256) &&
    isOptionalDigest(record.exchangeBindingSha256);
}

export function decodeArtifactEnvelope(value: unknown): SemanticQualityV4ArtifactEnvelope {
  if (!isPlainRecord(value) || !isArtifactEnvelopeRecord(value)) {
    throw new Error("semantic quality V4 artifact envelope is invalid");
  }
  return value as unknown as SemanticQualityV4ArtifactEnvelope;
}

function isArtifactReceiptRecord(record: Record<string, unknown>): boolean {
  const keys = ["algorithm", "artifactKind", "attemptId", "envelopeSha256", "plaintextSha256",
    "rootBindingSha256", "schemaVersion", "sizeBytes", "storeIdentitySha256",
    ...(record.exchangeBindingSha256 === undefined ? [] : ["exchangeBindingSha256"])];
  return hasExactKeys(record, keys) && record.algorithm === "A256GCM" &&
    record.schemaVersion === "meeting_knowledge.semantic_quality_artifact_receipt.v1" &&
    isArtifactKind(record.artifactKind) && typeof record.attemptId === "string" &&
    attemptPattern.test(record.attemptId) && isDigest(record.envelopeSha256) &&
    isDigest(record.plaintextSha256) && isDigest(record.rootBindingSha256) &&
    isDigest(record.storeIdentitySha256) && Number.isSafeInteger(record.sizeBytes) &&
    isOptionalDigest(record.exchangeBindingSha256) && (record.sizeBytes as number) >= 0 &&
    (record.sizeBytes !== 0 || record.artifactKind === "capability_request");
}

export function validateSemanticQualityV4ArtifactReceipt(
  value: unknown,
): SemanticQualityV4ArtifactReceipt {
  if (!isPlainRecord(value) || !isArtifactReceiptRecord(value)) {
    throw new Error("semantic quality V4 artifact receipt is invalid");
  }
  return value as unknown as SemanticQualityV4ArtifactReceipt;
}

export function assertCanonicalRequest(request: FocusedLocatorRetrievalRequestSnapshot,
  question: string): void {
  if (request.budgets.candidateLimit !== 100 || request.budgets.resultLimit !== 10 ||
    !Object.is(request.budgets.neighborRadius, 0) ||
    request.queries.length !== 1 || question.trim().length === 0) {
    throw new Error("qualification request violates Meeting Knowledge ownership");
  }
  const [originalQuery] = request.queries;
  if (originalQuery === undefined || originalQuery.queryId !== "original-question" ||
    originalQuery.query !== question) {
    throw new Error("qualification request violates Meeting Knowledge ownership");
  }
}

/** Float-preserving UTF-8 key ordering, matching the V3 adapter's candidate preimage. */
export function custodyJson(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) {return item.map(ordered);}
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).toSorted(([a], [b]) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([key, nested]) => [key, ordered(nested)]));
    }
    if (typeof item === "number" && (!Number.isFinite(item) ||
      (Number.isInteger(item) && !Number.isSafeInteger(item)))) {
      throw new Error("non-finite or unsafe-integer custody value");
    }
    if (item === undefined) {throw new Error("undefined custody value");}
    return item;
  }
  return JSON.stringify(ordered(value));
}
export function custodyDigest(value: unknown): string {
  return sha256(new TextEncoder().encode(custodyJson(value)));
}
export function freezeCustody<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {freezeCustody(nested);}
    Object.freeze(value);
  }
  return value;
}

export interface CanonicalRetrievalBindingV1 {
  readonly schemaVersion: "meeting_knowledge.canonical_retrieval_binding.v1";
  readonly attemptId: string;
  readonly packet: QualificationExecutionPacket | DiagnosticQuestion;
  readonly topology: { readonly scopeId: string; readonly roomId: string; readonly currentMeetingId: string };
  readonly diagnosticPlanSha256: string | null;
  readonly request: FocusedLocatorRetrievalV3RequestSnapshot;
  readonly snapshotSha256: string;
  readonly officialPayloadSha256: string;
  readonly rawRequestSha256: string;
  readonly rawResponseSha256: string;
  readonly rawCapabilitySha256: string;
  readonly descriptorSha256: string;
  readonly descriptor: RetrievalV3Capability;
  readonly contractVersion: "context-retrieval.v3";
  readonly capabilityRoute: "/v1/context/retrieve-v3/capability";
  readonly retrievalRoute: "/v1/context/retrieve-v3";
  readonly candidateProjectionSha256: string;
  readonly candidates: readonly QualificationRetrievalCandidate[];
  readonly providerStatus: "available" | "unavailable" | "unqualified" | "invalid_response";
}

/** Replays only retained bytes through official SDK decoding/preflight. No network transport exists. */
export async function createCanonicalRetrievalBinding(input: {
  readonly attemptId: string; readonly packet: QualificationExecutionPacket | DiagnosticQuestion;
  readonly topology: CanonicalRetrievalBindingV1["topology"];
  readonly diagnosticPlanSha256: string | null;
  readonly request: FocusedLocatorRetrievalV3RequestSnapshot;
  readonly exchange: InfinityContextRetrievalV3ExactExchange;
}): Promise<CanonicalRetrievalBindingV1> {
  if (!attemptPattern.test(input.attemptId)) {throw new Error("retrieval binding attempt is invalid");}
  const packet = validateCustodyPacket(input.packet);
  if (!isPlainRecord(input.topology) || !hasExactKeys(input.topology,
    ["scopeId", "roomId", "currentMeetingId"]) ||
    [input.topology.scopeId, input.topology.roomId, input.topology.currentMeetingId]
      .some(value => typeof value !== "string" || value.length === 0) ||
    input.diagnosticPlanSha256 !== null && !/^[a-f0-9]{64}$/u.test(input.diagnosticPlanSha256)) {
    throw new Error("retrieval binding packet or topology is invalid");
  }
  const request = validateFocusedLocatorRetrievalV3Request(input.request);
  assertCanonicalRequest(request, packet.questionText);
  if (request.scope.thread.mode !== "any" ||
    (input.diagnosticPlanSha256 !== null && request.filters.sourceGenerations.length !== 1) ||
    request.budgets.deadlineMs !== 2000 || request.budgets.evidenceByteLimit !== 16000 ||
    request.budgets.responseByteLimit !== 16384) {
    throw new Error("V3 canonical custody requires any-selector, diagnostic single-source, and fixed budgets");
  }
  const exchange = input.exchange;
  if (exchange.schemaVersion !== 2 || exchange.contractVersion !== "context-retrieval.v3" ||
    exchange.capabilityRoute !== "/v1/context/retrieve-v3/capability" ||
    exchange.retrievalRoute !== "/v1/context/retrieve-v3" || exchange.capabilityRequestBytes.byteLength !== 0) {
    throw new Error("V3 retrieval binding route pairing is invalid");
  }
  const sdkInput = retrievalV3InputFromSnapshot(request);
  const payload = retrievalV3RequestPayload(sdkInput);
  const expectedBytes = new TextEncoder().encode(JSON.stringify(payload));
  if (!Buffer.from(expectedBytes).equals(exchange.requestBytes)) {
    throw new Error("V3 raw request is not the official frozen payload");
  }
  // The public SDK lacks a standalone V3 capability byte decoder. This isolated
  // in-memory transport uses its public method, preserving duplicate-key/integer
  // token validation and fingerprint checks without rewriting descriptor bytes.
  const client = new InfinityContextClient({ baseUrl: "https://retained.invalid", retryPolicy: { maxAttempts: 1 },
    transport: { send: async request => {
      if (request.method !== "GET" || request.url.pathname !== exchange.capabilityRoute) {
        throw new Error("retained descriptor decoder cannot issue provider effects");
      }
      return { status: 200, headers: new Headers(), body: new Uint8Array(exchange.capabilityResponseBytes) };
    } } });
  const descriptor = await client.context.retrievalV3Capability({ timeoutMs: 2000 });
  if (descriptor.capability_fingerprint !== request.binding.capabilityFingerprint ||
    descriptor.service_revision !== request.binding.serviceRevision ||
    descriptor.profile_id !== request.binding.profileId ||
    descriptor.index_profile_digest !== request.binding.indexProfileDigest ||
    retrievalV3CapabilityFingerprint(descriptor as unknown as Record<string, unknown>) !== descriptor.capability_fingerprint ||
    custodyJson(descriptor.required_provider_lanes) !== custodyJson(request.binding.requiredProviderLanes) ||
    descriptor.provider_lanes.some(lane => request.binding.requiredProviderLanes.includes(lane.provider_id) &&
      (!lane.healthy || !lane.profile_qualified))) {
    throw new Error("V3 retained descriptor differs from frozen pins");
  }
  const { decodeRetrieveContextV3ResponseBytes } = await import("@infinity-context/sdk");
  let providerStatus: CanonicalRetrievalBindingV1["providerStatus"] = "invalid_response";
  let candidates: readonly QualificationRetrievalCandidate[] = [];
  try {
    const response = decodeRetrieveContextV3ResponseBytes(exchange.responseBytes, payload, descriptor);
    if (response.candidates.some(candidate => !request.filters.sourceGenerations.some(pair =>
      pair.sourceKey === candidate.source_key))) {throw new Error("unadmitted source");}
    providerStatus = response.status;
    if (response.status === "available") {
      candidates = retrievalV3LocatorCandidates(response.candidates, request.binding, custodyDigest(request))
        .map(candidate => ({ locatorId: candidate.locator,
          contributions: candidate.retrievalProvenance.contributions,
          fusedScore: candidate.retrievalProvenance.fusedScore,
          providerRank: candidate.retrievalProvenance.providerRank }));
    }
  } catch { /* Malformed raw bytes remain failed evidence, never an omitted outcome. */ }
  return freezeCustody({ schemaVersion: "meeting_knowledge.canonical_retrieval_binding.v1",
    attemptId: input.attemptId, packet: structuredClone(packet), topology: structuredClone(input.topology),
    diagnosticPlanSha256: input.diagnosticPlanSha256, request,
    snapshotSha256: custodyDigest(request), officialPayloadSha256: custodyDigest(payload),
    rawRequestSha256: sha256(exchange.requestBytes), rawResponseSha256: sha256(exchange.responseBytes),
    rawCapabilitySha256: sha256(exchange.capabilityResponseBytes), descriptorSha256: custodyDigest(descriptor),
    descriptor, contractVersion: "context-retrieval.v3", capabilityRoute: exchange.capabilityRoute,
    retrievalRoute: exchange.retrievalRoute, candidateProjectionSha256: custodyDigest(candidates),
    candidates, providerStatus });
}

/** Exact-key reconstruction rejects a re-signed projection unless every retained byte agrees. */
export async function validateCanonicalRetrievalBinding(value: unknown, expected: {
  readonly attemptId: string; readonly packet: QualificationExecutionPacket | DiagnosticQuestion;
  readonly topology: CanonicalRetrievalBindingV1["topology"];
  readonly diagnosticPlanSha256: string | null;
  readonly exchange: InfinityContextRetrievalV3ExactExchange;
}): Promise<CanonicalRetrievalBindingV1> {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["schemaVersion", "attemptId", "packet", "topology",
    "diagnosticPlanSha256", "request", "snapshotSha256", "officialPayloadSha256", "rawRequestSha256",
    "rawResponseSha256", "rawCapabilitySha256", "descriptorSha256", "descriptor", "contractVersion",
    "capabilityRoute", "retrievalRoute", "candidateProjectionSha256", "candidates", "providerStatus"])) {
    throw new Error("retrieval binding has an invalid shape");
  }
  const reconstructed = await createCanonicalRetrievalBinding({ ...expected,
    request: validateFocusedLocatorRetrievalV3Request(value.request) });
  if (custodyJson(value) !== custodyJson(reconstructed)) {
    throw new Error("retrieval binding is substituted or inconsistent with retained bytes");
  }
  return reconstructed;
}

function validateCustodyPacket(value: QualificationExecutionPacket | DiagnosticQuestion):
QualificationExecutionPacket | DiagnosticQuestion {
  if ("source" in value) {return validateQualificationExecutionPacket(value);}
  if (!isPlainRecord(value) || !hasExactKeys(value,
    ["locale", "questionId", "questionText", "scopeTopologyReference"]) ||
    !["en", "mixed", "ru"].includes(String(value.locale)) ||
    [value.questionId, value.questionText, value.scopeTopologyReference]
      .some(item => typeof item !== "string" || item.length === 0) ||
    Buffer.byteLength(String(value.questionText), "utf8") > 8000) {
    throw new Error("diagnostic retrieval binding packet is invalid");
  }
  return Object.freeze({ locale: value.locale as DiagnosticQuestion["locale"],
    questionId: safeId(value.questionId, "diagnostic custody question"),
    questionText: String(value.questionText), scopeTopologyReference:
      safeId(value.scopeTopologyReference, "diagnostic custody scope reference") });
}
