import type {
  HistoricalDeleteRequestV1,
  HistoricalDeleteResultV1,
  HistoricalIndexDocumentV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { InfinityContextClient } from "@infinity-context/sdk";

import { InfinityOperationDeadline } from "./infinity-request-deadline.js";

import {
  InfinityContextAdapterContractError,
  documentId,
  documentIsDeleted,
  documentSourceExternalId,
  failure,
  ingestHistoricalDocument,
  isNotFound,
} from "./infinity-context-sdk-contract.js";

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
    const remoteTargets = releaseRemoteTargets(request, targetExternalIds);
    if (targetExternalIds.size === 0 && remoteTargets.size === 0) {
      return {
        code: "memory.release_delete_has_no_reconciliation_identity",
        retryable: false,
        status: "rejected",
      };
    }
    const alreadyAbsent = new Set<string>();
    for (const [remoteDocumentId, externalId] of remoteTargets) {
      if (await documentAlreadyAbsent(
        client, remoteDocumentId, externalId, requestTimeoutMs, operation,
      )) {
        alreadyAbsent.add(remoteDocumentId);
      }
    }
    for (const externalId of targetExternalIds) {
      if (![...remoteTargets.values()].includes(externalId)) {
        const document = reconciliationDocuments(request).find((candidate) =>
          candidate.manifest.documentExternalId === externalId
        );
        if (document === undefined) {
          return {
            code: "memory.release_delete_has_unresolved_remote_identity",
            retryable: false,
            status: "absence_unverified",
          };
        }
        const recovered = await recoverRemoteTarget(
          client, request, document, requestTimeoutMs, operation,
        );
        bindRemoteTarget(remoteTargets, documentId(recovered), externalId);
      }
    }
    const resolvedExternalIds = new Set<string>();
    for (const [remoteDocumentId, externalId] of remoteTargets) {
      operation.throwIfAborted();
      if (alreadyAbsent.has(remoteDocumentId)) {
        resolvedExternalIds.add(externalId);
        continue;
      }
      resolvedExternalIds.add(externalId);
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
    if ([...targetExternalIds].some((externalId) =>
      !resolvedExternalIds.has(externalId)
    )) {
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

function reconciliationDocuments(
  request: HistoricalDeleteRequestV1,
): readonly HistoricalIndexDocumentV1[] {
  return request.reconciliationDocuments;
}

async function recoverRemoteTarget(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  document: HistoricalIndexDocumentV1,
  requestTimeoutMs: number,
  operation: InfinityOperationDeadline,
) {
  const ingest = () => operation.request(requestTimeoutMs, (signal) =>
    ingestHistoricalDocument(client, request.topology, document, signal)
  );
  let recovered;
  try {
    recovered = await ingest();
  } catch (error) {
    operation.throwIfAborted();
    try {
      recovered = await ingest();
    } catch {
      throw error;
    }
  }
  if (documentSourceExternalId(recovered) !== document.manifest.documentExternalId) {
    throw new InfinityContextAdapterContractError(
      "idempotent delete reconciliation returned a conflicting document",
    );
  }
  return recovered;
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

async function documentAlreadyAbsent(
  client: InfinityContextClient,
  remoteDocumentId: string,
  expectedExternalId: string,
  requestTimeoutMs: number,
  operation: InfinityOperationDeadline,
): Promise<boolean> {
  try {
    const remote = (await operation.request(requestTimeoutMs, (signal) =>
      client.documents.getDocument(remoteDocumentId, { signal })
    )).data;
    if (documentSourceExternalId(remote) !== expectedExternalId) {
      throw new InfinityContextAdapterContractError(
        "stored remote document identity does not match its release document",
      );
    }
    return documentIsDeleted(remote);
  } catch (error) {
    if (isNotFound(error)) {
      return true;
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
    // Thread counters do not prove that source documents disappeared. Verify
    // every locally known document identity through the official SDK and a
    // bounded scope listing before claiming absence.
    return deleteRelease(client, request, requestTimeoutMs, operation);
  } catch (error) {
    return failure(error, "absence_unverified");
  }
}
