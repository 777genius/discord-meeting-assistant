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

export function rankRetrievalCandidate(
  candidate: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  const providerRank = index + 1;
  const contributions = (candidate.contributions as Array<Record<string, unknown>>)
    .map((item) => {
      const providerWeightMicros = integer(item.provider_weight_micros);
      const queryWeightMicros = integer(item.query_weight_micros);
      const contributionScorePicos = weightedRrfContributionScorePicos(
        providerWeightMicros,
        queryWeightMicros,
        queryWeightMicros,
        providerRank,
      );
      return {
        ...item,
        contribution: contributionScorePicos / 1_000_000_000_000,
        contribution_score_picos: contributionScorePicos,
        provider_rank: providerRank,
      };
    });
  const baseScorePicos = contributions.reduce((total, item) =>
    total + integer(item.contribution_score_picos), 0);
  return {
    ...candidate,
    base_score_picos: baseScorePicos,
    contributions,
    fused_score: baseScorePicos / 1_000_000_000_000,
    provider_rank: providerRank,
    rerank_score_picos: baseScorePicos,
  };
}

function weightedRrfContributionScorePicos(
  providerWeightMicros: number,
  queryWeightMicros: number,
  totalQueryWeightMicros: number,
  providerRank: number,
): number {
  const numerator = BigInt(providerWeightMicros) * BigInt(queryWeightMicros) *
    1_000_000n;
  const denominator = BigInt(totalQueryWeightMicros) * BigInt(60 + providerRank);
  let quotient = numerator / denominator;
  const twiceRemainder = numerator % denominator * 2n;
  if (twiceRemainder > denominator ||
    (twiceRemainder === denominator && quotient % 2n !== 0n)) {
    quotient += 1n;
  }
  return Number(quotient);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("synthetic Retrieval V2 numeric fixture is invalid");
  }
  return value;
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
