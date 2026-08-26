import {
  MeetingKnowledgeInvariantError,
  requireKnowledgeText,
  requireSha256,
} from "./errors.js";

export const retrievalV2ConsumerEvidenceByteLimit = 24_000;

export interface FocusedLocatorRetrievalV2ProviderBinding {
  readonly capabilityFingerprint: string;
  readonly contractVersion: "context-retrieval.v2";
  readonly indexProfileDigest: string;
  readonly profileId: string;
  readonly rankingPolicy: "weighted_rrf_canonical_preferences.v1";
  readonly requiredProviderLanes: readonly string[];
  readonly serviceRevision: string;
}

export interface FocusedLocatorRetrievalV2RequestSnapshot {
  readonly binding: FocusedLocatorRetrievalV2ProviderBinding;
  readonly budgets: {
    readonly candidateLimit: number;
    readonly deadlineMs: number;
    readonly evidenceByteLimit: number;
    readonly neighborRadius: 0;
    readonly responseByteLimit: number;
    readonly resultLimit: number;
  };
  readonly filters: {
    readonly actorKeys: readonly string[];
    readonly category: string | null;
    readonly documentKeys: readonly string[];
    readonly excludedSourceKeys: readonly string[];
    readonly kinds: readonly string[];
    readonly relativeTimeInterval: { readonly endMs: number; readonly startMs: number } | null;
    readonly sourceGenerations: readonly {
      readonly projectionGeneration: string;
      readonly sourceKey: string;
    }[];
    readonly tagsAll: readonly string[];
    readonly tagsAny: readonly string[];
    readonly tagsNone: readonly string[];
    readonly timeInterval: { readonly endAt: string; readonly startAt: string } | null;
  };
  readonly queries: readonly {
    readonly query: string;
    readonly queryId: string;
    readonly weightMicros?: number;
  }[];
  readonly schemaVersion: 2;
  readonly scope: {
    readonly memoryScopeId: string;
    readonly spaceId: string;
    readonly threadId?: string | null;
  };
  readonly softPreferences: {
    readonly actorPreferences: readonly {
      readonly key: string;
      readonly weightMicros: number;
    }[];
    readonly relativeTimeInterval: { readonly endMs: number; readonly startMs: number } | null;
    readonly sourcePreferences: readonly {
      readonly key: string;
      readonly weightMicros: number;
    }[];
    readonly timeInterval: { readonly endAt: string; readonly startAt: string } | null;
    readonly timeWeightMicros: number | null;
  };
}

export type RetrievalPath = "infinity_locator_v1" | "infinity_locator_v2" |
  "legacy_downstream_v1";

export type RetrievalBindingSnapshot =
  | {
      readonly cutoverEpoch: string;
      readonly profileFingerprint: string;
      readonly request: FocusedLocatorRetrievalV2RequestSnapshot;
      readonly retrievalPath: "infinity_locator_v2";
    }
  | {
      readonly cutoverEpoch: string;
      readonly profileFingerprint: string;
      readonly retrievalPath: "infinity_locator_v1";
    }
  | {
      readonly cutoverEpoch: string;
      readonly profileFingerprint: string;
      readonly retrievalPath: "legacy_downstream_v1";
    };

export interface RetrievalAdmissionRollout {
  readonly cutoverEpoch: string;
  readonly infinityProfileFingerprint: string;
  readonly retrievalV2ProviderBinding?: FocusedLocatorRetrievalV2ProviderBinding;
}

const namedCutoverEpoch = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;

/** Lexicographic UTF-8 byte order required by the persisted Retrieval V2 protocol. */
export function compareRetrievalV2Utf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}

function requireCutoverEpoch(value: string): string {
  const epoch = requireKnowledgeText(value, "retrievalBinding.cutoverEpoch", 128);
  if (!namedCutoverEpoch.test(epoch)) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      "retrievalBinding.cutoverEpoch must be a named lowercase epoch",
    );
  }
  return epoch;
}

export class RetrievalBinding {
  public readonly cutoverEpoch: string;
  public readonly profileFingerprint: string;
  public readonly retrievalPath: RetrievalPath;
  public readonly request?: FocusedLocatorRetrievalV2RequestSnapshot;

