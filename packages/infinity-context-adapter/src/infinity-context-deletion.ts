import type {
  HistoricalDeleteRequestV1,
  HistoricalDeleteResultV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { InfinityContextClient } from "@infinity-context/sdk";

import {
  InfinityContextAdapterContractError,
  documentId,
  documentIsDeleted,
  documentSourceExternalId,
  failure,
  isMethodNotAllowed,
  isNotFound,
  listTopologyDocuments,
  topologyDocumentListingProvesCompleteness,
} from "./infinity-context-sdk-contract.js";

export function deleteHistoricalMeeting(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  requestTimeoutMs: number,
): Promise<HistoricalDeleteResultV1> {
  return request.mode === "meeting"
    ? deleteWholeMeeting(client, request, requestTimeoutMs)
    : deleteRelease(client, request, requestTimeoutMs);
}

async function deleteRelease(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  requestTimeoutMs: number,
): Promise<HistoricalDeleteResultV1> {
  try {
    const signal = AbortSignal.timeout(requestTimeoutMs);
    const targetExternalIds = new Set(request.documentExternalIds);
    const remoteTargets = releaseRemoteTargets(request, targetExternalIds);
    if (targetExternalIds.size === 0 && remoteTargets.size === 0) {
      return {
        code: "memory.release_delete_has_no_reconciliation_identity",
        retryable: false,
        status: "rejected",
      };
    }
    const discovered = await listDocumentsWhenSupported(client, request, signal);
    bindDiscoveredReleaseTargets(remoteTargets, targetExternalIds, discovered);
    const resolvedExternalIds = new Set<string>();
    for (const [remoteDocumentId, externalId] of remoteTargets) {
      signal.throwIfAborted();
      if (await documentAlreadyAbsent(
        client,
        remoteDocumentId,
        externalId,
        signal,
      )) {
        resolvedExternalIds.add(externalId);
        continue;
      }
      resolvedExternalIds.add(externalId);
      try {
        await client.documents.deleteDocument(remoteDocumentId, {
          headers: { "x-client-mutation-id": request.deleteMutationId },
          signal,
        });
      } catch (error) {
        if (!isNotFound(error) && !await documentIsAbsent(client, remoteDocumentId, signal)) {
          return failure(error, "absence_unverified");
        }
      }
      if (!await documentIsAbsent(client, remoteDocumentId, signal)) {
        return {
          code: "memory.document_still_present",
          retryable: true,
          status: "absence_unverified",
        };
      }
    }
    const remaining = await listDocumentsWhenSupported(client, request, signal);
    if (remaining !== null && remaining.some((document) => {
      const sourceExternalId = documentSourceExternalId(document);
      return !documentIsDeleted(document) &&
        sourceExternalId !== null && targetExternalIds.has(sourceExternalId);
    })) {
      return {
        code: "memory.release_document_still_present",
        retryable: true,
        status: "absence_unverified",
      };
    }
    if (remaining === null &&
      [...targetExternalIds].some((externalId) => !resolvedExternalIds.has(externalId))) {
      return {
        code: "memory.scope_document_listing_unsupported_for_unresolved_identity",
        retryable: false,
        status: "absence_unverified",
      };
    }
    if (
      remaining !== null &&
      !topologyDocumentListingProvesCompleteness(remaining) &&
      [...targetExternalIds].some((externalId) => !resolvedExternalIds.has(externalId))
    ) {
      return {
        code: "memory.scope_document_listing_incomplete",
        retryable: true,
        status: "absence_unverified",
      };
    }
    return { status: "verified_absent" };
  } catch (error) {
    return failure(error, "absence_unverified");
  }
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

function bindDiscoveredReleaseTargets(
  targets: Map<string, string>,
  targetExternalIds: ReadonlySet<string>,
  documents: readonly import("@infinity-context/sdk").DocumentRecord[] | null,
): void {
  for (const document of documents ?? []) {
    const sourceExternalId = documentSourceExternalId(document);
    if (sourceExternalId !== null && targetExternalIds.has(sourceExternalId)) {
      bindRemoteTarget(targets, documentId(document), sourceExternalId);
    }
  }
}

async function listDocumentsWhenSupported(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  signal: AbortSignal,
): Promise<readonly import("@infinity-context/sdk").DocumentRecord[] | null> {
  try {
    return await listTopologyDocuments(client, request.topology, signal);
  } catch (error) {
    if (isMethodNotAllowed(error)) {
      return null;
    }
    throw error;
  }
}

async function documentAlreadyAbsent(
  client: InfinityContextClient,
  remoteDocumentId: string,
  expectedExternalId: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const remote = (await client.documents.getDocument(remoteDocumentId, { signal })).data;
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
  signal: AbortSignal,
): Promise<boolean> {
  if (remoteDocumentId.length === 0 || remoteDocumentId.length > 200) {
    throw new InfinityContextAdapterContractError(
      "stored remote document identity is outside its bounded contract",
    );
  }
  try {
    const document = (await client.documents.getDocument(remoteDocumentId, { signal })).data;
    return documentIsDeleted(document);
  } catch (error) {
    return isNotFound(error);
  }
}

async function deleteWholeMeeting(
  client: InfinityContextClient,
  request: HistoricalDeleteRequestV1,
  requestTimeoutMs: number,
): Promise<HistoricalDeleteResultV1> {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const scope = {
    headers: { "x-client-mutation-id": request.deleteMutationId },
    memoryScopeExternalRef: request.topology.roomScopeExternalRef,
    signal,
    spaceSlug: request.topology.spaceSlug,
    threadExternalRef: request.topology.threadExternalRef,
  };
  try {
    await client.threadMemory.delete(scope);
  } catch (error) {
    if (signal.aborted) {
      return failure(error, "absence_unverified");
    }
    try {
      await client.threadMemory.deleteCompat(scope);
    } catch {
      // A committed delete with a lost response is reconciled below.
    }
  }
  try {
    const status = (await client.threadMemory.status(scope)).data;
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
    return deleteRelease(client, request, requestTimeoutMs);
  } catch (error) {
    return failure(error, "absence_unverified");
  }
}
