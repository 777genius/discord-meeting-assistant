import type {
  HistoricalIndexPlanV1,
  HistoricalIndexResultV1,
  HistoricalMemoryOperationOptionsV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { DocumentRecord, InfinityContextClient } from "@infinity-context/sdk";

import { InfinityOperationDeadline } from "./infinity-request-deadline.js";
import {
  CANDIDATE_SOURCE_TYPE,
  DOCUMENT_SOURCE_TYPE,
  InfinityContextAdapterContractError,
  documentId,
  documentSourceExternalId,
  failure,
  isMethodNotAllowed,
  listTopologyDocuments,
  processMutationAccepted,
} from "./infinity-context-sdk-contract.js";

const maximumTopologyListEntries = 100;
const maximumParallelDocuments = 4;

export async function indexHistoricalMeeting(input: {
  readonly client: InfinityContextClient;
  readonly operationTimeoutMs: number;
  readonly options: HistoricalMemoryOperationOptionsV1;
  readonly request: HistoricalIndexPlanV1;
  readonly requestTimeoutMs: number;
}): Promise<HistoricalIndexResultV1> {
  const operation = new InfinityOperationDeadline(
    input.operationTimeoutMs,
    input.options.signal,
  );
  const indexer = new HistoricalMeetingIndexer(
    input.client,
    input.requestTimeoutMs,
    operation,
  );
  try {
    return await indexer.execute(input.request);
  } catch (error) {
    if (input.options.signal?.aborted === true) {
      return {
        code: "memory.operation_cancelled",
        retryable: true,
        status: "outcome_unknown",
      };
    }
    return failure(error, "outcome_unknown");
  } finally {
    operation.close();
  }
}

class HistoricalMeetingIndexer {
  public constructor(
    private readonly client: InfinityContextClient,
    private readonly requestTimeoutMs: number,
    private readonly operation: InfinityOperationDeadline,
  ) {}

  public async execute(request: HistoricalIndexPlanV1): Promise<HistoricalIndexResultV1> {
    await this.ensureTopology(request);
    let existing: readonly DocumentRecord[] = [];
    try {
      existing = await this.listDocuments(request);
    } catch (error) {
      if (!isMethodNotAllowed(error)) {
        throw error;
      }
    }
    const indexed = await this.indexDocuments(request, existing);
    if (indexed === null) {
      return {
        code: "memory.document_processing_outcome_unknown",
        retryable: true,
        status: "outcome_unknown",
      };
    }
    const remoteDocumentIds = Object.fromEntries(indexed.map(({ externalId, remoteId }) =>
      [externalId, remoteId]
    ));
    return { remoteDocumentIds: Object.freeze(remoteDocumentIds), status: "applied" };
  }

  private async indexDocuments(
    request: HistoricalIndexPlanV1,
    existing: readonly DocumentRecord[],
  ): Promise<readonly { readonly externalId: string; readonly remoteId: string }[] | null> {
    const results: ({ readonly externalId: string; readonly remoteId: string } | undefined)[] =
      Array.from({ length: request.documents.length });
    let cursor = 0;
    let processingUnknown = false;
    let firstError: unknown;
    const worker = async () => {
      try {
        while (true) {
          if (processingUnknown || firstError !== undefined) { return; }
          const index = cursor;
          cursor += 1;
          const document = request.documents[index];
          if (document === undefined) { return; }
          this.operation.throwIfAborted();
          const alreadyProcessed = existing.some((candidate) =>
            documentSourceExternalId(candidate) === document.manifest.documentExternalId &&
            processMutationAccepted(candidate)
          );
          const remote = await this.ingestOrReconcile(request, document, existing);
          if (documentSourceExternalId(remote) !== document.manifest.documentExternalId) {
            throw new InfinityContextAdapterContractError(
              "official SDK reconciled an index mutation to a conflicting document",
            );
          }
          const remoteId = documentId(remote);
          if (!alreadyProcessed &&
            !await this.ensureProcessed(remoteId, document.mutationId)) {
            processingUnknown = true;
            return;
          }
          results[index] = { externalId: document.manifest.documentExternalId, remoteId };
        }
      } catch (error) {
        firstError ??= error;
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(maximumParallelDocuments, request.documents.length) },
      worker,
    ));
    if (firstError !== undefined) { throw firstError; }
    if (processingUnknown) { return null; }
    const complete = results.filter((result): result is NonNullable<typeof result> =>
      result !== undefined
    );
    if (complete.length !== request.documents.length) {
      throw new InfinityContextAdapterContractError("parallel index result is incomplete");
    }
    return Object.freeze(complete);
  }

  private async ingestOrReconcile(
    request: HistoricalIndexPlanV1,
    document: HistoricalIndexPlanV1["documents"][number],
    existing: readonly DocumentRecord[],
  ): Promise<DocumentRecord> {
    const found = existing.find((candidate) =>
      documentSourceExternalId(candidate) === document.manifest.documentExternalId
    );
    if (found !== undefined) {
      return found;
    }
    try {
      return await this.ingest(request, document);
    } catch (error) {
      this.operation.throwIfAborted();
      try {
        return await this.ingest(request, document);
      } catch {
        let reconciled: DocumentRecord | undefined;
        try {
          reconciled = (await this.listDocuments(request)).find((candidate) =>
            documentSourceExternalId(candidate) === document.manifest.documentExternalId
          );
        } catch (listError) {
          if (!isMethodNotAllowed(listError)) {
            throw listError;
          }
        }
        if (reconciled === undefined) {
          throw error;
        }
        return reconciled;
      }
    }
  }

  private async ingest(
    request: HistoricalIndexPlanV1,
    document: HistoricalIndexPlanV1["documents"][number],
  ): Promise<DocumentRecord> {
    return (await this.operation.request(this.requestTimeoutMs, (signal) =>
      this.client.documents.ingestDocument({
        classification: "internal",
        idempotencyKey: document.mutationId,
        memoryScopeExternalRef: request.topology.roomScopeExternalRef,
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
        spaceSlug: request.topology.spaceSlug,
        text: document.embeddingText,
        threadExternalRef: request.topology.threadExternalRef,
        title: document.title,
      })
    )).data;
  }

  private async ensureTopology(request: HistoricalIndexPlanV1): Promise<void> {
    let spaces = await this.listSpaces();
    let space = spaces.find(({ slug }) => slug === request.topology.spaceSlug);
    if (space === undefined) {
      assertTopologyLookupComplete(spaces, "space");
      try {
        space = (await this.operation.request(this.requestTimeoutMs, (signal) =>
          this.client.spaces.createSpace({
            name: request.topology.spaceSlug,
            signal,
            slug: request.topology.spaceSlug,
          })
        )).data;
      } catch (error) {
        this.operation.throwIfAborted();
        spaces = await this.listSpaces();
        space = spaces.find(({ slug }) => slug === request.topology.spaceSlug);
        if (space === undefined) {
          assertTopologyLookupComplete(spaces, "space");
          throw error;
        }
      }
    }
    const spaceId = typeof space.id === "string" ? space.id : "";
    if (spaceId.length === 0 || spaceId.length > 200) {
      throw new InfinityContextAdapterContractError(
        "official SDK returned an invalid space identity",
      );
    }
    let scopes = await this.listMemoryScopes(spaceId);
    if (scopes.some(({ external_ref }) =>
      external_ref === request.topology.roomScopeExternalRef
    )) {
      return;
    }
    assertTopologyLookupComplete(scopes, "memory scope");
    try {
      await this.operation.request(this.requestTimeoutMs, (signal) =>
        this.client.spaces.createMemoryScope({
          externalRef: request.topology.roomScopeExternalRef,
          name: request.topology.roomScopeExternalRef,
          signal,
          spaceId,
        })
      );
    } catch (error) {
      this.operation.throwIfAborted();
      scopes = await this.listMemoryScopes(spaceId);
      if (!scopes.some(({ external_ref }) =>
        external_ref === request.topology.roomScopeExternalRef
      )) {
        assertTopologyLookupComplete(scopes, "memory scope");
        throw error;
      }
    }
  }

  private async listSpaces() {
    const response = await this.operation.request(this.requestTimeoutMs, (signal) =>
      this.client.spaces.listSpaces({ limit: maximumTopologyListEntries, signal })
    );
    if (!Array.isArray(response.data) || response.data.length > maximumTopologyListEntries) {
      throw new InfinityContextAdapterContractError(
        "official SDK returned an invalid bounded space collection",
      );
    }
    return response.data;
  }

  private async listMemoryScopes(spaceId: string) {
    const response = await this.operation.request(this.requestTimeoutMs, (signal) =>
      this.client.spaces.listMemoryScopes({
        limit: maximumTopologyListEntries,
        signal,
        spaceId,
      })
    );
    if (!Array.isArray(response.data) || response.data.length > maximumTopologyListEntries) {
      throw new InfinityContextAdapterContractError(
        "official SDK returned an invalid bounded memory-scope collection",
      );
    }
    return response.data;
  }

  private listDocuments(request: HistoricalIndexPlanV1): Promise<readonly DocumentRecord[]> {
    return this.operation.request(this.requestTimeoutMs, (signal) =>
      listTopologyDocuments(this.client, request.topology, signal)
    );
  }

  private async ensureProcessed(documentIdValue: string, mutationId: string): Promise<boolean> {
    const idempotencyKey = `${mutationId}:process`;
    try {
      const result = await this.process(documentIdValue, idempotencyKey);
      return processMutationAccepted(result);
    } catch {
      try {
        this.operation.throwIfAborted();
        return processMutationAccepted(await this.process(documentIdValue, idempotencyKey));
      } catch {
        return false;
      }
    }
  }

  private async process(documentIdValue: string, idempotencyKey: string) {
    return (await this.operation.request(this.requestTimeoutMs, (signal) =>
      this.client.documents.processDocument(documentIdValue, { idempotencyKey, signal })
    )).data;
  }
}

function assertTopologyLookupComplete(values: readonly unknown[], subject: string): void {
  if (values.length === maximumTopologyListEntries) {
    throw new InfinityContextAdapterContractError(
      `official SDK ${subject} listing has no cursor and cannot prove deterministic absence`,
    );
  }
}
