import {
  validateHistoricalReleaseBinding,
  type HistoricalReleaseBindingV1,
} from "../domain/historical-evidence.js";
import type {
  HistoricalBlockManifestV1,
  HistoricalIndexDocumentV1,
  HistoricalIndexPlanV1,
  HistoricalTurnSourceV1,
  HistoricalTopologyV1,
} from "./ports/historical-memory.js";
import type {
  CoverageExtractV1,
  CoverageReductionV1,
  CoverageSelectedTurnV1,
} from "./ports/historical-grounding.js";
import { estimateHistoricalEmbeddingTokens } from "./historical-embedding-windows.js";

export class HistoricalContractCodecError extends Error {
  public override readonly name = "HistoricalContractCodecError";
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HistoricalContractCodecError(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function exactFields(
  input: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  field: string,
): void {
  const names = new Set(allowed);
  if (Object.keys(input).some((name) => !names.has(name))) {
    throw new HistoricalContractCodecError(`${field} contains an unknown field`);
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HistoricalContractCodecError(`${field} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new HistoricalContractCodecError(`${field} must be a safe integer`);
  }
  return value;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new HistoricalContractCodecError(`${field} must be an array`);
  }
  return Object.freeze(value.map((item, index) => string(item, `${field}[${index}]`)));
}

export function decodeHistoricalReleaseBindingV1(
  value: unknown,
): HistoricalReleaseBindingV1 {
  const input = record(value, "binding");
  exactFields(input, [
    "acceptedMeetingRevision",
    "desiredGeneration",
    "evidencePolicyVersion",
    "meetingId",
    "releaseId",
    "roomId",
    "schemaVersion",
    "scopeId",
    "transcriptId",
    "transcriptVersion",
  ], "binding");
  const binding = {
    acceptedMeetingRevision: integer(
      input.acceptedMeetingRevision,
      "binding.acceptedMeetingRevision",
      0,
    ),
    desiredGeneration: integer(input.desiredGeneration, "binding.desiredGeneration", 1),
    evidencePolicyVersion: string(
      input.evidencePolicyVersion,
      "binding.evidencePolicyVersion",
    ),
    meetingId: string(input.meetingId, "binding.meetingId"),
    releaseId: string(input.releaseId, "binding.releaseId"),
    roomId: string(input.roomId, "binding.roomId"),
    schemaVersion: integer(input.schemaVersion, "binding.schemaVersion", 1),
    scopeId: string(input.scopeId, "binding.scopeId"),
    transcriptId: string(input.transcriptId, "binding.transcriptId"),
    transcriptVersion: integer(input.transcriptVersion, "binding.transcriptVersion", 1),
  } as HistoricalReleaseBindingV1;
  return validateHistoricalReleaseBinding(binding);
}

function decodeTopology(value: unknown): HistoricalTopologyV1 {
  const input = record(value, "plan.topology");
  exactFields(input, [
    "indexGeneration",
    "releaseRef",
    "roomScopeExternalRef",
    "spaceSlug",
    "threadExternalRef",
  ], "plan.topology");
  return Object.freeze({
    indexGeneration: string(input.indexGeneration, "plan.topology.indexGeneration"),
    releaseRef: string(input.releaseRef, "plan.topology.releaseRef"),
    roomScopeExternalRef: string(
      input.roomScopeExternalRef,
      "plan.topology.roomScopeExternalRef",
    ),
    spaceSlug: string(input.spaceSlug, "plan.topology.spaceSlug"),
    threadExternalRef: string(
      input.threadExternalRef,
      "plan.topology.threadExternalRef",
    ),
  });
}

function decodeManifest(value: unknown, ordinal: number): HistoricalBlockManifestV1 {
  const input = record(value, `plan.documents[${ordinal}].manifest`);
  exactFields(input, [
    "candidateLocator",
    "contentHash",
    "documentExternalId",
    "embeddingTokenEstimate",
    "embeddingTokenLimit",
    "embeddingTokenProfile",
    "endMs",
    "indexGeneration",
    "ordinal",
    "startMs",
    "turnSources",
    "turnIds",
  ], `plan.documents[${ordinal}].manifest`);
  const manifestOrdinal = integer(input.ordinal, "manifest.ordinal", 0);
  if (manifestOrdinal !== ordinal) {
    throw new HistoricalContractCodecError("historical block ordinals must be contiguous");
  }
  return Object.freeze({
    candidateLocator: string(input.candidateLocator, "manifest.candidateLocator"),
    contentHash: string(input.contentHash, "manifest.contentHash"),
    documentExternalId: string(input.documentExternalId, "manifest.documentExternalId"),
    embeddingTokenEstimate: integer(
      input.embeddingTokenEstimate,
      "manifest.embeddingTokenEstimate",
      1,
    ),
    embeddingTokenLimit: integer(input.embeddingTokenLimit, "manifest.embeddingTokenLimit", 1),
    embeddingTokenProfile: tokenProfile(input.embeddingTokenProfile),
    endMs: integer(input.endMs, "manifest.endMs", 1),
    indexGeneration: string(input.indexGeneration, "manifest.indexGeneration"),
    ordinal: manifestOrdinal,
    startMs: integer(input.startMs, "manifest.startMs", 0),
    turnSources: decodeTurnSources(input.turnSources, ordinal),
    turnIds: stringArray(input.turnIds, "manifest.turnIds"),
  });
}

function tokenProfile(value: unknown): "meeting-knowledge.wordpiece-conservative.v1" {
  if (value !== "meeting-knowledge.wordpiece-conservative.v1") {
    throw new HistoricalContractCodecError("manifest embedding token profile is unsupported");
  }
  return value;
}

function decodeTurnSources(value: unknown, ordinal: number): readonly HistoricalTurnSourceV1[] {
  if (!Array.isArray(value)) {
    throw new HistoricalContractCodecError("manifest.turnSources must be an array");
  }
  return Object.freeze(value.map((item, index) => {
    const field = `plan.documents[${ordinal}].manifest.turnSources[${index}]`;
    const input = record(item, field);
    exactFields(input, [
      "embeddingEndCodePoint",
      "embeddingStartCodePoint",
      "endMs",
      "sourceEndCodePoint",
      "sourceRef",
      "sourceStartCodePoint",
      "speakerId",
      "startMs",
      "turnId",
    ], field);
    return Object.freeze({
      embeddingEndCodePoint: integer(
        input.embeddingEndCodePoint,
        `${field}.embeddingEndCodePoint`,
        1,
      ),
      embeddingStartCodePoint: integer(
        input.embeddingStartCodePoint,
        `${field}.embeddingStartCodePoint`,
        0,
      ),
      endMs: integer(input.endMs, `${field}.endMs`, 1),
      sourceEndCodePoint: integer(input.sourceEndCodePoint, `${field}.sourceEndCodePoint`, 1),
      sourceRef: string(input.sourceRef, `${field}.sourceRef`),
      sourceStartCodePoint: integer(
        input.sourceStartCodePoint,
        `${field}.sourceStartCodePoint`,
        0,
      ),
      speakerId: string(input.speakerId, `${field}.speakerId`),
      startMs: integer(input.startMs, `${field}.startMs`, 0),
      turnId: string(input.turnId, `${field}.turnId`),
    });
  }));
}

function decodeDocument(value: unknown, ordinal: number): HistoricalIndexDocumentV1 {
  const input = record(value, `plan.documents[${ordinal}]`);
  exactFields(input, ["embeddingText", "manifest", "mutationId", "remoteText", "title"],
    `plan.documents[${ordinal}]`);
  const document = Object.freeze({
    embeddingText: string(input.embeddingText, "document.embeddingText"),
    manifest: decodeManifest(input.manifest, ordinal),
    mutationId: string(input.mutationId, "document.mutationId"),
    remoteText: string(input.remoteText, "document.remoteText"),
    title: string(input.title, "document.title"),
  });
  if (!validProjectionMetadata(document)) {
    throw new HistoricalContractCodecError("historical embedding projection is inconsistent");
  }
  return document;
}

function validProjectionMetadata(document: HistoricalIndexDocumentV1): boolean {
  const { manifest } = document;
  const embeddingLength = Array.from(document.embeddingText).length;
  const projectedTurnIds = new Set(manifest.turnSources.map(({ turnId }) => turnId));
  let expectedStart = 0;
  for (const source of manifest.turnSources) {
    if (
      source.embeddingStartCodePoint !== expectedStart ||
      source.embeddingEndCodePoint > embeddingLength
    ) {
      return false;
    }
    expectedStart = source.embeddingEndCodePoint + 1;
  }
  return expectedStart - 1 === embeddingLength &&
    manifest.embeddingTokenEstimate ===
      estimateHistoricalEmbeddingTokens(document.embeddingText) &&
    manifest.turnIds.length === projectedTurnIds.size &&
    manifest.turnIds.every((turnId) => projectedTurnIds.has(turnId));
}

export function decodeHistoricalIndexPlanV1(value: unknown): HistoricalIndexPlanV1 {
  const input = record(value, "plan");
  exactFields(input, [
    "binding",
    "deleteMutationId",
    "documents",
    "indexMutationId",
    "planDigest",
    "schemaVersion",
    "topology",
  ], "plan");
  if (input.schemaVersion !== 1 || !Array.isArray(input.documents)) {
    throw new HistoricalContractCodecError("unsupported historical index plan contract");
  }
  const binding = decodeHistoricalReleaseBindingV1(input.binding);
  const topology = decodeTopology(input.topology);
  const documents = Object.freeze(
    input.documents.map((document, ordinal) => decodeDocument(document, ordinal)),
  );
  if (
    documents.length === 0 ||
    documents.some(({ manifest }) =>
      manifest.indexGeneration !== topology.indexGeneration ||
      manifest.endMs <= manifest.startMs ||
      manifest.turnIds.length === 0 ||
      manifest.turnSources.length === 0 ||
      manifest.embeddingTokenEstimate > manifest.embeddingTokenLimit ||
      manifest.turnSources.some((source) =>
        source.endMs <= source.startMs ||
        source.sourceEndCodePoint <= source.sourceStartCodePoint ||
        source.embeddingEndCodePoint <= source.embeddingStartCodePoint ||
        !manifest.turnIds.includes(source.turnId)
      )
    ) ||
    new Set(documents.map(({ manifest }) => manifest.candidateLocator)).size !== documents.length
  ) {
    throw new HistoricalContractCodecError("historical index plan manifests are inconsistent");
  }
  return Object.freeze({
    binding,
    deleteMutationId: string(input.deleteMutationId, "plan.deleteMutationId"),
    documents,
    indexMutationId: string(input.indexMutationId, "plan.indexMutationId"),
    planDigest: string(input.planDigest, "plan.planDigest"),
    schemaVersion: 1,
    topology,
  });
}

function coveragePayload(
  value: unknown,
  field: string,
): Readonly<Record<string, boolean | number | string | readonly string[]>> {
  const input = record(value, field);
  const output: Record<string, boolean | number | string | readonly string[]> = {};
  for (const [key, item] of Object.entries(input)) {
    if (
      typeof item === "boolean" ||
      typeof item === "number" ||
      typeof item === "string"
    ) {
      output[key] = item;
      continue;
    }
    output[key] = stringArray(item, `${field}.${key}`);
  }
  return Object.freeze(output);
}

export function decodeCoverageExtractV1(value: unknown): CoverageExtractV1 {
  const input = record(value, "coverageExtract");
  exactFields(input, [
    "blockLocator",
    "evidenceLocators",
    "payload",
    "schemaVersion",
    "selectedTurns",
    "selectionStatus",
  ],
    "coverageExtract");
  if (input.schemaVersion !== 1) {
    throw new HistoricalContractCodecError("unsupported coverage extract contract");
  }
  return Object.freeze({
    blockLocator: string(input.blockLocator, "coverageExtract.blockLocator"),
    evidenceLocators: stringArray(
      input.evidenceLocators,
      "coverageExtract.evidenceLocators",
    ),
    payload: coveragePayload(input.payload, "coverageExtract.payload"),
    selectedTurns: coverageSelectedTurns(
      input.selectedTurns,
      "coverageExtract.selectedTurns",
    ),
    selectionStatus: coverageSelectionStatus(
      input.selectionStatus,
      "coverageExtract.selectionStatus",
    ),
    schemaVersion: 1,
  });
}

export function decodeCoverageReductionV1(value: unknown): CoverageReductionV1 {
  const input = record(value, "coverageReduction");
  exactFields(input, [
    "evidenceLocators",
    "payload",
    "schemaVersion",
    "selectedTurns",
    "selectionStatus",
  ],
    "coverageReduction");
  if (input.schemaVersion !== 1) {
    throw new HistoricalContractCodecError("unsupported coverage reduction contract");
  }
  return Object.freeze({
    evidenceLocators: stringArray(
      input.evidenceLocators,
      "coverageReduction.evidenceLocators",
    ),
    payload: coveragePayload(input.payload, "coverageReduction.payload"),
    selectedTurns: coverageSelectedTurns(
      input.selectedTurns,
      "coverageReduction.selectedTurns",
    ),
    selectionStatus: coverageSelectionStatus(
      input.selectionStatus,
      "coverageReduction.selectionStatus",
    ),
    schemaVersion: 1,
  });
}

function coverageSelectedTurns(
  value: unknown,
  field: string,
): readonly CoverageSelectedTurnV1[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new HistoricalContractCodecError(`${field} must be a bounded array`);
  }
  return Object.freeze(value.map((candidate, index) => {
    const selected = record(candidate, `${field}[${index}]`);
    exactFields(selected, ["blockLocator", "relevance", "turnId"], `${field}[${index}]`);
    const relevance = selected.relevance;
    if (!new Set(["conflicting", "context", "direct"]).has(relevance as string)) {
      throw new HistoricalContractCodecError(`${field}[${index}].relevance is unsupported`);
    }
    return Object.freeze({
      blockLocator: string(selected.blockLocator, `${field}[${index}].blockLocator`),
      relevance: relevance as CoverageSelectedTurnV1["relevance"],
      turnId: string(selected.turnId, `${field}[${index}].turnId`),
    });
  }));
}

function coverageSelectionStatus(
  value: unknown,
  field: string,
): "no_match" | "selected" {
  if (value !== "no_match" && value !== "selected") {
    throw new HistoricalContractCodecError(`${field} is unsupported`);
  }
  return value;
}
