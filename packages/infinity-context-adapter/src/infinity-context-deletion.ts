import type {
  HistoricalDeleteRequestV1,
  HistoricalDeleteResultV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { ValueError, type DocumentRecord, type InfinityContextClient } from "@infinity-context/sdk";

import { InfinityOperationDeadline } from "./infinity-request-deadline.js";

import {
  DOCUMENT_SOURCE_TYPE,
  InfinityContextAdapterContractError,
  documentId,
  documentIsDeleted,
  documentSourceExternalId,
  failure,
  isNotFound,
} from "./infinity-context-sdk-contract.js";

const SCOPE_PAGE_LIMIT = 100;
const MAXIMUM_SCOPE_PAGES = 1_000;

interface ScopeDocumentPageInput {
  readonly cursor?: string;
  readonly limit: number;
  readonly memoryScopeExternalRef: string;
  readonly signal: AbortSignal;
  readonly spaceSlug: string;
  readonly status: "active";
  readonly threadExternalRef: string;
}

interface ScopeDocumentPage {
  readonly data: unknown;
  readonly next_cursor?: unknown;
}

interface ScopeDocumentsClient {
  listScopeDocuments(input: ScopeDocumentPageInput): Promise<ScopeDocumentPage>;
}

export function deleteHistoricalMeeting(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  requestTimeoutMs: number,
  operation: InfinityOperationDeadline,
): Promise<HistoricalDeleteResultV1> {
  return request.mode === "meeting"
    ? deleteWholeMeeting(client, request, requestTimeoutMs, operation)
    : deleteRelease(client, request, requestTimeoutMs, operation);
}

async function deleteRelease(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  requestTimeoutMs: number,
  operation: InfinityOperationDeadline,
): Promise<HistoricalDeleteResultV1> {
  try {
    const targetExternalIds = new Set(request.documentExternalIds);
    if (targetExternalIds.size === 0) {
      return {
        code: "memory.release_delete_has_no_reconciliation_identity",
        retryable: false,
        status: "rejected",
      };
    }
    const knownTargets = releaseRemoteTargets(request, targetExternalIds);
    for (const [remoteDocumentId, externalId] of knownTargets) {
      await validateKnownDocumentHint(
        client, remoteDocumentId, externalId, requestTimeoutMs, operation,
      );
    }

    // A known ID is only a hint. The exact-scope list is the authority that
    // prevents a stale or corrupt local binding from deleting a foreign row.
    const remoteTargets = await listActiveRemoteTargets(
      client, request, targetExternalIds, requestTimeoutMs, operation,
    );
    for (const [remoteDocumentId] of remoteTargets) {
      operation.throwIfAborted();
      try {
        await operation.request(requestTimeoutMs, (signal) =>
          client.documents.deleteDocument(remoteDocumentId, {
            headers: { "x-client-mutation-id": request.deleteMutationId },
            signal,
          })
        );
      } catch (error) {
        if (!isNotFound(error) && !await documentIsAbsent(
          client,
          remoteDocumentId,
          requestTimeoutMs,
          operation,
        )) {
          return failure(error, "absence_unverified");
        }
      }
      if (!await documentIsAbsent(
        client,
        remoteDocumentId,
        requestTimeoutMs,
        operation,
      )) {
        return {
          code: "memory.document_still_present",
          retryable: true,
          status: "absence_unverified",
        };
      }
    }

    const remaining = await listActiveRemoteTargets(
      client, request, targetExternalIds, requestTimeoutMs, operation,
    );
    if (remaining.size > 0) {
      return {
        code: "memory.release_document_absence_unresolved",
        retryable: true,
        status: "absence_unverified",
      };
    }
    return { status: "verified_absent" };
  } catch (error) {
    return failure(error, "absence_unverified");
  }
}

async function listActiveRemoteTargets(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  targetExternalIds: ReadonlySet<string>,
  requestTimeoutMs: number,
  operation: InfinityOperationDeadline,
): Promise<Map<string, string>> {
  const documents = client.documents as unknown as ScopeDocumentsClient;
  const targets = new Map<string, string>();
  const seenCursors = new Set<string>();
  const seenDocumentIds = new Set<string>();
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < MAXIMUM_SCOPE_PAGES; pageNumber += 1) {
    let page: ScopeDocumentPage;
    try {
      page = await operation.request(requestTimeoutMs, (signal) =>
        documents.listScopeDocuments({
          ...(cursor === undefined ? {} : { cursor }),
          limit: SCOPE_PAGE_LIMIT,
          memoryScopeExternalRef: request.topology.roomScopeExternalRef,
          signal,
          spaceSlug: request.topology.spaceSlug,
          status: "active",
          threadExternalRef: request.topology.threadExternalRef,
        })
      );
    } catch (error) {
      if (cursor !== undefined && (error instanceof ValueError ||
        (error instanceof Error && error.name === "ValueError"))) {
        throw new InfinityContextAdapterContractError(
          "official SDK rejected a document cursor returned by the provider",
        );
      }
      throw error;
    }
    const remoteDocuments = scopeDocumentRecords(page.data);
    if (remoteDocuments.length > SCOPE_PAGE_LIMIT) {
      throw new InfinityContextAdapterContractError(
        "official SDK returned a malformed or oversized document page",
      );
    }
    for (const remote of remoteDocuments) {
        const remoteId = rememberScopeDocumentId(seenDocumentIds, remote);
      const externalId = documentSourceExternalId(remote);
      const sourceType = documentSourceType(remote);
      if (documentIsDeleted(remote) || asStatus(remote) !== "active") {
        throw new InfinityContextAdapterContractError(
          "active scope listing returned a non-active document",
        );
      }
      if (externalId === null || sourceType === null) {
        throw new InfinityContextAdapterContractError(
          "scope listing returned a document without source identity",
        );
      }
      if (
        targetExternalIds.has(externalId) && sourceType === DOCUMENT_SOURCE_TYPE
      ) {
        bindRemoteTarget(targets, remoteId, externalId);
      }
    }
    const nextCursor = page.next_cursor;
    if (nextCursor === null) {
      return targets;
    }
    if (
      typeof nextCursor !== "string" || nextCursor.length === 0 ||
      remoteDocuments.length === 0 ||
      seenCursors.has(nextCursor)
    ) {
      throw new InfinityContextAdapterContractError(
        "official SDK returned an incomplete document cursor chain",
      );
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new InfinityContextAdapterContractError(
    "official SDK document pagination exceeded its bounded contract",
  );
}

function rememberScopeDocumentId(
  seenDocumentIds: Set<string>,
  remote: DocumentRecord,
): string {
  const remoteId = documentId(remote);
  if (seenDocumentIds.has(remoteId)) {
    throw new InfinityContextAdapterContractError(
      "official SDK repeated a document across cursor pages",
    );
  }
  seenDocumentIds.add(remoteId);
  return remoteId;
}

function scopeDocumentRecords(value: unknown): readonly DocumentRecord[] {
  if (!Array.isArray(value)) {
    throw new InfinityContextAdapterContractError(
      "official SDK returned a malformed document page",
    );
  }
  return value as readonly DocumentRecord[];
}

function asStatus(document: DocumentRecord): string | null {
  const status = (document as Readonly<Record<string, unknown>>).status;
  return typeof status === "string" ? status : null;
}

function documentSourceType(document: DocumentRecord): string | null {
  const sourceType = (document as Readonly<Record<string, unknown>>).source_type;
  return typeof sourceType === "string" && sourceType.length > 0 ? sourceType : null;
}

function releaseRemoteTargets(
  request: HistoricalDeleteRequestV1,
  targetExternalIds: ReadonlySet<string>,
): Map<string, string> {
  const targets = new Map<string, string>();
  for (const [externalId, remoteId] of Object.entries(request.remoteDocumentIds)) {
    if (targetExternalIds.has(externalId)) {
      bindRemoteTarget(targets, remoteId, externalId);
    }
  }
  return targets;
}

async function validateKnownDocumentHint(
  client: InfinityContextClient,
  remoteDocumentId: string,
  expectedExternalId: string,
  requestTimeoutMs: number,
  operation: InfinityOperationDeadline,
): Promise<void> {
  try {
    const remote = (await operation.request(requestTimeoutMs, (signal) =>
      client.documents.getDocument(remoteDocumentId, { signal })
    )).data;
    if (documentId(remote) !== remoteDocumentId) {
      throw new InfinityContextAdapterContractError(
        "official SDK returned a conflicting document identity",
      );
    }
    if (
      documentSourceExternalId(remote) !== expectedExternalId ||
      documentSourceType(remote) !== DOCUMENT_SOURCE_TYPE
    ) {
      return;
    }
    if (!documentIsDeleted(remote) && asStatus(remote) !== "active") {
      throw new InfinityContextAdapterContractError(
        "known document returned an unsupported lifecycle status",
      );
    }
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    throw error;
  }
}

function bindRemoteTarget(
  targets: Map<string, string>,
  remoteDocumentId: string,
  externalId: string,
): void {
  const previous = targets.get(remoteDocumentId);
  if (previous !== undefined && previous !== externalId) {
    throw new InfinityContextAdapterContractError(
      "one remote document identity is bound to conflicting release documents",
    );
  }
  targets.set(remoteDocumentId, externalId);
}

async function documentIsAbsent(
  client: InfinityContextClient,
  remoteDocumentId: string,
  requestTimeoutMs: number,
  operation: InfinityOperationDeadline,
): Promise<boolean> {
  if (remoteDocumentId.length === 0 || remoteDocumentId.length > 200) {
    throw new InfinityContextAdapterContractError(
      "stored remote document identity is outside its bounded contract",
    );
  }
  try {
    const document = (await operation.request(requestTimeoutMs, (signal) =>
      client.documents.getDocument(remoteDocumentId, { signal })
    )).data;
    return documentIsDeleted(document);
  } catch (error) {
    return isNotFound(error);
  }
}

async function deleteWholeMeeting(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  requestTimeoutMs: number,
  operation: InfinityOperationDeadline,
): Promise<HistoricalDeleteResultV1> {
  const scope = (signal: AbortSignal) => ({
    headers: { "x-client-mutation-id": request.deleteMutationId },
    memoryScopeExternalRef: request.topology.roomScopeExternalRef,
    signal,
    spaceSlug: request.topology.spaceSlug,
    threadExternalRef: request.topology.threadExternalRef,
  });
  try {
    await operation.request(requestTimeoutMs, (signal) =>
      client.threadMemory.delete(scope(signal))
    );
  } catch (error) {
    try {
      operation.throwIfAborted();
    } catch {
      return failure(error, "absence_unverified");
    }
    try {
      await operation.request(requestTimeoutMs, (signal) =>
        client.threadMemory.deleteCompat(scope(signal))
      );
    } catch {
      // A committed delete with a lost response is reconciled below.
    }
  }
  try {
    const status = (await operation.request(requestTimeoutMs, (signal) =>
      client.threadMemory.status(scope(signal))
    )).data;
    if (
      status.chunks !== 0 || status.facts !== 0 ||
      status.jobs !== 0 || status.pending_jobs !== 0
    ) {
      return {
        code: "memory.thread_still_present",
        retryable: true,
        status: "absence_unverified",
      };
    }
    // Thread counters do not prove source-document absence. Reconcile every
    // persisted plan identity, then verify each remote ID through GET-by-ID.
    return deleteRelease(client, request, requestTimeoutMs, operation);
  } catch (error) {
    return failure(error, "absence_unverified");
  }
}
