import {
  DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS,
  MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS,
  type HistoricalDeleteRequestV1,
  type HistoricalDeleteResultV1,
  type HistoricalIndexPlanV1,
  type HistoricalIndexResultV1,
  type HistoricalMemoryPort,
  type HistoricalMemoryOperationOptionsV1,
  type HistoricalSearchRequestV1,
  type HistoricalSearchResultV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  InfinityContextClient,
  ReadScope,
  type HttpTransport,
  type InfinityContextCapabilities,
} from "@infinity-context/sdk";

import { deleteHistoricalMeeting } from "./infinity-context-deletion.js";
import { indexHistoricalMeeting } from "./infinity-context-indexing.js";
import { InfinityOperationDeadline } from "./infinity-request-deadline.js";
import {
  candidateLocators,
  failure,
  isHybridQualified,
  validDeleteRequest,
  validIndexPlan,
  validSearchRequest,
} from "./infinity-context-sdk-contract.js";

/* The reviewed Node SDK declaration names this DOM alias in HttpTransport. */
declare global {
  type BodyInit = unknown;
}

export interface InfinityContextHistoricalMemoryConfigV1 {
  readonly baseUrl: string;
  /** Separately bounds one resumable index/search/delete attempt. */
  readonly operationTimeoutMs?: number;
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
  readonly #operationTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  #capabilities: InfinityContextCapabilities | null = null;

  public constructor(config: InfinityContextHistoricalMemoryConfigV1);
  public constructor(config: InfinityContextHistoricalMemoryConfigInputV1) {
    if (
      config.schemaVersion !== 1 ||
      !Number.isSafeInteger(config.requestTimeoutMs) ||
      config.requestTimeoutMs < 1 ||
      config.requestTimeoutMs > 60_000 ||
      (config.operationTimeoutMs !== undefined && (
        !Number.isSafeInteger(config.operationTimeoutMs) ||
        config.operationTimeoutMs < config.requestTimeoutMs ||
        config.operationTimeoutMs > MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS
      ))
    ) {
      throw new RangeError("Infinity historical memory configuration is invalid");
    }
    this.#requestTimeoutMs = config.requestTimeoutMs;
    this.#operationTimeoutMs = config.operationTimeoutMs ??
      DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS;
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

  public async qualifyCapabilities(
    options: HistoricalMemoryOperationOptionsV1 = {},
  ): Promise<InfinityContextCapabilities> {
    const operation = new InfinityOperationDeadline(
      this.#operationTimeoutMs,
      options.signal,
    );
    try {
      const capabilities = await operation.request(
        this.#requestTimeoutMs,
        (signal) => this.#client.system.capabilities({ signal }),
      );
      this.#capabilities = capabilities;
      return capabilities;
    } finally {
      operation.close();
    }
  }

  public async indexFinalMeeting(
    request: HistoricalIndexPlanV1,
    options: HistoricalMemoryOperationOptionsV1 = {},
  ): Promise<HistoricalIndexResultV1> {
    if (!validIndexPlan(request)) {
      return {
        code: "memory.index_plan_outside_qualified_bounds",
        retryable: false,
        status: "rejected",
      };
    }
    return indexHistoricalMeeting({
      client: this.#client,
      operationTimeoutMs: this.#operationTimeoutMs,
      options,
      request,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
  }

  public async searchRoom(
    request: HistoricalSearchRequestV1,
  ): Promise<HistoricalSearchResultV1> {
    if (!validSearchRequest(request)) {
      return { code: "memory.invalid_search_request", retryable: false, status: "unqualified" };
    }
    const operation = new InfinityOperationDeadline(
      this.#operationTimeoutMs,
      request.signal,
    );
    try {
      const response = await operation.request(
        Math.min(this.#requestTimeoutMs, request.timeoutMs),
        (signal) => this.#client.context.search({
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
        }),
      );
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
    } finally {
      operation.close();
    }
  }

  public async deleteMeeting(
    request: HistoricalDeleteRequestV1,
    options: HistoricalMemoryOperationOptionsV1 = {},
  ): Promise<HistoricalDeleteResultV1> {
    if (!validDeleteRequest(request)) {
      return {
        code: "memory.invalid_delete_request",
        retryable: false,
        status: "rejected",
      };
    }
    const operation = new InfinityOperationDeadline(
      this.#operationTimeoutMs,
      options.signal,
    );
    try {
      const result = await deleteHistoricalMeeting(
        this.#client,
        request,
        this.#requestTimeoutMs,
        operation,
      );
      return options.signal?.aborted === true
        ? {
            code: "memory.operation_cancelled",
            retryable: true,
            status: "absence_unverified",
          }
        : result;
    } catch (error) {
      if (options.signal?.aborted === true) {
        return {
          code: "memory.operation_cancelled",
          retryable: true,
          status: "absence_unverified",
        };
      }
      return failure(error, "absence_unverified");
    } finally {
      operation.close();
    }
  }

}
