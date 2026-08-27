import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  JsonObject,
  JsonValue,
} from "@infinity-context/sdk";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type {
  InfinityExactDocumentIdentityV1,
  InfinityExactDocumentSdkV1,
} from "../src/infinity-exact-document-compatibility.js";
import {
  asRecord,
  deferred,
  envelope,
  json,
  notFound,
  string,
  strings,
  type IngestGate,
  type RecordedExactHttpRequest,
  type RecordedRequest,
  type StoredDocument,
} from "./disposable-infinity-endpoint-support.js";
const require = createRequire(import.meta.url);
const retrievalCapability = JSON.parse(readFileSync(require.resolve(
  "@infinity-context/sdk/fixtures/context_retrieval_v2/capability.json",
), "utf8")) as Record<string, unknown>;
const retrievalSuccess = JSON.parse(readFileSync(require.resolve(
  "@infinity-context/sdk/fixtures/context_retrieval_v2/success.json",
), "utf8")) as Record<string, unknown>;
export const DISPOSABLE_RETRIEVAL_V2_BINDING = Object.freeze({
  capabilityFingerprint: retrievalCapability.capability_fingerprint as string,
  contractVersion: "context-retrieval.v2" as const,
  indexProfileDigest: retrievalCapability.index_profile_digest as string,
  profileId: retrievalCapability.profile_id as string,
  rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
  requiredProviderLanes: Object.freeze(
    retrievalCapability.required_provider_lanes as string[],
  ),
  serviceRevision: retrievalCapability.service_revision as string,
});

export interface DisposableInfinityRuntimeQualificationReceipt {
  readonly embeddingProfileDigestSha256: string;
  readonly embeddingProfileId: string;
  readonly serviceRevision: string;
}

/** In-memory endpoint behind the official SDK's HttpTransport request path. */
export class DisposableInfinityEndpoint implements HttpTransport {
  readonly #documents = new Map<string, StoredDocument>();
  readonly #ingestIdempotency = new Map<string, string>();
  readonly #processIdempotency = new Map<string, string>();
  readonly #scopes = new Map<string, JsonObject>();
  readonly #spaces = new Map<string, JsonObject>();
  #nextDocument = 1; #nextScope = 1; #nextSpace = 1;
  #loseIngestResponse = false; #loseDocumentDeleteResponse = false;
  #loseProcessResponse = false;
  #loseThreadDeleteResponse = false;
  #failDocumentDelete = false;
  #failDocumentDeleteAfter: number | null = null;
  #hangSearch = false;
  #hangRequestPath: string | null = null;
  #requestDelayMs = 0;
  #preserveThreadDocument = false;
  #threadStatusHidesDocuments = false;
  #capabilitiesQualified = true;
  #runtimeQualificationReceipt:
    DisposableInfinityRuntimeQualificationReceipt | null = null;
  #ingestGate: IngestGate | null = null;
  #scopeListPageSize = 100;
  #scopeListCursorFault: "missing" | "overlong" | "oversized" | "repeated" | "repeated_rows" | null = null;
  #scopeListCursorFormat: "encoded" | "numeric" = "numeric";
  public readonly requests: RecordedRequest[] = [];
  public readonly exactHttpRequests: RecordedExactHttpRequest[] = [];
  public readonly exactDocumentRequests: Array<Readonly<{
    readonly documentId: string;
    readonly operation: "delete" | "reconcile";
  }>> = [];