  private constructor(input: RetrievalBindingSnapshot) {
    this.cutoverEpoch = input.cutoverEpoch;
    this.profileFingerprint = input.profileFingerprint;
    this.retrievalPath = input.retrievalPath;
    if (input.retrievalPath === "infinity_locator_v2") {
      this.request = freezeRetrievalV2Request(input.request);
    }
    Object.freeze(this);
  }

  public static create(input: RetrievalBindingSnapshot): RetrievalBinding {
    const retrievalPath: unknown = input.retrievalPath;
    if (
      retrievalPath !== "infinity_locator_v2" &&
      retrievalPath !== "infinity_locator_v1" &&
      retrievalPath !== "legacy_downstream_v1"
    ) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_BINDING",
        "retrievalBinding.retrievalPath is unsupported",
      );
    }
    const base = {
      cutoverEpoch: requireCutoverEpoch(input.cutoverEpoch),
      profileFingerprint: requireSha256(
        input.profileFingerprint,
        "retrievalBinding.profileFingerprint",
      ),
      retrievalPath,
    } as const;
    if (retrievalPath === "infinity_locator_v2") {
      if (!("request" in input)) {
        throw new MeetingKnowledgeInvariantError(
          "INVALID_BINDING",
          "Infinity Retrieval V2 requires its exact persisted request",
        );
      }
      return new RetrievalBinding({
        cutoverEpoch: base.cutoverEpoch,
        profileFingerprint: base.profileFingerprint,
        request: validateRetrievalV2Request(input.request),
        retrievalPath: "infinity_locator_v2",
      });
    }
    if ("request" in input) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_BINDING",
        "legacy retrieval cannot contain a V2 request",
      );
    }
    return new RetrievalBinding({
      cutoverEpoch: base.cutoverEpoch,
      profileFingerprint: base.profileFingerprint,
      retrievalPath,
    });
  }

  public toSnapshot(): RetrievalBindingSnapshot {
    const base = {
      cutoverEpoch: this.cutoverEpoch,
      profileFingerprint: this.profileFingerprint,
      retrievalPath: this.retrievalPath,
    };
    return this.retrievalPath === "infinity_locator_v2" && this.request !== undefined
      ? { ...base, request: freezeRetrievalV2Request(this.request),
          retrievalPath: "infinity_locator_v2" }
      : { ...base, retrievalPath: this.retrievalPath === "infinity_locator_v1"
          ? "infinity_locator_v1" : "legacy_downstream_v1" };
  }
}

export function selectRetrievalBinding(input: {
  readonly questionId: string;
  readonly retrievalV2Request: FocusedLocatorRetrievalV2RequestSnapshot;
  readonly rollout: RetrievalAdmissionRollout;
}): RetrievalBinding {
  requireKnowledgeText(input.questionId, "questionId", 128);
  return RetrievalBinding.create({
    cutoverEpoch: requireCutoverEpoch(input.rollout.cutoverEpoch),
    profileFingerprint: requireSha256(
      input.rollout.infinityProfileFingerprint,
      "retrievalAdmission.infinityProfileFingerprint",
    ),
    request: input.retrievalV2Request,
    retrievalPath: "infinity_locator_v2",
  });
}

/** Compares durable V2 protocol values independently of JSON object key order. */
export function sameFocusedLocatorRetrievalV2Value(
  left: FocusedLocatorRetrievalV2RequestSnapshot | FocusedLocatorRetrievalV2ProviderBinding,
  right: FocusedLocatorRetrievalV2RequestSnapshot | FocusedLocatorRetrievalV2ProviderBinding,
): boolean {
  return JSON.stringify(canonicalRetrievalValue(left)) ===
    JSON.stringify(canonicalRetrievalValue(right));
}

function canonicalRetrievalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalRetrievalValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([leftKey], [rightKey]) =>
        compareRetrievalV2Utf8(leftKey, rightKey))
      .map(([key, nested]) => [key, canonicalRetrievalValue(nested)]),
  );
}

function freezeRetrievalV2Request(
  request: FocusedLocatorRetrievalV2RequestSnapshot,
): FocusedLocatorRetrievalV2RequestSnapshot {
  return deepFreeze(structuredClone(request));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function validateRetrievalV2Request(
  request: FocusedLocatorRetrievalV2RequestSnapshot | undefined,
): FocusedLocatorRetrievalV2RequestSnapshot {
  try {
    validateRetrievalV2RequestValue(request);
  } catch {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_BINDING",
      "persisted Retrieval V2 request is outside the consumer contract",
    );
  }
  return freezeRetrievalV2Request(request!);
}

