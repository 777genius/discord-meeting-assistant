import type {
  HistoricalDeleteRequestV1,
  HistoricalDeleteResultV1,
  HistoricalIndexPlanV1,
  HistoricalIndexResultV1,
  HistoricalMemoryPort,
  HistoricalSearchRequestV1,
  HistoricalSearchResultV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  InfinityContextClient,
  ReadScope,
  type DocumentRecord,
  type HttpTransport,
  type InfinityContextCapabilities,
} from "@infinity-context/sdk";

import { deleteHistoricalMeeting } from "./infinity-context-deletion.js";
import {
  CANDIDATE_SOURCE_TYPE,
  DOCUMENT_SOURCE_TYPE,
  InfinityContextAdapterContractError,
  candidateLocators,
  documentId,
  documentSourceExternalId,
  failure,
  isHybridQualified,
  isMethodNotAllowed,
  listTopologyDocuments,
  processMutationAccepted,
  validDeleteRequest,
  validIndexPlan,
  validSearchRequest,
} from "./infinity-context-sdk-contract.js";

const maximumTopologyListEntries = 100;

/* The reviewed Node SDK declaration names this DOM alias in HttpTransport. */
declare global {
  type BodyInit = unknown;
}

export interface InfinityContextHistoricalMemoryConfigV1 {
  readonly baseUrl: string;
  readonly requestTimeoutMs: number;
  readonly schemaVersion: 1;
  readonly token?: string | (() => Promise<string | null | undefined> | string | null | undefined);
  /** Test-only injection still traverses the official SDK request executor. */
  readonly transport?: unknown;
}

type InfinityContextHistoricalMemoryConfigInputV1 = Omit<
  InfinityContextHistoricalMemoryConfigV1,
  "schemaVersion"
> & { readonly schemaVersion: number };

export class InfinityContextHistoricalMemoryAdapter implements HistoricalMemoryPort {
  readonly #client: InfinityContextClient;
  readonly #requestTimeoutMs: number;
  #capabilities: InfinityContextCapabilities | null = null;