  public exactDocumentSdk(): InfinityExactDocumentSdkV1 {
    return Object.freeze({
      contractVersion: "infinity.document-exact-reconciliation.v1" as const,
      deleteExactDocument: async (input: InfinityExactDocumentIdentityV1 & {
        readonly deletionIdempotencyKey: string;
        readonly signal: AbortSignal;
      }) => {
        input.signal.throwIfAborted();
        this.exactDocumentRequests.push(Object.freeze({
          documentId: input.documentId,
          operation: "delete" as const,
        }));
        const document = this.#exactDocument(input);
        if (document === undefined || document.status === "deleted") {
          return { status: "deleted" as const };
        }
        document.status = "deleted";
        document.processed = false;
        if (this.#loseDocumentDeleteResponse) {
          this.#loseDocumentDeleteResponse = false;
          return { status: "outcome_unknown" as const };
        }
        return { status: "deleted" as const };
      },
      reconcileExactDocument: async (input: InfinityExactDocumentIdentityV1 & {
        readonly signal: AbortSignal;
      }) => {
        input.signal.throwIfAborted();
        this.exactDocumentRequests.push(Object.freeze({
          documentId: input.documentId,
          operation: "reconcile" as const,
        }));
        const document = this.#exactDocument(input);
        if (document === undefined || document.status !== "active") {
          return { status: "absent" as const };
        }
        return Object.freeze({
          documentId: document.sourceExternalId,
          idempotencyKey: input.idempotencyKey,
          memoryScopeExternalRef: document.memoryScopeExternalRef,
          processed: document.processed,
          projectionGeneration: string(document.retrievalProjection.projection_generation),
          remoteDocumentId: document.id,
          sourceType: document.sourceType,
          spaceSlug: document.spaceSlug,
          status: "active" as const,
          threadExternalRef: document.threadExternalRef,
        });
      },
    });
  }

  public recordExactHttpRequest(
    method: string,
    path: string,
    bodyBytes: Uint8Array,
  ): void {
    this.exactHttpRequests.push(Object.freeze({
      bodyBytes: Uint8Array.from(bodyBytes),
      method,
      path,
    }));
  }

