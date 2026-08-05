import {
  calculateLunaApiEquivalentCostRange,
  subscriptionRuntimeIncrementalModel,
  type SubscriptionRuntimeExecutionProfile,
  type SubscriptionRuntimeTelemetry,
  type SubscriptionRuntimeTokenAvailability,
  type SubscriptionRuntimeUsage,
} from "@discord-meeting/subscription-runtime-adapter";

export type TelemetryResult =
  | {
      readonly status: "available";
      readonly usage?: SubscriptionRuntimeUsage;
      readonly value: SubscriptionRuntimeTelemetry;
    }
  | { readonly status: "invalid" }
  | { readonly status: "missing" };

type TokenName =
  | "cacheWriteInputTokens"
  | "cachedInputTokens"
  | "inputTokens"
  | "outputTokens"
  | "reasoningOutputTokens"
  | "totalTokens";

type TokenValues = Record<TokenName, SubscriptionRuntimeTokenAvailability>;

const tokenNames: readonly TokenName[] = [
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
];

export function readTelemetry(input: unknown): TelemetryResult {
  if (input === undefined) {
    return { status: "missing" };
  }
  if (!isRecord(input)) {
    return { status: "invalid" };
  }
  return typeof input.source === "string"
    ? readStructuredTelemetry(input)
    : readLegacyTelemetry(input);
}

export function withLunaCostRange(
  telemetry: SubscriptionRuntimeTelemetry,
  profile: SubscriptionRuntimeExecutionProfile,
): SubscriptionRuntimeTelemetry {
  if (
    profile.model !== subscriptionRuntimeIncrementalModel ||
    telemetry.inputTokens.availability !== "measured" ||
    telemetry.cachedInputTokens.availability !== "measured" ||
    telemetry.outputTokens.availability !== "measured"
  ) {
    return telemetry;
  }
  return {
    ...telemetry,
    cost: calculateLunaApiEquivalentCostRange(telemetry),
  };
}

function readStructuredTelemetry(input: Record<string, unknown>): TelemetryResult {
  if (input.source !== "codex_exec_jsonl" && input.source !== "runtime_bridge") {
    return { status: "invalid" };
  }
  const tokenValues = readTokenValues(input, readTokenAvailability);
  return tokenValues === undefined
    ? { status: "invalid" }
    : completeTelemetry(input.source, tokenValues);
}

function readLegacyTelemetry(input: Record<string, unknown>): TelemetryResult {
  if (!tokenNames.some((name) => name in input)) {
    return { status: "missing" };
  }
  const tokenValues = readTokenValues(input, readLegacyTokenAvailability);
  return tokenValues === undefined
    ? { status: "invalid" }
    : completeTelemetry("runtime_bridge", tokenValues);
}

function readTokenValues(
  input: Record<string, unknown>,
  reader: (
    value: unknown,
    tokenName: TokenName,
  ) => SubscriptionRuntimeTokenAvailability | undefined,
): TokenValues | undefined {
  const tokenValues: Partial<TokenValues> = {};
  for (const tokenName of tokenNames) {
    const token = reader(input[tokenName], tokenName);
    if (token === undefined) {
      return undefined;
    }
    tokenValues[tokenName] = token;
  }
  return tokenValues as TokenValues;
}

function readLegacyTokenAvailability(
  input: unknown,
): SubscriptionRuntimeTokenAvailability | undefined {
  if (input === undefined) {
    return { availability: "unavailable" };
  }
  return isTokenCount(input)
    ? { availability: "measured", value: input }
    : undefined;
}

function readTokenAvailability(
  input: unknown,
  tokenName: TokenName,
): SubscriptionRuntimeTokenAvailability | undefined {
  if (!isRecord(input) || typeof input.availability !== "string") {
    return undefined;
  }
  if (input.availability === "unavailable") {
    return Object.keys(input).length === 1 ? { availability: "unavailable" } : undefined;
  }
  if (input.availability === "measured") {
    return Object.keys(input).length === 2 && isTokenCount(input.value)
      ? { availability: "measured", value: input.value }
      : undefined;
  }
  return readDerivedTokenAvailability(input, tokenName);
}

function readDerivedTokenAvailability(
  input: Record<string, unknown>,
  tokenName: TokenName,
): SubscriptionRuntimeTokenAvailability | undefined {
  if (input.availability !== "derived" || tokenName !== "totalTokens") {
    return undefined;
  }
  if (
    Object.keys(input).length !== 3 ||
    !isTokenCount(input.value) ||
    !Array.isArray(input.derivedFrom) ||
    input.derivedFrom.length !== 2 ||
    input.derivedFrom[0] !== "inputTokens" ||
    input.derivedFrom[1] !== "outputTokens"
  ) {
    return undefined;
  }
  return {
    availability: "derived",
    derivedFrom: ["inputTokens", "outputTokens"],
    value: input.value,
  };
}

