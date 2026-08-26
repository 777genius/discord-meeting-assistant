import {
  type HistoricalDeleteRequestV1,
  type HistoricalIndexDocumentV1,
  type HistoricalIndexPlanV1,
  type HistoricalTopologyV1,
  HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  InfinityContextError as InfinityContextErrorV1,
  type DocumentRecord,
} from "@infinity-context/sdk";
import {
  InfinityContextError as InfinityContextErrorV2,
  type DocumentRecord as DocumentRecordV2,
  type InfinityContextClient as InfinityContextClientV2,
} from "@infinity-context/sdk-v2";

import {
  historicalRetrievalProjection,
  type HistoricalRetrievalActorKeyMapper,
  validHistoricalRetrievalProjection,
} from "./historical-retrieval-projection.js";

const CANDIDATE_SOURCE_TYPE = "meeting_evidence_locator";
export const DOCUMENT_SOURCE_TYPE = "meeting_final_human_evidence";
const MAXIMUM_SCOPE_DOCUMENTS = 500;
const acceptedProcessStatuses = new Set([
  "already_indexed_or_pending",
  "indexed",
  "pending",
]);

const MAXIMUM_PROVIDER_SOURCE_REFS_PER_ITEM = 16;
const MAXIMUM_QUALIFIED_EMBEDDING_TOKENS = 128;

type HistoricalDeleteRequestInputV1 = Omit<HistoricalDeleteRequestV1, "schemaVersion"> & {
  readonly schemaVersion: number;
};

type HistoricalIndexPlanInputV1 = Omit<HistoricalIndexPlanV1, "schemaVersion"> & {
  readonly schemaVersion: number;
};

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

export function documentSourceExternalId(
  document: DocumentRecord | DocumentRecordV2,
): string | null {
  const value = asRecord(document).source_external_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Infinity Context documents are soft-deleted. A successful delete therefore
 * remains readable through `getDocument` with lifecycle status `deleted`.
 * Treating only HTTP 404 as absence would leave every committed deletion in an
 * endless reconciliation loop against the official service.
 */
export function documentIsDeleted(document: DocumentRecord | DocumentRecordV2): boolean {
  return asRecord(document).status === "deleted";
}

/** Document lifecycle `status` is not proof that processing was accepted. */
export function processMutationAccepted(document: DocumentRecord | DocumentRecordV2): boolean {
  const value = asRecord(document).indexing_status;
  return typeof value === "string" && acceptedProcessStatuses.has(value);
}

export class InfinityContextAdapterContractError extends Error {
  public override readonly name = "InfinityContextAdapterContractError";
}

function safeFailureCode(value: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)
    ? value
    : "memory.unknown_failure";
}

function boundedString(value: string, maximumUtf8Bytes: number): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maximumUtf8Bytes;
}

export function documentId(document: DocumentRecord | DocumentRecordV2): string {
  const value = asRecord(document).id;
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new InfinityContextAdapterContractError(
      "official SDK returned an invalid document identity",
    );
  }
  return value;
}

export async function ingestHistoricalDocument(
  client: InfinityContextClientV2,
  topology: HistoricalTopologyV1,
  document: HistoricalIndexDocumentV1,
  actorKeys: HistoricalRetrievalActorKeyMapper,
  signal: AbortSignal,
): Promise<DocumentRecordV2> {
  return (await client.documents.ingestDocument({
    classification: "internal",
    idempotencyKey: document.mutationId,
    memoryScopeExternalRef: topology.roomScopeExternalRef,
    retrievalProjection: historicalRetrievalProjection(topology, document, actorKeys),
    signal,
    sourceExternalId: document.manifest.documentExternalId,
    sourceRefs: [{
      source_id: document.manifest.candidateLocator,
      source_type: CANDIDATE_SOURCE_TYPE,
    }, ...document.manifest.turnSources.map(({ sourceRef }) => ({
      source_id: sourceRef,
      source_type: "meeting_evidence_turn",
    }))],
    sourceType: DOCUMENT_SOURCE_TYPE,
    spaceSlug: topology.spaceSlug,
    text: document.embeddingText,
    threadExternalRef: topology.threadExternalRef,
    title: document.title,
  })).data;
}

export function isNotFound(error: unknown): boolean {
  return (error instanceof InfinityContextErrorV1 || error instanceof InfinityContextErrorV2) &&
    error.statusCode === 404;
}

export function failure<
  const TStatus extends "absence_unverified" | "outcome_unknown" | "rejected",