function validateRetrievalV2RequestValue(value: unknown): void {
  const request = exactRetrievalObject(value, [
    "binding", "budgets", "filters", "queries", "schemaVersion", "scope",
    "softPreferences",
  ]);
  if (request.schemaVersion !== 2) {
    throw new TypeError("unsupported schema version");
  }
  validateRetrievalV2ProviderBinding(request.binding);
  validateRetrievalV2Budgets(request.budgets);
  validateRetrievalV2Filters(request.filters);
  validateRetrievalV2Queries(request.queries);
  validateRetrievalV2Scope(request.scope);
  validateRetrievalV2SoftPreferences(request.softPreferences);
}

function validateRetrievalV2ProviderBinding(value: unknown): void {
  const binding = exactRetrievalObject(value, [
    "capabilityFingerprint", "contractVersion", "indexProfileDigest", "profileId",
    "rankingPolicy", "requiredProviderLanes", "serviceRevision",
  ]);
  if (
    binding.contractVersion !== "context-retrieval.v2" ||
    binding.rankingPolicy !== "weighted_rrf_canonical_preferences.v1"
  ) {
    throw new TypeError("unsupported provider policy");
  }
  retrievalHash(binding.capabilityFingerprint);
  retrievalHash(binding.indexProfileDigest);
  retrievalOpaque(binding.profileId);
  retrievalOpaque(binding.serviceRevision);
  retrievalOpaqueArray(binding.requiredProviderLanes, 1, 4);
}

function validateRetrievalV2Budgets(value: unknown): void {
  const budgets = exactRetrievalObject(value, [
    "candidateLimit", "deadlineMs", "evidenceByteLimit", "neighborRadius",
    "responseByteLimit", "resultLimit",
  ]);
  const candidateLimit = retrievalInteger(budgets.candidateLimit, 1, 1_000);
  const resultLimit = retrievalInteger(budgets.resultLimit, 1, 50);
  if (
    resultLimit > candidateLimit ||
    retrievalInteger(budgets.neighborRadius, 0, 0) !== 0
  ) {
    throw new TypeError("invalid retrieval result bounds");
  }
  retrievalInteger(budgets.deadlineMs, 1, 2_000);
  retrievalInteger(budgets.responseByteLimit, 16_384, 1_048_576);
  retrievalInteger(
    budgets.evidenceByteLimit,
    1,
    retrievalV2ConsumerEvidenceByteLimit,
  );
}

function validateRetrievalV2Filters(value: unknown): void {
  const filters = exactRetrievalObject(value, [
    "actorKeys", "category", "documentKeys", "excludedSourceKeys", "kinds",
    "relativeTimeInterval", "sourceGenerations", "tagsAll", "tagsAny", "tagsNone",
    "timeInterval",
  ]);
  const actorKeys = retrievalOpaqueArray(filters.actorKeys);
  const documentKeys = retrievalOpaqueArray(filters.documentKeys);
  const excludedSourceKeys = retrievalOpaqueArray(filters.excludedSourceKeys);
  const kinds = retrievalOpaqueArray(filters.kinds);
  const tagsAll = retrievalOpaqueArray(filters.tagsAll);
  const tagsAny = retrievalOpaqueArray(filters.tagsAny);
  const tagsNone = retrievalOpaqueArray(filters.tagsNone);
  void actorKeys; void documentKeys; void kinds; void tagsAny;
  if (filters.category !== null) {
    retrievalOpaque(filters.category);
  }
  const sourceGenerations = retrievalArray(filters.sourceGenerations, 1, 100)
    .map((entry) => {
      const pair = exactRetrievalObject(entry, ["projectionGeneration", "sourceKey"]);
      return {
        projectionGeneration: retrievalOpaque(pair.projectionGeneration),
        sourceKey: retrievalOpaque(pair.sourceKey),
      };
    });
  retrievalSortedUnique(sourceGenerations.map(({ sourceKey }) => sourceKey));
  if (sourceGenerations.some((entry, index) => index > 0 &&
    compareRetrievalV2Utf8(sourceGenerations[index - 1]!.sourceKey, entry.sourceKey) >= 0)) {
    throw new TypeError("source generations are not ordered");
  }
  retrievalNoOverlap(
    sourceGenerations.map(({ sourceKey }) => sourceKey),
    excludedSourceKeys,
  );
  retrievalNoOverlap(tagsAll, tagsNone);
  const absolute = retrievalTimeInterval(filters.timeInterval);
  const relative = retrievalRelativeInterval(filters.relativeTimeInterval);
  if (absolute !== null && relative !== null) {
    throw new TypeError("hard filters mix time coordinates");
  }
}