function completeTelemetry(
  source: SubscriptionRuntimeTelemetry["source"],
  tokenValues: TokenValues,
): TelemetryResult {
  if (hasInvalidCacheInputDistribution(tokenValues)) {
    return { status: "invalid" };
  }
  if (hasInvalidReasoningOutputDistribution(tokenValues)) {
    return { status: "invalid" };
  }
  if (hasInvalidDerivedTotal(tokenValues)) {
    return { status: "invalid" };
  }
  if (hasInvalidMeasuredTotal(tokenValues)) {
    return { status: "invalid" };
  }
  const telemetry: SubscriptionRuntimeTelemetry = {
    cacheWriteInputTokens: tokenValues.cacheWriteInputTokens,
    cachedInputTokens: tokenValues.cachedInputTokens,
    inputTokens: tokenValues.inputTokens,
    outputTokens: tokenValues.outputTokens,
    reasoningOutputTokens: tokenValues.reasoningOutputTokens,
    source,
    totalTokens: tokenValues.totalTokens,
  };
  const usage = completeMeasuredUsage(telemetry);
  return {
    status: "available",
    ...(usage === undefined ? {} : { usage }),
    value: telemetry,
  };
}

function hasInvalidCacheInputDistribution(tokenValues: TokenValues): boolean {
  const inputTokens = measuredValue(tokenValues.inputTokens);
  const cachedInputTokens = measuredValue(tokenValues.cachedInputTokens);
  if (inputTokens === undefined || cachedInputTokens === undefined) {
    return false;
  }
  if (cachedInputTokens > inputTokens) {
    return true;
  }
  const cacheWriteInputTokens = measuredValue(tokenValues.cacheWriteInputTokens);
  return cacheWriteInputTokens !== undefined &&
    cachedInputTokens + cacheWriteInputTokens > inputTokens;
}

function hasInvalidReasoningOutputDistribution(tokenValues: TokenValues): boolean {
  const reasoningOutputTokens = measuredValue(tokenValues.reasoningOutputTokens);
  const outputTokens = measuredValue(tokenValues.outputTokens);
  return reasoningOutputTokens !== undefined &&
    outputTokens !== undefined &&
    reasoningOutputTokens > outputTokens;
}

function hasInvalidDerivedTotal(tokenValues: TokenValues): boolean {
  const totalTokens = tokenValues.totalTokens;
  if (totalTokens.availability !== "derived") {
    return false;
  }
  const inputTokens = measuredValue(tokenValues.inputTokens);
  const outputTokens = measuredValue(tokenValues.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) {
    return true;
  }
  const expectedTotal = inputTokens + outputTokens;
  return !Number.isSafeInteger(expectedTotal) || totalTokens.value !== expectedTotal;
}

function hasInvalidMeasuredTotal(tokenValues: TokenValues): boolean {
  const totalTokens = measuredValue(tokenValues.totalTokens);
  const inputTokens = measuredValue(tokenValues.inputTokens);
  const outputTokens = measuredValue(tokenValues.outputTokens);
  return totalTokens !== undefined &&
    inputTokens !== undefined &&
    outputTokens !== undefined &&
    totalTokens < inputTokens + outputTokens;
}

function completeMeasuredUsage(
  telemetry: SubscriptionRuntimeTelemetry,
): SubscriptionRuntimeUsage | undefined {
  const {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  } = telemetry;
  if (
    cacheWriteInputTokens.availability !== "measured" ||
    cachedInputTokens.availability !== "measured" ||
    inputTokens.availability !== "measured" ||
    outputTokens.availability !== "measured" ||
    reasoningOutputTokens.availability !== "measured" ||
    totalTokens.availability !== "measured"
  ) {
    return undefined;
  }
  return {
    cacheWriteInputTokens: cacheWriteInputTokens.value,
    cachedInputTokens: cachedInputTokens.value,
    inputTokens: inputTokens.value,
    outputTokens: outputTokens.value,
    reasoningOutputTokens: reasoningOutputTokens.value,
    totalTokens: totalTokens.value,
  };
}

function measuredValue(
  token: SubscriptionRuntimeTokenAvailability,
): number | undefined {
  return token.availability === "measured" ? token.value : undefined;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
