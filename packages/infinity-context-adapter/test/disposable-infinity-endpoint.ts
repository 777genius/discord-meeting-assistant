import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  JsonObject,
  JsonValue,
  SourceRef,
} from "@infinity-context/sdk";

interface StoredDocument {
  readonly id: string;
  indexingStatus: string;
  readonly memoryScopeExternalRef: string;
  processed: boolean;
  readonly sourceExternalId: string;
  readonly sourceRefs: readonly SourceRef[];
  readonly spaceSlug: string;
  readonly text: string;
  readonly threadExternalRef: string;
  readonly title: string;
  status: string;
}

interface RecordedRequest {
  readonly body: JsonValue | null;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly query: string;
}

interface IngestGate {
  readonly release: Promise<void>;
  readonly started: () => void;
}

function missingDeferredResolver(): void {
  throw new Error("disposable deferred resolver was not initialized");
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolver = missingDeferredResolver;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return {
    promise,
    resolve: () => {
      resolver();
    },
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function json(status: number, value: JsonValue): HttpResponse {
  return {
    body: JSON.stringify(value),
    headers: new Headers({ "content-type": "application/json", "x-request-id": `fake-${status}` }),
    status,
  };
}

function notFound(): HttpResponse {
  return json(404, {
    error: {
      code: "memory.not_found",
      message: "disposable document not found",
      retryable: false,
    },
  });
}

function envelope(data: JsonValue): HttpResponse {
  return json(200, { data });
}

/** In-memory endpoint behind the official SDK's HttpTransport request path. */
export class DisposableInfinityEndpoint implements HttpTransport {
  readonly #documents = new Map<string, StoredDocument>();
  readonly #ingestIdempotency = new Map<string, string>();
  readonly #processIdempotency = new Map<string, string>();
  readonly #scopes = new Map<string, JsonObject>();
  readonly #spaces = new Map<string, JsonObject>();
  #nextDocument = 1;
  #nextScope = 1;
  #nextSpace = 1;
  #loseIngestResponse = false;
  #loseDocumentDeleteResponse = false;
  #loseProcessResponse = false;
  #loseThreadDeleteResponse = false;
  #failDocumentDelete = false;
  #hangSearch = false;
  #hangRequestPath: string | null = null;
  #requestDelayMs = 0;
  #preserveThreadDocument = false;
  #threadStatusHidesDocuments = false;
  #capabilitiesQualified = true;
  #ingestGate: IngestGate | null = null;
  public readonly requests: RecordedRequest[] = [];

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
        // The official service exposes PostgreSQL keyword/BM25 retrieval as a
        // built-in search stage, not as a separately named adapter.
        enabled_adapters: qualified ? ["qdrant"] : [],
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
      const scope = request.url.searchParams.get("memory_scope_external_ref");
      const space = request.url.searchParams.get("space_slug");
      const thread = request.url.searchParams.get("thread_external_ref");
      const requestedLimit = Number.parseInt(request.url.searchParams.get("limit") ?? "100", 10);
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
        ? requestedLimit
        : 100;
      return envelope([...this.#documents.values()]
        .filter((document) =>
          document.memoryScopeExternalRef === scope &&
          document.spaceSlug === space &&
          document.threadExternalRef === thread
        )
        .slice(0, limit)
        .map((document) => this.#documentRecord(document)));
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
        spaceSlug: string(input.space_slug),
        status: "active",
        text: string(input.text),
        threadExternalRef: string(input.thread_external_ref),
        title: string(input.title),
      };
      this.#documents.set(document.id, document);
      this.#ingestIdempotency.set(idempotencyKey, document.id);
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
      status: document.status,
      title: document.title,
    };
  }
}
