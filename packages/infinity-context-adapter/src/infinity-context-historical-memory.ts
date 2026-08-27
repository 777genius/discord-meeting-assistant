import {
  DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS,
  MAXIMUM_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS,
  type HistoricalDeleteRequestV1,
  type HistoricalDeleteResultV1,
  type HistoricalIndexPlanV1,
  type HistoricalIndexResultV1,
  type HistoricalMemoryPort,
  type HistoricalMemoryOperationOptionsV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  InfinityContextClient,
  type HttpTransport,
} from "@infinity-context/sdk";
import {
  InfinityContextClient as InfinityContextClientV2,
  type HttpTransport as HttpTransportV2,
} from "@infinity-context/sdk";

import {
  decodeInfinityContextCapabilityAttestation,
  type InfinityContextCapabilityAttestationV1,
} from "./infinity-runtime-provenance.js";
import { deleteHistoricalMeeting } from "./infinity-context-deletion.js";
import { indexHistoricalMeeting } from "./infinity-context-indexing.js";
import { InfinityOperationDeadline } from "./infinity-request-deadline.js";
import {
  failure,
  validDeleteRequest,
  validIndexPlan,
} from "./infinity-context-sdk-contract.js";
import type { HistoricalRetrievalActorKeyMapper } from
  "./historical-retrieval-projection.js";

/* The reviewed Node SDK declaration names this DOM alias in HttpTransport. */
declare global {
  type BodyInit = unknown;
}

export interface InfinityContextHistoricalMemoryConfigV1 {
  readonly actorKeys?: HistoricalRetrievalActorKeyMapper;
  readonly baseUrl: string;
  /** Separately bounds one resumable index/search/delete attempt. */
  readonly operationTimeoutMs?: number;
  readonly requestTimeoutMs: number;
  readonly schemaVersion: 1;
  readonly token?: string | (() => Promise<string | null | undefined> | string | null | undefined);
  /** Qualified provider-neutral exact planning profile identity. */
  readonly embeddingTokenProfile?: () => string | undefined;
  /** Test-only injection still traverses the official SDK request executor. */
  readonly transport?: unknown;
}

type InfinityContextHistoricalMemoryConfigInputV1 = Omit<
  InfinityContextHistoricalMemoryConfigV1,
  "schemaVersion"
> & { readonly schemaVersion: number };

export class InfinityContextHistoricalMemoryAdapter implements HistoricalMemoryPort {
  readonly #actorKeys: HistoricalRetrievalActorKeyMapper | undefined;
  readonly #client: InfinityContextClient;
  readonly #indexClient: InfinityContextClientV2;
  readonly #operationTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #embeddingTokenProfile: (() => string | undefined) | undefined;

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
    this.#actorKeys = config.actorKeys;
    this.#operationTimeoutMs = config.operationTimeoutMs ??
      DEFAULT_HISTORICAL_MEMORY_OPERATION_TIMEOUT_MS;
    this.#embeddingTokenProfile = config.embeddingTokenProfile;
    this.#client = new InfinityContextClient({
      baseUrl: config.baseUrl,
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: config.requestTimeoutMs,
      ...(config.token === undefined ? {} : { token: config.token }),
      ...(config.transport === undefined
        ? {}
        : { transport: config.transport as HttpTransport }),
    });
    this.#indexClient = new InfinityContextClientV2({
      baseUrl: config.baseUrl,
      retryPolicy: { maxAttempts: 1 },
      timeoutMs: config.requestTimeoutMs,
      ...(config.token === undefined ? {} : { token: config.token }),
      ...(config.transport === undefined
        ? {}
        : { transport: config.transport as HttpTransportV2 }),
    });
  }

  public async qualifyCapabilities(
    options: HistoricalMemoryOperationOptionsV1 = {},
  ): Promise<InfinityContextCapabilityAttestationV1> {
    const operation = new InfinityOperationDeadline(
      this.#operationTimeoutMs,
      options.signal,
    );
    try {
      const capabilities = await operation.request(
        this.#requestTimeoutMs,
        (signal) => this.#client.system.capabilities({ signal }),
      );
      return decodeInfinityContextCapabilityAttestation(capabilities);
    } finally {
      operation.close();
    }
  }

  public async indexFinalMeeting(
    request: HistoricalIndexPlanV1,
    options: HistoricalMemoryOperationOptionsV1 = {},
  ): Promise<HistoricalIndexResultV1> {
    const embeddingTokenProfile = this.#embeddingTokenProfile?.();
    const actorKeys = this.#actorKeys;
    if (
      embeddingTokenProfile === undefined ||
      actorKeys === undefined ||
      !validIndexPlan(request, embeddingTokenProfile, actorKeys)
    ) {
      return {
        code: "memory.index_plan_outside_qualified_bounds",
        retryable: false,
        status: "rejected",
      };
    }
    return indexHistoricalMeeting({
      actorKeys,
      client: this.#indexClient,
      operationTimeoutMs: this.#operationTimeoutMs,
      options,
      request,
      requestTimeoutMs: this.#requestTimeoutMs,
    });
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