  #exactDocument(input: InfinityExactDocumentIdentityV1): StoredDocument | undefined {
    const remoteId = this.#ingestIdempotency.get(input.idempotencyKey);
    const document = remoteId === undefined ? undefined : this.#documents.get(remoteId);
    const identityCollision = [...this.#documents.values()].find(({ sourceExternalId }) =>
      sourceExternalId === input.documentId
    );
    if (document === undefined) {
      if (identityCollision !== undefined) {
        throw new Error("synthetic exact document identity belongs to another mutation");
      }
      return undefined;
    }
    if (
      document.sourceExternalId !== input.documentId ||
      document.memoryScopeExternalRef !== input.memoryScopeExternalRef ||
      string(document.retrievalProjection.projection_generation) !==
        input.projectionGeneration ||
      document.sourceType !== input.sourceType ||
      document.spaceSlug !== input.spaceSlug ||
      document.threadExternalRef !== input.threadExternalRef
    ) {
      throw new Error("synthetic exact document reconciliation scope mismatch");
    }
    return document;
  }

  public pauseNextIngest(): {
    readonly resume: () => void;
    readonly started: Promise<void>;
  } {
    if (this.#ingestGate !== null) {
      throw new Error("a disposable ingest gate is already active");
    }
    const started = deferred();
    const release = deferred();
    this.#ingestGate = { release: release.promise, started: started.resolve };
    return { resume: release.resolve, started: started.promise };
  }

  public loseNextIngestResponse(): void {
    this.#loseIngestResponse = true;
  }

  public loseNextDocumentDeleteResponse(): void {
    this.#loseDocumentDeleteResponse = true;
  }

  public failNextDocumentDelete(): void {
    this.#failDocumentDelete = true;
  }

  public failDocumentDeleteAfter(successfulDeletes: number): void {
    this.#failDocumentDeleteAfter = successfulDeletes;
  }

  public configureScopeList(
    pageSize: number,
    cursorFault: "missing" | "overlong" | "oversized" | "repeated" | "repeated_rows" | null = null,
    cursorFormat: "encoded" | "numeric" = "numeric",
  ): void {
    this.#scopeListPageSize = pageSize;
    this.#scopeListCursorFault = cursorFault;
    this.#scopeListCursorFormat = cursorFormat;
  }

  public preserveNextThreadDocumentAndHideItFromStatus(): void {
    this.#preserveThreadDocument = true;
    this.#threadStatusHidesDocuments = true;
  }

  public loseNextProcessResponse(): void {
    this.#loseProcessResponse = true;
  }

  public loseNextThreadDeleteResponse(): void {
    this.#loseThreadDeleteResponse = true;
  }

  public hangNextSearchUntilDeadline(): void {
    this.#hangSearch = true;
  }

  public delayEveryRequest(milliseconds: number): void {
    this.#requestDelayMs = milliseconds;
  }

  public hangNextRequestUntilDeadline(path: string): void {
    this.#hangRequestPath = path;
  }

  public setCapabilitiesQualified(qualified: boolean): void {
    this.#capabilitiesQualified = qualified;
  }

  public setRuntimeQualificationReceipt(
    receipt: DisposableInfinityRuntimeQualificationReceipt | null,
  ): void {
    this.#runtimeQualificationReceipt = receipt === null
      ? null
      : Object.freeze({ ...receipt });
  }

  public documentCount(): number {
    return [...this.#documents.values()].filter(({ status }) => status === "active").length;
  }

  public documentIds(): readonly string[] {
    return Object.freeze([...this.#documents.values()]
      .filter(({ status }) => status === "active")
      .map(({ id }) => id));
  }

  public indexedTexts(): readonly string[] {
    return [...this.#documents.values()]
      .filter(({ status }) => status === "active")
      .map(({ text }) => text);
  }

  public storedDocumentCount(): number {
    return this.#documents.size;
  }

  public async send(request: HttpRequest): Promise<HttpResponse> {
    const body = request.body?.kind === "json" ? request.body.value : null;
    this.requests.push({
      body,
      idempotencyKey: request.headers.get("idempotency-key"),
      method: request.method,
      path: request.url.pathname,
      query: request.url.search,
    });
    const path = request.url.pathname;
    await this.#waitBeforeRequest(request, path);

    if (request.method === "GET" && path === "/v1/capabilities") {
      const qualified = this.#capabilitiesQualified;
      const runtimeReceipt = this.#runtimeQualificationReceipt;
      return json(200, {
        api_version: "v1",
        adapters: {
          qdrant: {
            enabled: qualified,
            healthy: qualified,
            supports_search: qualified,
          },
        },
        capabilities: [{
          adapter_name: "qdrant",
          capability: "vector_recall",
          enabled: qualified,
          healthy: qualified,
          status: qualified ? "ok" : "unavailable",
        }],
        context: { retrieval: retrievalCapability as unknown as JsonValue },
        // The official service exposes PostgreSQL keyword/BM25 retrieval as a
        // built-in search stage, not as a separately named adapter.
        enabled_adapters: qualified ? ["qdrant"] : [],
        ...(runtimeReceipt === null
          ? {}
          : {
            embedding_profile_digest_sha256:
              runtimeReceipt.embeddingProfileDigestSha256,
            embedding_profile_id: runtimeReceipt.embeddingProfileId,
            service_revision: runtimeReceipt.serviceRevision,
          }),
        service_name: "disposable-infinity-context",
        supports_qdrant: qualified,
      });
    }
    if (path === "/v1/spaces") {
      return this.#spacesRequest(request.method, body);
    }
    if (path === "/v1/memory-scopes") {
      return this.#scopesRequest(request.method, request.url, body);
    }
    if (path === "/v1/documents") {
      return this.#documentsRequest(request, body);
    }
    const chunksMatch = path.match(/^\/v1\/documents\/([^/]+)\/chunks$/u);
    if (request.method === "GET" && chunksMatch !== null) {
      return this.#documentChunks(
        decodeURIComponent(chunksMatch[1] ?? ""),
        request.url,
      );
    }
    const documentMatch = path.match(/^\/v1\/documents\/([^/]+)(?:\/(process))?$/u);
    if (documentMatch !== null) {
      return this.#documentRequest(
        request,
        decodeURIComponent(documentMatch[1] ?? ""),
        documentMatch[2] === "process",
      );
    }
    if (request.method === "POST" && path === "/v1/search") {
      return this.#search(request, body);
    }
    if (request.method === "POST" && path === "/v1/context/retrieve") {
      return this.#retrieveContext(body);
    }
    if (request.method === "DELETE" && path === "/v1/thread-memory") {
      return this.#deleteThread(body);
    }
    if (request.method === "POST" && path === "/v1/thread-memory/status") {
      return this.#threadStatus(body);
    }
    return json(404, {
      error: { code: "memory.unknown_fake_route", message: `${request.method} ${path}`, retryable: false },
    });
  }

  async #waitBeforeRequest(request: HttpRequest, path: string): Promise<void> {
    const hangs = this.#hangRequestPath === path;
    if (hangs) {
      this.#hangRequestPath = null;
    }
    if (!hangs && this.#requestDelayMs === 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const signal = request.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        signal?.removeEventListener("abort", abort);
      };
      const abort = (): void => {
        cleanup();
        reject(signal?.reason ?? new DOMException("synthetic request aborted", "AbortError"));
      };
      if (signal?.aborted === true) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      if (!hangs) {
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, this.#requestDelayMs);
      }
    });
  }

  #spacesRequest(method: string, body: JsonValue | null): HttpResponse {
    if (method === "GET") {
      return envelope([...this.#spaces.values()]);
    }
    const input = asRecord(body);
    const slug = string(input.slug);
    const existing = this.#spaces.get(slug);
    if (existing !== undefined) {
      return envelope(existing);
    }
    const id = `space-${this.#nextSpace++}`;
    const value = {
      created_at: "2026-01-01T00:00:00Z",
      id,
      name: string(input.name),
      slug,
      status: "active",
      updated_at: "2026-01-01T00:00:00Z",
    };
    this.#spaces.set(slug, value);
    return envelope(value);
  }

  #scopesRequest(method: string, url: URL, body: JsonValue | null): HttpResponse {
    if (method === "GET") {
      const spaceId = url.searchParams.get("space_id");
      return envelope([...this.#scopes.values()].filter((scope) => scope.space_id === spaceId));
    }
    const input = asRecord(body);
    const externalRef = string(input.external_ref);
    const existing = this.#scopes.get(externalRef);
    if (existing !== undefined) {
      return envelope(existing);
    }
    const value = {
      created_at: "2026-01-01T00:00:00Z",
      external_ref: externalRef,
      id: `scope-${this.#nextScope++}`,
      name: string(input.name),
      space_id: string(input.space_id),
      status: "active",
      updated_at: "2026-01-01T00:00:00Z",
    };
    this.#scopes.set(externalRef, value);
    return envelope(value);
  }

  #documentsRequest(request: HttpRequest, body: JsonValue | null): HttpResponse | Promise<HttpResponse> {
    if (request.method === "GET") {
      return this.#listScopeDocuments(request.url);
    }
    const gate = this.#ingestGate;
    if (gate !== null) {
      this.#ingestGate = null;
      gate.started();
      return this.#waitForIngestGate(request, gate)
        .then(() => this.#ingestDocument(request, body));
    }
    return this.#ingestDocument(request, body);
  }

  async #waitForIngestGate(request: HttpRequest, gate: IngestGate): Promise<void> {
    const signal = request.signal;
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    await new Promise<void>((resolve, reject) => {
      const aborted = (): void => {
        cleanup();
        reject(signal?.reason ?? new DOMException("synthetic ingest aborted", "AbortError"));
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", aborted);
      };
      signal?.addEventListener("abort", aborted, { once: true });
      void (async () => {
        await gate.release;
        cleanup();
        resolve();
      })();
    });
  }

  #ingestDocument(request: HttpRequest, body: JsonValue | null): HttpResponse | Promise<HttpResponse> {
    const input = asRecord(body);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    const priorId = this.#ingestIdempotency.get(idempotencyKey);
    let document = priorId === undefined ? undefined : this.#documents.get(priorId);
    const replayed = document !== undefined;
    if (document === undefined) {
      document = {
        id: `document-${this.#nextDocument++}`,
        indexingStatus: "pending",
        memoryScopeExternalRef: string(input.memory_scope_external_ref),
        processed: false,
        sourceExternalId: string(input.source_external_id),
        sourceRefs: Array.isArray(input.source_refs)
          ? input.source_refs.map((item) => {
              const source = asRecord(item);
              return { source_id: string(source.source_id), source_type: string(source.source_type) };
            })
          : [],
        sourceType: string(input.source_type),
        retrievalProjection: asRecord(input.retrieval_projection),
        spaceSlug: string(input.space_slug),
        status: "active",
        text: string(input.text),
        threadExternalRef: string(input.thread_external_ref),
        title: string(input.title),
      };
      this.#documents.set(document.id, document);
      this.#ingestIdempotency.set(idempotencyKey, document.id);
    }
    if (replayed && document.processed) {
      document.indexingStatus = "already_indexed_or_pending";
    }
    if (this.#loseIngestResponse) {
      this.#loseIngestResponse = false;
      return Promise.reject(new Error("synthetic committed ingest response loss"));
    }
    return envelope(this.#documentRecord(document));
  }

  #documentRequest(
    request: HttpRequest,
    documentId: string,
    process: boolean,
  ): HttpResponse | Promise<HttpResponse> {
    const document = this.#documents.get(documentId);
    if (document === undefined) {
      return notFound();
    }
    if (process && request.method === "POST") {
      const idempotencyKey = request.headers.get("idempotency-key") ?? "";
      const replayed = this.#processIdempotency.get(idempotencyKey) === documentId;
      document.indexingStatus = replayed ? "already_indexed_or_pending" : "pending";
      document.processed = true;
      this.#processIdempotency.set(idempotencyKey, documentId);
      if (this.#loseProcessResponse) {
        this.#loseProcessResponse = false;
        return Promise.reject(new Error("synthetic committed process response loss"));
      }
      return envelope(this.#documentRecord(document));
    }
    if (request.method === "GET") {
      return envelope(this.#documentRecord(document));
    }
    if (request.method === "DELETE") {
      if (this.#failDocumentDeleteAfter !== null) {
        if (this.#failDocumentDeleteAfter === 0) {
          this.#failDocumentDeleteAfter = null;
          return Promise.reject(new Error("synthetic delayed document deletion failure"));
        }
        this.#failDocumentDeleteAfter -= 1;
      }
      if (this.#failDocumentDelete) {
        this.#failDocumentDelete = false;
        return Promise.reject(new Error("synthetic uncommitted document deletion failure"));
      }
      document.status = "deleted";
      document.processed = false;
      if (this.#loseDocumentDeleteResponse) {
        this.#loseDocumentDeleteResponse = false;
        return Promise.reject(new Error("synthetic committed document deletion response loss"));
      }
      return envelope(this.#documentRecord(document));
    }
    return json(405, {
      error: { code: "memory.method_not_allowed", message: request.method },
    });
  }

  #listScopeDocuments(url: URL): HttpResponse {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const requestedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 100;
    const pageSize = Math.min(requestedLimit, this.#scopeListPageSize);
    const cursor = url.searchParams.get("cursor");
    const cursorOffset = cursor !== null && this.#scopeListCursorFormat === "encoded"
      ? cursor.slice(cursor.lastIndexOf(":") + 1)
      : cursor;
    const offset = cursorOffset === null ? 0 : Number.parseInt(cursorOffset, 10);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return json(400, { detail: "invalid cursor" });
    }
    const sourceExternalId = url.searchParams.get("source_external_id");
    const documents = [...this.#documents.values()].filter((document) =>
      document.status === (url.searchParams.get("status") ?? "active") &&
      document.memoryScopeExternalRef === url.searchParams.get("memory_scope_external_ref") &&
      document.spaceSlug === url.searchParams.get("space_slug") &&
      document.threadExternalRef === url.searchParams.get("thread_external_ref") &&
      (sourceExternalId === null || document.sourceExternalId === sourceExternalId)
    );
    const requestedEnd = offset + pageSize;
    const page = documents.slice(offset, requestedEnd);
    const responsePage = this.#scopeListCursorFault === "oversized" && page[0] !== undefined
      ? Array.from({ length: requestedLimit + 1 }, () => page[0]!)
      : this.#scopeListCursorFault === "repeated_rows" && documents[0] !== undefined
        ? [documents[0]]
        : page;
    const nextOffset = offset + page.length;
    const nextCursor = nextOffset < documents.length
      ? this.#scopeListCursorFormat === "encoded"
        ? "opaque-token".repeat(22) + ":" + nextOffset
        : String(nextOffset)
      : null;
    if (this.#scopeListCursorFault === "missing" && nextCursor !== null) {
      return json(200, { data: responsePage.map((document) => this.#documentRecord(document)) });
    }
    return json(200, {
      data: responsePage.map((document) => this.#documentRecord(document)),
      next_cursor: this.#scopeListCursorFault === "repeated" && nextCursor !== null
        ? (cursor ?? "0")
        : this.#scopeListCursorFault === "overlong" && nextCursor !== null
          ? "x".repeat(1_001)
          : nextCursor,
    });
  }

  #documentChunks(documentId: string, url: URL): HttpResponse {
    const document = this.#documents.get(documentId);
    if (document === undefined) {
      return notFound();
    }
    const chunks: readonly JsonObject[] = Object.freeze([
      { chunk_id: `${documentId}-chunk-1`, text: "UNTRUSTED SDK CHUNK PAGE ONE" },
      { chunk_id: `${documentId}-chunk-2`, text: "UNTRUSTED SDK CHUNK PAGE TWO" },
      { chunk_id: `${documentId}-chunk-3`, text: "UNTRUSTED SDK CHUNK PAGE THREE" },
    ]);
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
    const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : 100;
    const parsedCursor = Number.parseInt(url.searchParams.get("cursor") ?? "0", 10);
    const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
    const data = chunks.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return json(200, {
      data,
      next_cursor: nextOffset < chunks.length ? String(nextOffset) : null,
    });
  }

  #search(request: HttpRequest, body: JsonValue | null): HttpResponse | Promise<HttpResponse> {
    if (this.#hangSearch) {
      this.#hangSearch = false;
      return new Promise((_resolve, reject) => {
        const signal = request.signal;
        if (signal === undefined) {
          reject(new Error("synthetic hanging search requires an SDK deadline"));
          return;
        }
        const rejectAborted = () => {
          reject(signal.reason ?? new DOMException("synthetic search aborted", "AbortError"));
        };
        if (signal.aborted) {
          rejectAborted();
          return;
        }
        signal.addEventListener("abort", rejectAborted, { once: true });
      });
    }
    const input = asRecord(body);
    const allowedScopes = new Set(strings(input.memory_scope_external_refs));
    const queryTokens = new Set(string(input.query).toLowerCase().match(/[a-z0-9-]{3,}/gu) ?? []);
    const maximum = typeof input.max_chunks === "number" ? input.max_chunks : 10;
    const ranked = [...this.#documents.values()]
      .filter(({ memoryScopeExternalRef, processed, status }) =>
        allowedScopes.has(memoryScopeExternalRef) && processed && status === "active"
      )
      .map((document) => ({
        document,
        score: [...queryTokens].filter((token) => document.text.toLowerCase().includes(token)).length,
      }))
      .filter(({ score }) => score > 0)
      .toSorted((left, right) => right.score - left.score ||
        (left.document.id < right.document.id ? -1 : left.document.id > right.document.id ? 1 : 0))
      .slice(0, maximum);
    return envelope({
      diagnostics: {
        keyword_chunks_considered: this.#documents.size,
        retrieval_sources_used: ["qdrant", "keyword"],
        vector_status: "healthy",
      },
      items: ranked.map(({ document, score }) => ({
        item_id: document.id,
        item_type: "chunk",
        score,
        source_refs: document.sourceRefs,
        text: "UNTRUSTED SDK CHUNK TEXT MUST NEVER BECOME EVIDENCE",
      })),
      next_cursor: null,
      top_evidence: [],
    });
  }

  #retrieveContext(body: JsonValue | null): HttpResponse {
    const input = asRecord(body);
    const scope = asRecord(input.scope);
    const filters = asRecord(input.filters);
    const bounds = asRecord(input.bounds);
    const query = asRecord(Array.isArray(input.queries) ? input.queries[0] : undefined);
    const queryId = string(query.query_id);
    const queryTokens = new Set(string(query.query).toLowerCase()
      .match(/[\p{L}\p{N}-]{3,}/gu) ?? []);
    const actorKeys = new Set(strings(filters.actor_keys));
    const generations = new Map(
      (Array.isArray(filters.source_generations) ? filters.source_generations : [])
        .map((value) => asRecord(value))
        .map((value) => [string(value.source_key), string(value.projection_generation)]),
    );
    const resultLimit = typeof bounds.result_limit === "number"
      ? bounds.result_limit
      : 1;
    const documents = [...this.#documents.values()]
      .filter(({ memoryScopeExternalRef, processed, status }) =>
        memoryScopeExternalRef === string(scope.memory_scope_id) &&
        processed && status === "active"
      )
      .filter(({ retrievalProjection: projection }) =>
        generations.get(string(projection.source_key)) ===
          string(projection.projection_generation) &&
        (actorKeys.size === 0 || strings(projection.actor_keys).some((key) =>
          actorKeys.has(key)
        ))
      )
      .map((document) => ({
        document,
        matches: [...queryTokens].filter((token) =>
          document.text.toLowerCase().includes(token)
        ).length,
      }))
      .filter(({ matches }) => matches > 0)
      .toSorted((left, right) => right.matches - left.matches ||
        string(left.document.retrievalProjection.locator).localeCompare(
          string(right.document.retrievalProjection.locator),
        ))
      .slice(0, resultLimit);
    const fixtureCandidate = (retrievalSuccess.candidates as
      Array<Record<string, unknown>>)[0];
    if (fixtureCandidate === undefined) {
      throw new Error("Retrieval V2 success fixture has no candidate");
    }
    const candidates = documents.map(({ document }) => {
      const locator = string(document.retrievalProjection.locator);
      return {
        ...structuredClone(fixtureCandidate),
        actor_matched_weight_micros: 0,
        actor_requested_weight_micros: 0,
        canonical_identity: locator,
        chunk_key: locator,
        contributions: (fixtureCandidate.contributions as
          Array<Record<string, unknown>>).map((contribution) => ({
            ...structuredClone(contribution),
            query_id: queryId,
          })),
        document_key: document.sourceExternalId,
        locator,
        matched_query_ids: [queryId],
        neighbors: [],
        preference_boost_micros: 0,
        preference_score_micros: 0,
        rerank_score_picos: fixtureCandidate.base_score_picos,
        source_key: document.retrievalProjection.source_key,
        source_matched_weight_micros: 0,
        source_requested_weight_micros: 0,
        time_matched_weight_micros: 0,
        time_requested_weight_micros: 0,
      };
    }).toSorted((left, right) => string(left.canonical_identity).localeCompare(
      string(right.canonical_identity),
    ));
    return json(200, {
      applied_bounds: {
        candidate_limit: bounds.candidate_limit,
        deadline_ms: bounds.deadline_ms,
        neighbor_radius: bounds.neighbor_radius,
        response_byte_limit: bounds.response_byte_limit,
        result_limit: bounds.result_limit,
        returned_neighbors: 0,
        returned_seeds: candidates.length,
      },
      candidates,
      capability_fingerprint: input.capability_fingerprint,
      contract_version: "context-retrieval.v2",
      coverage: "top_k_only",
      degradation_reason_codes: [],
      profile_id: input.profile_id,
      provider_outcomes: [
        { provider_id: "postgres_keyword", reason_code: null, status: "available" },
        { provider_id: "qdrant_dense", reason_code: null, status: "available" },
      ],
      ranking_policy: "weighted_rrf_canonical_preferences.v1",
      status: candidates.length > 0 ? "available" : "unavailable",
    } as unknown as JsonValue);
  }

  #deleteThread(body: JsonValue | null): HttpResponse | Promise<HttpResponse> {
    const input = asRecord(body);
    const scope = string(input.memory_scope_external_ref);
    const space = string(input.space_slug);
    const thread = string(input.thread_external_ref);
    let deleted = 0;
    let preserved = false;
    for (const document of this.#documents.values()) {
      if (
        document.memoryScopeExternalRef === scope &&
        document.spaceSlug === space &&
        document.threadExternalRef === thread
      ) {
        if (this.#preserveThreadDocument && !preserved) {
          preserved = true;
          continue;
        }
        if (document.status === "active") {
          document.status = "deleted";
          document.processed = false;
          deleted += 1;
        }
      }
    }
    this.#preserveThreadDocument = false;
    if (this.#loseThreadDeleteResponse) {
      this.#loseThreadDeleteResponse = false;
      return Promise.reject(new Error("synthetic committed thread deletion response loss"));
    }
    return envelope({ deleted_chunks: deleted, deleted_facts: 0, deleted_jobs: 0 });
  }

  #threadStatus(body: JsonValue | null): HttpResponse {
    const input = asRecord(body);
    const chunks = this.#threadStatusHidesDocuments ? 0 : [...this.#documents.values()].filter((document) =>
      document.status === "active" &&
      document.memoryScopeExternalRef === string(input.memory_scope_external_ref) &&
      document.spaceSlug === string(input.space_slug) &&
      document.threadExternalRef === string(input.thread_external_ref)
    ).length;
    this.#threadStatusHidesDocuments = false;
    return envelope({ chunks, facts: 0, jobs: 0, pending_jobs: 0 });
  }

  #documentRecord(document: StoredDocument): JsonObject {
    return {
      id: document.id,
      indexing_status: document.indexingStatus,
      source_external_id: document.sourceExternalId,
      source_refs: document.sourceRefs,
      source_type: document.sourceType,
      status: document.status,
      title: document.title,
    };
  }
}
