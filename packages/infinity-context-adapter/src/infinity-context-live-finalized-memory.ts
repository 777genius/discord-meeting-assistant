import type {
  HistoricalOpaqueIdPort,
  LiveFinalizedMemoryProjectionPort,
  LiveFinalizedMemoryProjectionResultV1,
  LiveFinalizedMemoryProjectionV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  DOCUMENT_RETRIEVAL_PROJECTION_SCHEMA_V1,
  InfinityContextClient as InfinityContextClientV2,
  type HttpTransport as HttpTransportV2,
} from "@infinity-context/sdk";

import type { HistoricalRetrievalActorKeyMapper } from
  "./historical-retrieval-projection.js";
import { InfinityOperationDeadline } from "./infinity-request-deadline.js";
import {
  InfinityContextAdapterContractError,
  documentId,
  documentSourceExternalId,
  failure,
  processMutationAccepted,
} from "./infinity-context-sdk-contract.js";
import {
  requireInfinityExactDocumentSdk,
  type InfinityExactDocumentIdentityV1,
  type InfinityExactDocumentSdkV1,
} from "./infinity-exact-document-compatibility.js";

const sourceType = "meeting_live_human_turn";

interface LiveTopology {
  readonly memoryScopeExternalRef: string;
  readonly sourceKey: string;
  readonly spaceSlug: string;
  readonly threadExternalRef: string;
}

export interface InfinityContextLiveFinalizedMemoryConfigV1 {
  readonly actorKeys: HistoricalRetrievalActorKeyMapper;
  readonly baseUrl: string;
  readonly ids: HistoricalOpaqueIdPort;
  readonly operationTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly schemaVersion: number;
  readonly exactDocuments?: InfinityExactDocumentSdkV1;
  readonly token: string | (() => Promise<string | null | undefined> | string | null | undefined);
  /** Test injection still traverses the official SDK clients. */
  readonly transport?: unknown;
}