function validateRetrievalV2Queries(value: unknown): void {
  const queries = retrievalArray(value, 1, 6).map((entry) => {
    const input = exactRetrievalObject(entry, ["query", "queryId"], ["weightMicros"]);
    const queryId = retrievalOpaque(input.queryId, 64);
    const query = retrievalNormalizedQuery(input.query);
    if (Object.hasOwn(input, "weightMicros")) {
      retrievalInteger(input.weightMicros, 100_000, 10_000_000);
    }
    return { query, queryId };
  });
  retrievalSortedUnique(queries.map(({ queryId }) => queryId));
}

function validateRetrievalV2Scope(value: unknown): void {
  const scope = exactRetrievalObject(value, ["memoryScopeId", "spaceId"], ["threadId"]);
  retrievalOpaque(scope.memoryScopeId);
  retrievalOpaque(scope.spaceId);
  if (Object.hasOwn(scope, "threadId") && scope.threadId !== null) {
    retrievalOpaque(scope.threadId);
  }
}

function validateRetrievalV2SoftPreferences(value: unknown): void {
  const preferences = exactRetrievalObject(value, [
    "actorPreferences", "relativeTimeInterval", "sourcePreferences", "timeInterval",
    "timeWeightMicros",
  ]);
  retrievalWeightedKeys(preferences.actorPreferences);
  retrievalWeightedKeys(preferences.sourcePreferences);
  const absolute = retrievalTimeInterval(preferences.timeInterval);
  const relative = retrievalRelativeInterval(preferences.relativeTimeInterval);
  const coordinateCount = Number(absolute !== null) + Number(relative !== null);
  if (
    coordinateCount > 1 ||
    (coordinateCount === 0) !== (preferences.timeWeightMicros === null)
  ) {
    throw new TypeError("soft preferences have inconsistent time evidence");
  }
  if (preferences.timeWeightMicros !== null) {
    retrievalInteger(preferences.timeWeightMicros, 100_000, 10_000_000);
  }
}

function retrievalWeightedKeys(value: unknown): void {
  const keys = retrievalArray(value, 0, 100).map((entry) => {
    const input = exactRetrievalObject(entry, ["key", "weightMicros"]);
    retrievalInteger(input.weightMicros, 100_000, 10_000_000);
    return retrievalOpaque(input.key);
  });
  retrievalSortedUnique(keys);
}

function retrievalTimeInterval(value: unknown): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  const interval = exactRetrievalObject(value, ["endAt", "startAt"]);
  const start = retrievalTimestamp(interval.startAt);
  const end = retrievalTimestamp(interval.endAt);
  if (retrievalTimestampOrder(start) > retrievalTimestampOrder(end)) {
    throw new TypeError("time interval is reversed");
  }
  return interval;
}

function retrievalRelativeInterval(value: unknown): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  const interval = exactRetrievalObject(value, ["endMs", "startMs"]);
  const start = retrievalInteger(interval.startMs, 0, Number.MAX_SAFE_INTEGER);
  const end = retrievalInteger(interval.endMs, 0, Number.MAX_SAFE_INTEGER);
  if (start > end) {
    throw new TypeError("relative interval is reversed");
  }
  return interval;
}

function exactRetrievalObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected object");
  }
  const input = value as Record<string, unknown>;
  const actual = Object.keys(input).toSorted(compareRetrievalV2Utf8);
  const allowed = [...required, ...optional].toSorted(compareRetrievalV2Utf8);
  if (
    actual.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(input, key))
  ) {
    throw new TypeError("object key set differs");
  }
  return input;
}

