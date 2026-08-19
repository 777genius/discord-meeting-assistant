import type {
  HistoricalIndexPlanV1,
  HistoricalIndexResultV1,
  HistoricalMemoryOperationOptionsV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import type { DocumentRecord, InfinityContextClient } from "@infinity-context/sdk";

import { InfinityOperationDeadline } from "./infinity-request-deadline.js";
import {
  InfinityContextAdapterContractError,
  documentId,
  documentSourceExternalId,
  failure,
  ingestHistoricalDocument,
  processMutationAccepted,
} from "./infinity-context-sdk-contract.js";

const maximumTopologyListEntries = 100;
const maximumParallelDocuments = 4;

type IndexWorkerOutcome =
  | { readonly status: "complete" }
  | { readonly status: "processing_unknown" }
  | { readonly error: Error; readonly sequence: number; readonly status: "failed" };

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
    const indexed = await this.indexDocuments(request);
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
  ): Promise<readonly { readonly externalId: string; readonly remoteId: string }[] | null> {
    const results: ({ readonly externalId: string; readonly remoteId: string } | undefined)[] =
      Array.from({ length: request.documents.length });
    let cursor = 0;
    let failureSequence = 0;
    const coordination = { stopped: false };
    const worker = async (): Promise<IndexWorkerOutcome> => {
      try {
        while (!coordination.stopped) {
          const index = cursor;
          cursor += 1;
          const document = request.documents[index];
          if (document === undefined) { return { status: "complete" }; }
          this.operation.throwIfAborted();
          const remote = await this.ingestOrReconcile(request, document);
          if (documentSourceExternalId(remote) !== document.manifest.documentExternalId) {
            throw new InfinityContextAdapterContractError(
              "official SDK reconciled an index mutation to a conflicting document",
            );
          }
          const remoteId = documentId(remote);
          if (!processMutationAlreadyComplete(remote) &&
            !await this.ensureProcessed(remoteId, document.mutationId)) {
            coordination.stopped = true;
            return { status: "processing_unknown" };
          }
          results[index] = { externalId: document.manifest.documentExternalId, remoteId };
        }
        return { status: "complete" };
      } catch (error) {
        coordination.stopped = true;
        const sequence = failureSequence;
        failureSequence += 1;
        return {
          error: error instanceof Error
            ? error
            : new Error("historical document indexing failed", { cause: error }),
          sequence,
          status: "failed",
        };
      }
    };
    const outcomes = await Promise.all(Array.from(
      { length: Math.min(maximumParallelDocuments, request.documents.length) },
      worker,
    ));
    const failures = outcomes
      .filter((outcome): outcome is Extract<IndexWorkerOutcome, { readonly status: "failed" }> =>
        outcome.status === "failed")
      .toSorted((left, right) => left.sequence - right.sequence);
    if (failures[0] !== undefined) { throw failures[0].error; }
    if (outcomes.some(({ status }) => status === "processing_unknown")) { return null; }
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
  ): Promise<DocumentRecord> {
    try {
      return await this.ingest(request, document);
    } catch (error) {
      this.operation.throwIfAborted();
      return this.ingest(request, document).catch(() => { throw error; });
    }
  }

  private async ingest(
    request: HistoricalIndexPlanV1,
    document: HistoricalIndexPlanV1["documents"][number],
  ): Promise<DocumentRecord> {
    return this.operation.request(this.requestTimeoutMs, (signal) =>
      ingestHistoricalDocument(this.client, request.topology, document, signal)
    );
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

function processMutationAlreadyComplete(document: DocumentRecord): boolean {
  return processMutationAccepted(document) &&
    (document.indexing_status === "indexed" ||
      document.indexing_status === "already_indexed_or_pending");
}

function assertTopologyLookupComplete(values: readonly unknown[], subject: string): void {
  if (values.length === maximumTopologyListEntries) {
    throw new InfinityContextAdapterContractError(
      `official SDK ${subject} listing has no cursor and cannot prove deterministic absence`,
    );
  }
}