/** Thin official-SDK ACL for transient finalized-human turn documents. */
export class InfinityContextLiveFinalizedMemoryAdapter
  implements LiveFinalizedMemoryProjectionPort
{
  readonly #actorKeys: HistoricalRetrievalActorKeyMapper;
  readonly #ids: HistoricalOpaqueIdPort;
  readonly #index: InfinityContextClientV2;
  readonly #exactDocuments: InfinityExactDocumentSdkV1 | undefined;
  readonly #operationTimeoutMs: number;
  readonly #requestTimeoutMs: number;

  public constructor(config: InfinityContextLiveFinalizedMemoryConfigV1) {
    if (
      config.schemaVersion !== 1 ||
      !Number.isSafeInteger(config.requestTimeoutMs) ||
      config.requestTimeoutMs < 1 ||
      config.requestTimeoutMs > 60_000 ||
      !Number.isSafeInteger(config.operationTimeoutMs) ||
      config.operationTimeoutMs < config.requestTimeoutMs ||
      config.operationTimeoutMs > 300_000
    ) {
      throw new RangeError("Infinity live memory configuration is invalid");
    }
    this.#actorKeys = config.actorKeys;
    this.#ids = config.ids;
    this.#operationTimeoutMs = config.operationTimeoutMs;
    this.#requestTimeoutMs = config.requestTimeoutMs;
    // Exact reconciliation is optional at composition time. Do not make
    // process startup depend on a capability that has not been explicitly
    // established; production composition omits this projection in that case.
    this.#exactDocuments = config.exactDocuments === undefined
      ? undefined
      : requireInfinityExactDocumentSdk(config.exactDocuments);
    const common = {
      baseUrl: config.baseUrl,
      retryPolicy: { maxAttempts: 1 as const },
      timeoutMs: config.requestTimeoutMs,
      token: config.token,
    };
    this.#index = new InfinityContextClientV2({
      ...common,
      ...(config.transport === undefined
        ? {}
        : { transport: config.transport as HttpTransportV2 }),
    });
  }

  public async reconcile(
    projection: LiveFinalizedMemoryProjectionV1,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LiveFinalizedMemoryProjectionResultV1> {
    if (!validProjection(projection)) {
      return rejected("memory.invalid_live_projection");
    }
    const exactDocuments = this.#exactDocuments;
    if (exactDocuments === undefined) {
      return rejected("memory.live_exact_reconciliation_unavailable");
    }
    const topology = this.topology(projection);
    const operation = new InfinityOperationDeadline(
      this.#operationTimeoutMs,
      options.signal,
    );
    try {
      const response = await operation.request(this.#requestTimeoutMs, (signal) =>
        exactDocuments.reconcileExactDocument({
          ...this.exactIdentity(projection, topology),
          signal,
        })
      );
      if (response.status === "absent") {
        return { status: "not_found" };
      }
      if (!matchesExactIdentity(response, this.exactIdentity(projection, topology)) ||
        response.remoteDocumentId.length === 0) {
        throw new InfinityContextAdapterContractError(
          "live memory exact reconciliation returned conflicting ownership",
        );
      }
      if (!response.processed) {
        const processed = (await operation.request(
          this.#requestTimeoutMs,
          (signal) => this.#index.documents.processDocument(
            response.remoteDocumentId,
            { idempotencyKey: `${projection.mutationId}:process`, signal },
          ),
        )).data;
        if (!processMutationAccepted(processed)) {
          throw new InfinityContextAdapterContractError(
            "live memory exact reconciliation could not settle processing",
          );
        }
      }
      return { status: "applied" };
    } catch (error) {
      return failure(error, "outcome_unknown");
    } finally {
      operation.close();
    }
  }

  public async upsert(
    projection: LiveFinalizedMemoryProjectionV1,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LiveFinalizedMemoryProjectionResultV1> {
    if (!validProjection(projection)) {
      return rejected("memory.invalid_live_projection");
    }
    if (this.#exactDocuments === undefined) {
      return rejected("memory.live_exact_reconciliation_unavailable");
    }
    const topology = this.topology(projection);
    const operation = new InfinityOperationDeadline(
      this.#operationTimeoutMs,
      options.signal,
    );
    try {
      await this.ensureTopology(topology, operation);
      const actorKey = this.#actorKeys.activeActorKey(projection.turn.speakerId);
      const ingested = (await operation.request(this.#requestTimeoutMs, (signal) =>
        this.#index.documents.ingestDocument({
          classification: "internal",
          idempotencyKey: projection.mutationId,
          memoryScopeExternalRef: topology.memoryScopeExternalRef,
          retrievalProjection: {
            actorKeys: [actorKey],
            category: "meeting_evidence",
            kind: "turn",
            locator: projection.documentId,
            projectionGeneration: `live.v1.${projection.generation}`,
            relativeTimeInterval: {
              endMs: projection.turn.endMs,
              startMs: projection.turn.startMs,
            },
            schemaVersion: DOCUMENT_RETRIEVAL_PROJECTION_SCHEMA_V1,
            sequenceOrdinal: projection.ordinal,
            sourceKey: topology.sourceKey,
            tags: [],
            timeInterval: null,
          },
          signal,
          sourceExternalId: projection.documentId,
          sourceRefs: [{
            source_id: this.#ids.keyedId("live-turn-source.v1", [projection.turnHash]),
            source_type: "meeting_evidence_turn",
          }],
          sourceType,
          spaceSlug: topology.spaceSlug,
          text: projection.turn.text,
          threadExternalRef: topology.threadExternalRef,
          title: "Finalized human meeting turn",
        })
      )).data;
      if (documentSourceExternalId(ingested) !== projection.documentId) {
        throw new InfinityContextAdapterContractError(
          "official SDK returned a conflicting live document identity",
        );
      }
      const remoteId = documentId(ingested);
      const processed = (await operation.request(this.#requestTimeoutMs, (signal) =>
        this.#index.documents.processDocument(remoteId, {
          idempotencyKey: `${projection.mutationId}:process`,
          signal,
        })
      )).data;
      return processMutationAccepted(processed)
        ? { status: "applied" }
        : {
            code: "memory.live_document_processing_outcome_unknown",
            retryable: true,
            status: "outcome_unknown",
          };
    } catch (error) {
      return failure(error, "outcome_unknown");
    } finally {
      operation.close();
    }
  }

  public async reconcileRemoval(
    projection: LiveFinalizedMemoryProjectionV1,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LiveFinalizedMemoryProjectionResultV1> {
    const result = await this.reconcile(projection, options);
    if (result.status === "applied") {
      return { status: "not_found" };
    }
    if (result.status === "not_found") {
      return { status: "applied" };
    }
    return result;
  }

  public async remove(
    projection: LiveFinalizedMemoryProjectionV1,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<LiveFinalizedMemoryProjectionResultV1> {
    if (!validProjection(projection)) {
      return rejected("memory.invalid_live_projection");
    }
    const exactDocuments = this.#exactDocuments;
    if (exactDocuments === undefined) {
      return rejected("memory.live_exact_reconciliation_unavailable");
    }
    const topology = this.topology(projection);
    const operation = new InfinityOperationDeadline(
      this.#operationTimeoutMs,
      options.signal,
    );
    try {
      const response = await operation.request(this.#requestTimeoutMs, (signal) =>
        exactDocuments.deleteExactDocument({
          ...this.exactIdentity(projection, topology),
          deletionIdempotencyKey: `${projection.mutationId}:retire`,
          signal,
        })
      );
      return response.status === "deleted"
        ? { status: "applied" }
        : {
            code: "memory.live_document_deletion_outcome_unknown",
            retryable: true,
            status: "outcome_unknown",
          };
    } catch (error) {
      return failure(error, "outcome_unknown");
    } finally {
      operation.close();
    }
  }

  private topology(projection: LiveFinalizedMemoryProjectionV1): LiveTopology {
    const room = this.#ids.keyedId("live-memory-room.v1", [
      projection.scopeId,
      projection.roomId,
    ]);
    return Object.freeze({
      memoryScopeExternalRef: `live-room.${room}`,
      sourceKey: this.#ids.keyedId("live-memory-source.v1", [projection.meetingId]),
      spaceSlug: `meeting-live-${room.slice(0, 80)}`,
      threadExternalRef: `live-meeting.${this.#ids.keyedId(
        "live-memory-meeting.v1",
        [projection.meetingId],
      )}`,
    });
  }

  private exactIdentity(
    projection: LiveFinalizedMemoryProjectionV1,
    topology: LiveTopology,
  ): InfinityExactDocumentIdentityV1 {
    return Object.freeze({
      documentId: projection.documentId,
      idempotencyKey: projection.mutationId,
      memoryScopeExternalRef: topology.memoryScopeExternalRef,
      projectionGeneration: `live.v1.${projection.generation}`,
      sourceType,
      spaceSlug: topology.spaceSlug,
      threadExternalRef: topology.threadExternalRef,
    });
  }

  private async ensureTopology(
    topology: LiveTopology,
    operation: InfinityOperationDeadline,
  ): Promise<void> {
    const spaces = await operation.request(this.#requestTimeoutMs, (signal) =>
      this.#index.spaces.listSpaces({ limit: 100, signal })
    );
    let space = spaces.data.find(({ slug }) => slug === topology.spaceSlug);
    if (space === undefined) {
      space = (await operation.request(this.#requestTimeoutMs, (signal) =>
        this.#index.spaces.createSpace({
          name: topology.spaceSlug,
          signal,
          slug: topology.spaceSlug,
        })
      )).data;
    }
    const spaceId = typeof space.id === "string" ? space.id : "";
    if (spaceId.length === 0 || spaceId.length > 200) {
      throw new InfinityContextAdapterContractError("live memory space identity is invalid");
    }
    const scopes = await operation.request(this.#requestTimeoutMs, (signal) =>
      this.#index.spaces.listMemoryScopes({ limit: 100, signal, spaceId })
    );
    if (!scopes.data.some(({ external_ref }) =>
      external_ref === topology.memoryScopeExternalRef
    )) {
      await operation.request(this.#requestTimeoutMs, (signal) =>
        this.#index.spaces.createMemoryScope({
          externalRef: topology.memoryScopeExternalRef,
          name: topology.memoryScopeExternalRef,
          signal,
          spaceId,
        })
      );
    }
  }
}

