import { digest, exactRecord } from "./canonical.js";

export type SemanticQualityV4ArtifactKind = "adjudication" | "answer" | "evidence" |
  "answer_normalized_outcome" | "answer_original_model_surface" |
  "answer_original_request" | "answer_original_response" | "answer_repair_model_surface" |
  "answer_repair_request" | "answer_repair_response" | "capability_request" |
  "capability_response" |
  "original_model_input" | "original_provider_request" | "original_provider_response" |
  "repair_model_input" | "repair_provider_request" | "repair_provider_response" |
  "raw_outcome" | "response_runtime" | "retrieval_request" | "retrieval_response" | "retrieval_binding" |
  "scope_resolution_observation" | "retrieval_observation" | "selected_canonical_turns";

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

/** Metadata observations retain digests only; provider bodies never enter this artifact. */
export function validateCanonicalScopeResolutionObservation(value: unknown) {
  const record = exactRecord(value, ["reads", "schemaVersion", "status"],
    "canonical scope resolution observation");
  if (record.schemaVersion !== "meeting_knowledge.scope_resolution.v1" ||
    !["prepared", "empty", "unavailable", "interrupted"].includes(String(record.status)) ||
    !Array.isArray(record.reads) || record.reads.length > 2) {
    throw new Error("canonical scope resolution observation is invalid");
  }
  const reads = record.reads.map((readValue: unknown, index: number) => {
    const read = exactRecord(readValue, ["kind", "requestSha256", "responseBytes", "responseSha256",
      "status"], "canonical scope metadata read");
    if (read.kind !== ["scope_spaces", "scope_memory_scopes"][index] ||
      !["received", "failed", "outcome_unknown"].includes(String(read.status)) ||
      !Number.isSafeInteger(read.responseBytes) || Number(read.responseBytes) < 0 ||
      Number(read.responseBytes) > 65_536) {
      throw new Error("canonical scope metadata read is invalid");
    }
    const requestSha256 = digest(read.requestSha256, "scope metadata request");
    const responseSha256 = read.status === "received" ?
      digest(read.responseSha256, "scope metadata response") : null;
    if (read.status !== "received" && (read.responseSha256 !== null || read.responseBytes !== 0)) {
      throw new Error("unknown scope metadata outcome contains response evidence");
    }
    return Object.freeze({ kind: String(read.kind), requestSha256, responseSha256,
      responseBytes: Number(read.responseBytes), status: String(read.status) });
  });
  if (reads.some((read, index) => index < reads.length - 1 && read.status !== "received") ||
    record.status === "prepared" && (reads.length !== 2 ||
      reads.some((read) => read.status !== "received"))) {
    throw new Error("canonical scope resolution observation is incomplete");
  }
  return Object.freeze({ reads: Object.freeze(reads), status: String(record.status),
    schemaVersion: "meeting_knowledge.scope_resolution.v1" as const });
}
