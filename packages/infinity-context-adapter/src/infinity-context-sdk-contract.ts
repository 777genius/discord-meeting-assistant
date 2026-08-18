import {
  historicalEmbeddingTokenProfile,
  type HistoricalEmbeddingTokenizerPort,
  type HistoricalCandidateLocatorV1,
  type HistoricalDeleteRequestV1,
  type HistoricalIndexPlanV1,
  type HistoricalSearchRequestV1,
  type HistoricalTopologyV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  InfinityContextError,
  type DocumentRecord,
  type InfinityContextCapabilities,
  type InfinityContextClient,
} from "@infinity-context/sdk";

export const CANDIDATE_SOURCE_TYPE = "meeting_evidence_locator";
export const DOCUMENT_SOURCE_TYPE = "meeting_final_human_evidence";
const MAXIMUM_SCOPE_DOCUMENTS = 500;
const acceptedProcessStatuses = new Set([
  "already_indexed_or_pending",
  "indexed",
  "pending",
]);

const CANDIDATE_LOCATOR_PREFIX = "mkcandidate1.";
const MAXIMUM_PROVIDER_ITEMS_MULTIPLIER = 4;
const MAXIMUM_PROVIDER_SOURCE_REFS_PER_ITEM = 16;
const MAXIMUM_QUALIFIED_EMBEDDING_TOKENS = 128;

type HistoricalDeleteRequestInputV1 = Omit<HistoricalDeleteRequestV1, "schemaVersion"> & {
  readonly schemaVersion: number;
};

type HistoricalIndexPlanInputV1 = Omit<HistoricalIndexPlanV1, "schemaVersion"> & {
  readonly schemaVersion: number;
};

type HistoricalSearchRequestInputV1 = Omit<HistoricalSearchRequestV1, "schemaVersion"> & {
  readonly schemaVersion: number;
};

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

export function documentSourceExternalId(document: DocumentRecord): string | null {
  const value = asRecord(document).source_external_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Infinity Context documents are soft-deleted. A successful delete therefore
 * remains readable through `getDocument` with lifecycle status `deleted`.
 * Treating only HTTP 404 as absence would leave every committed deletion in an
 * endless reconciliation loop against the official service.
 */
export function documentIsDeleted(document: DocumentRecord): boolean {
  return asRecord(document).status === "deleted";
}

/** Document lifecycle `status` is not proof that processing was accepted. */
export function processMutationAccepted(document: DocumentRecord): boolean {
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

export function documentId(document: DocumentRecord): string {
  const value = asRecord(document).id;
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new InfinityContextAdapterContractError(
      "official SDK returned an invalid document identity",
    );
  }
  return value;
}

export function isNotFound(error: unknown): boolean {
  return error instanceof InfinityContextError && error.statusCode === 404;
}

export function isMethodNotAllowed(error: unknown): boolean {
  return error instanceof InfinityContextError && error.statusCode === 405;
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
      error instanceof InfinityContextError
        ? error.code
        : error instanceof InfinityContextAdapterContractError
          ? "memory.invalid_sdk_response"
          : "memory.adapter_failure",
    ),
    retryable: error instanceof InfinityContextError
      ? error.retryable
      : !(error instanceof InfinityContextAdapterContractError),
    status,
  };
}

export function isHybridQualified(
  capabilities: InfinityContextCapabilities | null,
  diagnostics: unknown,
): boolean {
  const capabilityValues = asRecord(capabilities);
  const adapters = asRecord(capabilityValues.adapters);
  const qdrant = asRecord(adapters.qdrant);
  const vectorRecallHealthy = Array.isArray(capabilityValues.capabilities) &&
    capabilityValues.capabilities.some((value) => {
      const descriptor = asRecord(value);
      return descriptor.capability === "vector_recall" &&
        descriptor.adapter_name === "qdrant" &&
        descriptor.enabled === true &&
        descriptor.healthy === true &&
        descriptor.status === "ok";
    });
  const values = asRecord(diagnostics);
  const sources = Array.isArray(values.retrieval_sources_used)
    ? values.retrieval_sources_used.filter((value): value is string => typeof value === "string")
    : [];
  const vectorStatus = typeof values.vector_status === "string" ? values.vector_status : "";
  const vectorHealthy = ["available", "healthy", "ok", "ready"].includes(
    vectorStatus.toLowerCase(),
  );
  const lexicalObserved = nonNegativeFinite(values.keyword_chunks_considered) ||
    sources.some((source) => /keyword|lexical|hybrid/iu.test(source));
  const vectorObserved = sources.some((source) => /qdrant|vector|hybrid/iu.test(source)) ||
    nonNegativeFinite(values.vector_candidate_count) ||
    nonNegativeFinite(values.vector_query_count) ||
    nonNegativeFinite(values.vector_search_count);
  return capabilities?.supports_qdrant === true &&
    qdrant.enabled === true &&
    qdrant.healthy === true &&
    qdrant.supports_search === true &&
    vectorRecallHealthy &&
    vectorHealthy &&
    vectorObserved &&
    lexicalObserved &&
    values.retrieval_sources_truncated !== true &&
    values.source_refs_truncated !== true;
}

function nonNegativeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function validIndexPlan(
  request: HistoricalIndexPlanInputV1,
  tokenizer: HistoricalEmbeddingTokenizerPort,
): boolean {
  const candidateLocatorSet = new Set(
    request.documents.map(({ manifest }) => manifest.candidateLocator),
  );
  const documentExternalIds = new Set(
    request.documents.map(({ manifest }) => manifest.documentExternalId),
  );
  const mutationIds = new Set(request.documents.map(({ mutationId }) => mutationId));
  return request.schemaVersion === 1 &&
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
      document.manifest.embeddingTokenProfile ===
        historicalEmbeddingTokenProfile(tokenizer) &&
      document.manifest.embeddingTokenEstimate ===
        tokenizer.countTokens(document.embeddingText) &&
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
}

