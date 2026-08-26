import type {
  HttpResponse,
  JsonValue,
  SourceRef,
} from "@infinity-context/sdk";

export interface StoredDocument {
  readonly id: string;
  indexingStatus: string;
  readonly memoryScopeExternalRef: string;
  processed: boolean;
  readonly sourceExternalId: string;
  readonly sourceRefs: readonly SourceRef[];
  readonly sourceType: string;
  readonly retrievalProjection: Readonly<Record<string, unknown>>;
  readonly spaceSlug: string;
  readonly text: string;
  readonly threadExternalRef: string;
  readonly title: string;
  status: string;
}

export interface RecordedRequest {
  readonly body: JsonValue | null;
  readonly idempotencyKey: string | null;
  readonly method: string;
  readonly path: string;
  readonly query: string;
}

export interface RecordedExactHttpRequest {
  readonly bodyBytes: Uint8Array;
  readonly method: string;
  readonly path: string;
}

export interface IngestGate {
  readonly release: Promise<void>;
  readonly started: () => void;
}

function missingDeferredResolver(): void {
  throw new Error("disposable deferred resolver was not initialized");
}

export function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolver = missingDeferredResolver;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  return { promise, resolve: () => { resolver(); } };
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function json(status: number, value: JsonValue): HttpResponse {
  return {
    body: JSON.stringify(value),
    headers: new Headers({
      "content-type": "application/json",
      "x-request-id": `fake-${status}`,
    }),
    status,
  };
}

export function notFound(): HttpResponse {
  return json(404, { error: {
    code: "memory.not_found",
    message: "disposable document not found",
    retryable: false,
  } });
}

export function envelope(data: JsonValue): HttpResponse {
  return json(200, { data });
}