function matchesExactIdentity(
  response: Exclude<
    Awaited<ReturnType<InfinityExactDocumentSdkV1["reconcileExactDocument"]>>,
    { readonly status: "absent" }
  >,
  expected: InfinityExactDocumentIdentityV1,
): boolean {
  return response.documentId === expected.documentId &&
    response.idempotencyKey === expected.idempotencyKey &&
    response.memoryScopeExternalRef === expected.memoryScopeExternalRef &&
    response.projectionGeneration === expected.projectionGeneration &&
    response.sourceType === expected.sourceType &&
    response.spaceSlug === expected.spaceSlug &&
    response.threadExternalRef === expected.threadExternalRef;
}

function validProjection(projection: LiveFinalizedMemoryProjectionV1): boolean {
  return projection.documentId.length > 0 && projection.documentId.length <= 200 &&
    projection.mutationId.length > 0 && projection.mutationId.length <= 200 &&
    Number.isSafeInteger(projection.generation) && projection.generation >= 1 &&
    Number.isSafeInteger(projection.ordinal) && projection.ordinal >= 1 &&
    projection.turnHash.length === 64 && projection.turn.text.length > 0 &&
    projection.turn.text.length <= 4_096;
}

function rejected(code: string): LiveFinalizedMemoryProjectionResultV1 {
  return { code, retryable: false, status: "rejected" };
}