>(error: unknown, status: TStatus): {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: TStatus;
} {
  return {
    code: safeFailureCode(
      error instanceof InfinityContextErrorV1 || error instanceof InfinityContextErrorV2
        ? error.code
        : error instanceof InfinityContextAdapterContractError
          ? "memory.invalid_sdk_response"
          : "memory.adapter_failure",
    ),
    retryable: error instanceof InfinityContextErrorV1 || error instanceof InfinityContextErrorV2
      ? error.retryable
      : !(error instanceof InfinityContextAdapterContractError),
    status,
  };
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function validIndexPlan(
  request: HistoricalIndexPlanInputV1,
  expectedTokenProfile: string,
  actorKeys: HistoricalRetrievalActorKeyMapper | undefined,
): boolean {
  if (actorKeys === undefined) {
    return false;
  }
  const candidateLocatorSet = new Set(
    request.documents.map(({ manifest }) => manifest.candidateLocator),
  );
  const documentExternalIds = new Set(
    request.documents.map(({ manifest }) => manifest.documentExternalId),
  );
  const mutationIds = new Set(request.documents.map(({ mutationId }) => mutationId));
  const structurallyValid = request.schemaVersion === 1 &&
    request.topology.projectionContractVersion ===
      HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION &&
    request.documents.length > 0 &&
    request.documents.length <= MAXIMUM_SCOPE_DOCUMENTS &&
    candidateLocatorSet.size === request.documents.length &&
    documentExternalIds.size === request.documents.length &&
    mutationIds.size === request.documents.length &&
    boundedString(request.topology.spaceSlug, 160) &&
    boundedString(request.topology.roomScopeExternalRef, 200) &&
    boundedString(request.topology.threadExternalRef, 200) &&
    request.documents.every((document) =>
      boundedString(document.manifest.candidateLocator, 200) &&
      boundedString(document.manifest.documentExternalId, 200) &&
      document.manifest.embeddingTokenProfile === expectedTokenProfile &&
      isBoundedInteger(document.manifest.embeddingTokenEstimate, 1,
        document.manifest.embeddingTokenLimit) &&
      isBoundedInteger(document.manifest.embeddingTokenLimit, 16,
        MAXIMUM_QUALIFIED_EMBEDDING_TOKENS) &&
      document.manifest.turnSources.length > 0 &&
      document.manifest.turnSources.length < MAXIMUM_PROVIDER_SOURCE_REFS_PER_ITEM &&
      document.manifest.turnSources.every((source) =>
        boundedString(source.sourceRef, 200) &&
        boundedString(source.speakerId, 200) &&
        boundedString(source.turnId, 200) &&
        source.endMs > source.startMs &&
        source.sourceEndCodePoint > source.sourceStartCodePoint &&
        source.embeddingEndCodePoint > source.embeddingStartCodePoint
      ) &&
      boundedString(document.mutationId, 200) &&
      boundedString(document.embeddingText, 4_096) &&
      boundedString(document.remoteText, 32_768) &&
      boundedString(document.title, 200)
    );
  if (!structurallyValid) {
    return false;
  }
  for (const document of request.documents) {
    if (!validHistoricalRetrievalProjection(request.topology, document, actorKeys)) {
      return false;
    }
  }
  return true;
}

export function validDeleteRequest(request: HistoricalDeleteRequestInputV1): boolean {
  const documentExternalIds = new Set(request.documentExternalIds);
  const reconciliationExternalIds = new Set(request.reconciliationDocuments.map(
    ({ manifest }) => manifest.documentExternalId,
  ));
  const mutationIds = new Set(request.reconciliationDocuments.map(
    ({ mutationId }) => mutationId,
  ));
  const ordinals = new Set(request.reconciliationDocuments.map(
    ({ manifest }) => manifest.ordinal,
  ));
  return request.schemaVersion === 1 &&
    boundedString(request.deleteMutationId, 200) &&
    boundedString(request.topology.roomScopeExternalRef, 200) &&
    boundedString(request.topology.spaceSlug, 160) &&
    boundedString(request.topology.threadExternalRef, 200) &&
    request.documentExternalIds.length <= MAXIMUM_SCOPE_DOCUMENTS &&
    Object.keys(request.remoteDocumentIds).length <= MAXIMUM_SCOPE_DOCUMENTS &&
    request.reconciliationDocuments.length <= MAXIMUM_SCOPE_DOCUMENTS &&
    reconciliationExternalIds.size === request.reconciliationDocuments.length &&
    mutationIds.size === request.reconciliationDocuments.length &&
    ordinals.size === request.reconciliationDocuments.length &&
    sameStringSets(documentExternalIds, reconciliationExternalIds) &&
    request.documentExternalIds.every((value) => boundedString(value, 200)) &&
    request.reconciliationDocuments.every((document) =>
      documentExternalIds.has(document.manifest.documentExternalId) &&
      document.manifest.indexGeneration === request.topology.indexGeneration &&
      isBoundedInteger(document.manifest.ordinal, 0, MAXIMUM_SCOPE_DOCUMENTS - 1) &&
      boundedString(document.manifest.candidateLocator, 200) &&
      boundedString(document.manifest.documentExternalId, 200) &&
      boundedString(document.mutationId, 200) &&
      boundedString(document.embeddingText, 4_096) &&
      boundedString(document.title, 200) &&
      document.manifest.turnSources.length > 0 &&
      document.manifest.turnSources.length < MAXIMUM_PROVIDER_SOURCE_REFS_PER_ITEM &&
      document.manifest.turnSources.every(({ sourceRef }) =>
        boundedString(sourceRef, 200)
      )
    ) &&
    Object.entries(request.remoteDocumentIds).every(([externalId, remoteId]) =>
      boundedString(externalId, 200) &&
      boundedString(remoteId, 200) &&
      (request.mode !== "release" || documentExternalIds.has(externalId))
    );
}

function sameStringSets(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}