export function validSearchRequest(request: HistoricalSearchRequestInputV1): boolean {
  return request.schemaVersion === 1 &&
    request.query.trim().length > 0 &&
    new TextEncoder().encode(request.query).byteLength <= 4_096 &&
    boundedString(request.roomScopeExternalRef, 200) &&
    boundedString(request.spaceSlug, 160) &&
    isBoundedInteger(request.candidateLimit, 1, 100) &&
    isBoundedInteger(request.timeoutMs, 1, 60_000);
}

export function validDeleteRequest(request: HistoricalDeleteRequestInputV1): boolean {
  const documentExternalIds = new Set(request.documentExternalIds);
  return request.schemaVersion === 1 &&
    boundedString(request.deleteMutationId, 200) &&
    boundedString(request.topology.roomScopeExternalRef, 200) &&
    boundedString(request.topology.spaceSlug, 160) &&
    boundedString(request.topology.threadExternalRef, 200) &&
    request.documentExternalIds.length <= MAXIMUM_SCOPE_DOCUMENTS &&
    Object.keys(request.remoteDocumentIds).length <= MAXIMUM_SCOPE_DOCUMENTS &&
    request.documentExternalIds.every((value) => boundedString(value, 200)) &&
    Object.entries(request.remoteDocumentIds).every(([externalId, remoteId]) =>
      boundedString(externalId, 200) &&
      boundedString(remoteId, 200) &&
      (request.mode !== "release" || documentExternalIds.has(externalId))
    );
}

export function candidateLocators(
  items: unknown,
  candidateLimit: number,
): readonly HistoricalCandidateLocatorV1[] {
  if (!Array.isArray(items)) {
    throw new InfinityContextAdapterContractError(
      "official SDK returned a malformed search item collection",
    );
  }
  if (items.length > candidateLimit * MAXIMUM_PROVIDER_ITEMS_MULTIPLIER) {
    throw new InfinityContextAdapterContractError(
      "official SDK returned more search items than the qualified bound",
    );
  }
  const signals = new Map<string, {
    readonly providerRank: number;
    readonly providerScore: number;
  }>();
  for (const [providerRank, item] of items.entries()) {
    const { providerScore, sourceRefs } = providerSearchItem(item);
    for (const sourceRefValue of sourceRefs) {
      const sourceRef = asRecord(sourceRefValue);
      const sourceId = sourceRef.source_id;
      if (
        sourceRef.source_type === CANDIDATE_SOURCE_TYPE &&
        typeof sourceId === "string" &&
        sourceId.startsWith(CANDIDATE_LOCATOR_PREFIX) &&
        sourceId.length <= 200
      ) {
        const prior = signals.get(sourceId);
        signals.set(sourceId, prior === undefined
          ? { providerRank, providerScore }
          : {
              providerRank: Math.min(prior.providerRank, providerRank),
              providerScore: Math.max(prior.providerScore, providerScore),
            });
      }
    }
  }
  return Object.freeze(
    [...signals].slice(0, candidateLimit).map(([locator, providerSignals]) =>
      Object.freeze({ locator, ...providerSignals })
    ),
  );
}

function providerSearchItem(item: unknown): {
  readonly providerScore: number;
  readonly sourceRefs: readonly unknown[];
} {
  const providerItem = asRecord(item);
  const itemId = providerItem.item_id;
  const score = providerItem.score;
  if (
    typeof providerItem.item_type !== "string" ||
    typeof itemId !== "string" ||
    itemId.length === 0 ||
    itemId.length > 200 ||
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    !boundedProviderScore(score)
  ) {
    throw new InfinityContextAdapterContractError(
      "official SDK returned a malformed search candidate",
    );
  }
  const sourceRefs = providerItem.source_refs;
  if (
    sourceRefs !== undefined &&
    (!Array.isArray(sourceRefs) ||
      sourceRefs.length > MAXIMUM_PROVIDER_SOURCE_REFS_PER_ITEM)
  ) {
    throw new InfinityContextAdapterContractError(
      "official SDK returned an invalid bounded source-ref collection",
    );
  }
  return { providerScore: score, sourceRefs: sourceRefs ?? [] };
}

function boundedProviderScore(score: number): boolean {
  return score >= -1_000_000 && score <= 1_000_000;
}

export async function listTopologyDocuments(
  client: InfinityContextClient,
  topology: HistoricalTopologyV1,
  signal: AbortSignal,
): Promise<readonly DocumentRecord[]> {
  const response = await client.documents.listScopeDocuments({
    limit: MAXIMUM_SCOPE_DOCUMENTS,
    memoryScopeExternalRef: topology.roomScopeExternalRef,
    signal,
    spaceSlug: topology.spaceSlug,
    threadExternalRef: topology.threadExternalRef,
  });
  if (!Array.isArray(response.data) || response.data.length > MAXIMUM_SCOPE_DOCUMENTS) {
    throw new InfinityContextAdapterContractError(
      "official SDK returned an invalid bounded document collection",
    );
  }
  return response.data;
}

/**
 * The reviewed SDK's scope-document operation has no cursor or total count.
 * A full page therefore cannot prove that an omitted document is absent.
 */
export function topologyDocumentListingProvesCompleteness(
  documents: readonly DocumentRecord[],
): boolean {
  return documents.length < MAXIMUM_SCOPE_DOCUMENTS;
}