  public constructor(config: InfinityContextHistoricalMemoryConfigV1);
  public constructor(config: InfinityContextHistoricalMemoryConfigInputV1) {
    if (
      config.schemaVersion !== 1 ||
      !Number.isSafeInteger(config.requestTimeoutMs) ||
      config.requestTimeoutMs < 1 ||
      config.requestTimeoutMs > 60_000
    ) {
      throw new RangeError("Infinity historical memory configuration is invalid");
    }
    this.#requestTimeoutMs = config.requestTimeoutMs;
    this.#client = new InfinityContextClient({
      baseUrl: config.baseUrl,
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: config.requestTimeoutMs,
      ...(config.token === undefined ? {} : { token: config.token }),
      ...(config.transport === undefined
        ? {}
        : { transport: config.transport as HttpTransport }),
    });
  }

  public async qualifyCapabilities(): Promise<InfinityContextCapabilities> {
    const capabilities = await this.#client.system.capabilities();
    this.#capabilities = capabilities;
    return capabilities;
  }

  private operationSignal(): AbortSignal {
    return AbortSignal.timeout(this.#requestTimeoutMs);
  }

  public async indexFinalMeeting(
    request: HistoricalIndexPlanV1,
  ): Promise<HistoricalIndexResultV1> {
    if (!validIndexPlan(request)) {
      return {
        code: "memory.index_plan_outside_qualified_bounds",
        retryable: false,
        status: "rejected",
      };
    }
    try {
      const signal = this.operationSignal();
      await this.ensureTopology(request, signal);
      let existing: readonly DocumentRecord[] = [];
      try {
        existing = await this.listDocuments(request, signal);
      } catch (error) {
        if (!isMethodNotAllowed(error)) {
          throw error;
        }
      }
      const remoteDocumentIds: Record<string, string> = {};
      for (const document of request.documents) {
        signal.throwIfAborted();
        const remote = await this.ingestOrReconcile(
          request,
          document,
          existing,
          signal,
        );
        if (
          documentSourceExternalId(remote) !==
            document.manifest.documentExternalId
        ) {
          throw new InfinityContextAdapterContractError(
            "official SDK reconciled an index mutation to a conflicting document",
          );
        }
        const remoteId = documentId(remote);
        remoteDocumentIds[document.manifest.documentExternalId] = remoteId;
        const processed = await this.ensureProcessed(
          remoteId,
          document.mutationId,
          signal,
        );
        if (!processed) {
          return {
            code: "memory.document_processing_outcome_unknown",
            retryable: true,
            status: "outcome_unknown",
          };
        }
      }
      return { remoteDocumentIds: Object.freeze(remoteDocumentIds), status: "applied" };
    } catch (error) {
      return failure(error, "outcome_unknown");
    }
  }

  private async ingestOrReconcile(
    request: HistoricalIndexPlanV1,
    document: HistoricalIndexPlanV1["documents"][number],
    existing: readonly DocumentRecord[],
    signal: AbortSignal,
  ): Promise<DocumentRecord> {
    const found = existing.find((candidate) =>
      documentSourceExternalId(candidate) === document.manifest.documentExternalId
    );
    if (found !== undefined) {
      return found;
    }
    try {
      return (await this.#client.documents.ingestDocument({
        classification: "internal",
        idempotencyKey: document.mutationId,
        memoryScopeExternalRef: request.topology.roomScopeExternalRef,
        signal,
        sourceExternalId: document.manifest.documentExternalId,
        sourceRefs: [{
          source_id: document.manifest.candidateLocator,
          source_type: CANDIDATE_SOURCE_TYPE,
        }],
        sourceType: DOCUMENT_SOURCE_TYPE,
        spaceSlug: request.topology.spaceSlug,
        text: document.remoteText,
        threadExternalRef: request.topology.threadExternalRef,
        title: document.title,
      })).data;
    } catch (error) {
      signal.throwIfAborted();
      try {
        const repeated = (await this.#client.documents.ingestDocument({
          classification: "internal",
          idempotencyKey: document.mutationId,
          memoryScopeExternalRef: request.topology.roomScopeExternalRef,
          signal,
          sourceExternalId: document.manifest.documentExternalId,
          sourceRefs: [{
            source_id: document.manifest.candidateLocator,
            source_type: CANDIDATE_SOURCE_TYPE,
          }],
          sourceType: DOCUMENT_SOURCE_TYPE,
          spaceSlug: request.topology.spaceSlug,
          text: document.remoteText,
          threadExternalRef: request.topology.threadExternalRef,
          title: document.title,
        })).data;
        return repeated;
      } catch {
        let reconciled: DocumentRecord | undefined;
        try {
          reconciled = (await this.listDocuments(request, signal)).find((candidate) =>
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

  public async searchRoom(
    request: HistoricalSearchRequestV1,
  ): Promise<HistoricalSearchResultV1> {
    if (!validSearchRequest(request)) {
      return { code: "memory.invalid_search_request", retryable: false, status: "unqualified" };
    }
    try {
      const signal = request.signal ?? this.operationSignal();
      signal.throwIfAborted();
      const response = await this.#client.context.search({
        maxChunks: request.candidateLimit,
        maxEvidenceItems: request.candidateLimit,
        maxFacts: 0,
        query: request.query,
        readScope: ReadScope.external({
          memoryScopeExternalRefs: [request.roomScopeExternalRef],
          spaceSlug: request.spaceSlug,
        }),
        timeoutMs: request.timeoutMs,
        signal,
        tokenBudget: Math.max(256, request.candidateLimit * 64),
      });
      if (!isHybridQualified(this.#capabilities, response.data.diagnostics)) {
        return {
          code: "memory.hybrid_retrieval_not_qualified",
          retryable: false,
          status: "unqualified",
        };
      }
      return {
        candidates: candidateLocators(response.data.items, request.candidateLimit),
        hybridQualified: true,
        status: "available",
      };
    } catch (error) {
      const mapped = failure(error, "outcome_unknown");
      return { code: mapped.code, retryable: mapped.retryable, status: "unavailable" };
    }
  }

  public async deleteMeeting(
    request: HistoricalDeleteRequestV1,
  ): Promise<HistoricalDeleteResultV1> {
    if (!validDeleteRequest(request)) {
      return {
        code: "memory.invalid_delete_request",
        retryable: false,
        status: "rejected",
      };
    }
    return deleteHistoricalMeeting(this.#client, request, this.#requestTimeoutMs);
  }

  private async ensureTopology(
    request: HistoricalIndexPlanV1,
    signal: AbortSignal,
  ): Promise<void> {
    let spaces = await this.listSpaces(signal);
    let space = spaces.find(({ slug }) => slug === request.topology.spaceSlug);
    if (space === undefined) {
      assertTopologyLookupComplete(spaces, "space");
      try {
        space = (await this.#client.spaces.createSpace({
          name: request.topology.spaceSlug,
          signal,
          slug: request.topology.spaceSlug,
        })).data;
      } catch (error) {
        signal.throwIfAborted();
        spaces = await this.listSpaces(signal);
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
    let scopes = await this.listMemoryScopes(spaceId, signal);
    if (!scopes.some(({ external_ref }) =>
      external_ref === request.topology.roomScopeExternalRef
    )) {
      assertTopologyLookupComplete(scopes, "memory scope");
      try {
        await this.#client.spaces.createMemoryScope({
          externalRef: request.topology.roomScopeExternalRef,
          name: request.topology.roomScopeExternalRef,
          signal,
          spaceId,
        });
      } catch (error) {
        signal.throwIfAborted();
        scopes = await this.listMemoryScopes(spaceId, signal);
        if (!scopes.some(({ external_ref }) =>
          external_ref === request.topology.roomScopeExternalRef
        )) {
          assertTopologyLookupComplete(scopes, "memory scope");
          throw error;
        }
      }
    }
  }

  private async listSpaces(signal: AbortSignal) {
    const response = await this.#client.spaces.listSpaces({
      limit: maximumTopologyListEntries,
      signal,
    });
    if (!Array.isArray(response.data) ||
      response.data.length > maximumTopologyListEntries) {
      throw new InfinityContextAdapterContractError(
        "official SDK returned an invalid bounded space collection",
      );
    }
    return response.data;
  }

  private async listMemoryScopes(spaceId: string, signal: AbortSignal) {
    const response = await this.#client.spaces.listMemoryScopes({
      limit: maximumTopologyListEntries,
      signal,
      spaceId,
    });
    if (!Array.isArray(response.data) ||
      response.data.length > maximumTopologyListEntries) {
      throw new InfinityContextAdapterContractError(
        "official SDK returned an invalid bounded memory-scope collection",
      );
    }
    return response.data;
  }

  private listDocuments(
    request: HistoricalIndexPlanV1,
    signal: AbortSignal,
  ): Promise<readonly DocumentRecord[]> {
    return listTopologyDocuments(this.#client, request.topology, signal);
  }

  private async ensureProcessed(
    documentIdValue: string,
    mutationId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const idempotencyKey = `${mutationId}:process`;
    try {
      const result = await this.#client.documents.processDocument(documentIdValue, {
        idempotencyKey,
        signal,
      });
      return processMutationAccepted(result.data);
    } catch {
      // Repeat the exact idempotent mutation: GET exposes document lifecycle,
      // which cannot reconcile whether processing was accepted.
      try {
        signal.throwIfAborted();
        const reconciled = await this.#client.documents.processDocument(documentIdValue, {
          idempotencyKey,
          signal,
        });
        return processMutationAccepted(reconciled.data);
      } catch {
        return false;
      }
    }
  }
}

function assertTopologyLookupComplete(
  values: readonly unknown[],
  subject: string,
): void {
  if (values.length === maximumTopologyListEntries) {
    throw new InfinityContextAdapterContractError(
      `official SDK ${subject} listing has no cursor and cannot prove deterministic absence`,
    );
  }
}
