import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical.js";

export type SemanticQualityV4ArtifactKind = "adjudication" | "answer" | "evidence" |
  "answer_normalized_outcome" | "answer_original_model_surface" |
  "answer_original_request" | "answer_original_response" | "answer_repair_model_surface" |
  "answer_repair_request" | "answer_repair_response" | "capability_request" |
  "capability_response" |
  "original_model_input" | "original_provider_request" | "original_provider_response" |
  "repair_model_input" | "repair_provider_request" | "repair_provider_response" |
  "raw_outcome" | "response_runtime" | "retrieval_request" | "retrieval_response" |
  "retrieval_observation" | "selected_canonical_turns";

export interface CanonicalRetrievalObservationArtifact {
  readonly attemptId: string;
  readonly capabilityAndRetrievalLatencyUs: number;
  readonly capabilityBytes: number;
  readonly capabilitySha256: string;
  readonly requestBytes: number;
  readonly requestSha256: string;
  readonly responseBytes: number;
  readonly responseSha256: string;
  readonly routeLatencyUs: number;
  readonly schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v1";
}

export interface SemanticQualityV4ArtifactReceipt {
  readonly algorithm: "A256GCM";
  readonly artifactKind: SemanticQualityV4ArtifactKind;
  readonly attemptId: string;
  readonly envelopeSha256: string;
  readonly exchangeBindingSha256?: string;
  readonly plaintextSha256: string;
  readonly rootBindingSha256: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_artifact_receipt.v1";
  readonly sizeBytes: number;
  readonly storeIdentitySha256: string;
}

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
  "retrieval_response", "retrieval_observation", "selected_canonical_turns",
]);

export function validateCanonicalRetrievalObservation(input: {
  readonly attemptId: string;
  readonly exchange: { readonly capabilityRequestBytes: Uint8Array;
    readonly capabilityResponseBytes: Uint8Array; readonly requestBytes: Uint8Array;
    readonly responseBytes: Uint8Array };
  readonly observation: { readonly capabilityAndRetrievalLatencyUs: number;
    readonly capabilityBytes: number; readonly capabilitySha256: string;
    readonly requestBytes: number; readonly requestSha256: string;
    readonly responseBytes: number; readonly responseSha256: string;
    readonly routeLatencyUs: number } | null;
}): CanonicalRetrievalObservationArtifact {
  if (input.observation === null) {
    throw new Error("canonical retrieval observation is absent");
  }
  const observation = input.observation;
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
    canonicalCapabilityBytes = new TextEncoder().encode(canonicalJson(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.exchange.capabilityResponseBytes),
    ) as unknown));
  } catch {
    throw new Error("canonical retrieval observation does not match exact exchange");
  }
  const measured = [
    [observation.capabilityBytes, observation.capabilitySha256, canonicalCapabilityBytes],
    [observation.requestBytes, observation.requestSha256, input.exchange.requestBytes],
    [observation.responseBytes, observation.responseSha256, input.exchange.responseBytes],
  ] as const;
  if (measured.some(([size, digest, bytes]) => !Number.isSafeInteger(size) || size < 0 ||
    size !== bytes.byteLength || !isDigest(digest) || sha256(bytes) !== digest)) {
    throw new Error("canonical retrieval observation does not match exact exchange");
  }
  return Object.freeze({ attemptId: input.attemptId,
    capabilityAndRetrievalLatencyUs: observation.capabilityAndRetrievalLatencyUs,
    capabilityBytes: observation.capabilityBytes,
    capabilitySha256: observation.capabilitySha256,
    requestBytes: observation.requestBytes, requestSha256: observation.requestSha256,
    responseBytes: observation.responseBytes, responseSha256: observation.responseSha256,
    routeLatencyUs: observation.routeLatencyUs,
    schemaVersion: "meeting_knowledge.canonical_retrieval_observation.v1" });
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