function retrievalArray(
  value: unknown,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new TypeError("array bound differs");
  }
  return value;
}

function retrievalOpaqueArray(
  value: unknown,
  minimum = 0,
  maximum = 100,
): readonly string[] {
  const values = retrievalArray(value, minimum, maximum)
    .map((item) => retrievalOpaque(item));
  retrievalSortedUnique(values);
  return values;
}

function retrievalSortedUnique(values: readonly string[]): void {
  if (values.some((value, index) => index > 0 &&
    compareRetrievalV2Utf8(values[index - 1]!, value) >= 0)) {
    throw new TypeError("identities are not sorted and unique");
  }
}

function retrievalNoOverlap(left: readonly string[], right: readonly string[]): void {
  if (left.some((value) => right.includes(value))) {
    throw new TypeError("identity sets overlap");
  }
}

function retrievalInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    !Number.isSafeInteger(value) || value < minimum || value > maximum
  ) {
    throw new TypeError("integer is outside bounds");
  }
  return value;
}

function retrievalHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("hash is malformed");
  }
  return value;
}

function retrievalOpaque(value: unknown, maximum = 256): string {
  if (typeof value !== "string") {
    throw new TypeError("opaque identity is not text");
  }
  const points = Array.from(value);
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      if (index + 1 >= value.length) {
        throw new TypeError("opaque identity contains malformed Unicode");
      }
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) {
        throw new TypeError("opaque identity contains malformed Unicode");
      }
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      throw new TypeError("opaque identity contains malformed Unicode");
    }
  }
  if (
    points.length < 1 || points.length > maximum ||
    retrievalPythonTrim(value) !== value ||
    points.some((point) => {
      const codePoint = point.codePointAt(0)!;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159);
    })
  ) {
    throw new TypeError("opaque identity is malformed");
  }
  return value;
}

function retrievalNormalizedQuery(value: unknown): string {
  const query = retrievalOpaque(value, 512);
  if (
    retrievalNormalizePythonWhitespace(query) !== query ||
    new TextEncoder().encode(query).byteLength > 512
  ) {
    throw new TypeError("query is not normalized or exceeds its UTF-8 budget");
  }
  return query;
}

function retrievalNormalizePythonWhitespace(value: string): string {
  const words: string[] = [];
  let word = "";
  for (const point of value) {
    if (retrievalPythonWhitespace(point.codePointAt(0)!)) {
      if (word.length > 0) {
        words.push(word);
        word = "";
      }
    } else {
      word += point;
    }
  }
  if (word.length > 0) {
    words.push(word);
  }
  return words.join(" ");
}

function retrievalPythonTrim(value: string): string {
  const points = Array.from(value);
  let start = 0;
  let end = points.length;
  while (start < end && retrievalPythonWhitespace(points[start]!.codePointAt(0)!)) {
    start += 1;
  }
  while (end > start && retrievalPythonWhitespace(points[end - 1]!.codePointAt(0)!)) {
    end -= 1;
  }
  return points.slice(start, end).join("");
}

function retrievalPythonWhitespace(codePoint: number): boolean {
  return (codePoint >= 9 && codePoint <= 13) || (codePoint >= 28 && codePoint <= 32) ||
    codePoint === 133 || codePoint === 160 || codePoint === 5_760 ||
    (codePoint >= 8_192 && codePoint <= 8_202) || codePoint === 8_232 ||
    codePoint === 8_233 || codePoint === 8_239 || codePoint === 8_287 ||
    codePoint === 12_288;
}

function retrievalTimestamp(value: unknown): string {
  const timestamp = retrievalOpaque(value);
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?Z$/u
    .exec(timestamp);
  if (match === null) {
    throw new TypeError("timestamp is malformed");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maximumDay = retrievalDaysInMonth(year, month);
  if (
    year < 1 || year > 9_999 || maximumDay === 0 || day < 1 || day > maximumDay ||
    Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
  ) {
    throw new TypeError("timestamp calendar value is invalid");
  }
  return timestamp;
}

function retrievalTimestampOrder(value: string): string {
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?Z$/u
    .exec(value)!;
  return `${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}` +
    (match[7] ?? "").padEnd(6, "0");
}

function retrievalDaysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    return 0;
  }
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}
