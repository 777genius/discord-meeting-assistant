import {
  isRecord,
  isTokenCount,
} from "./audited-xhigh-policy.mjs";

const tokenNames = Object.freeze([
  "input_tokens",
  "cached_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
]);

export function codexExecJsonlCompatibilityAgentMessage(line) {
  try {
    const event = JSON.parse(line);
    if (
      !isRecord(event) ||
      event.type !== "item.completed" ||
      !isRecord(event.item) ||
      event.item.type !== "agent_message" ||
      typeof event.item.text !== "string"
    ) {
      return;
    }
    return {
      type: "agent_message",
      role: "assistant",
      text: event.item.text,
    };
  } catch {
    return;
  }
}

export function codexExecJsonlUsage(line) {
  try {
    const event = JSON.parse(line);
    if (!isRecord(event) || event.type !== "turn.completed" || !isRecord(event.usage)) {
      return;
    }
    if (!tokenNames.every((name) => isTokenCount(event.usage[name]))) {
      return;
    }
    return {
      cachedInputTokens: event.usage.cached_input_tokens,
      inputTokens: event.usage.input_tokens,
      outputTokens: event.usage.output_tokens,
      reasoningOutputTokens: event.usage.reasoning_output_tokens,
    };
  } catch {
    return;
  }
}

export function attachCodexJsonlTelemetry(result, usage) {
  if (!isRecord(result)) {
    return;
  }
  const currentTelemetry = result.telemetry;
  if (currentTelemetry !== undefined && !isRecord(currentTelemetry)) {
    return;
  }
  if (isCompleteBridgeUsage(currentTelemetry?.usage)) {
    return result;
  }
  const telemetry = codexJsonlTelemetry(usage);
  if (telemetry === undefined) {
    return;
  }
  return {
    ...result,
    telemetry: {
      ...currentTelemetry,
      usage: telemetry,
    },
  };
}

export function parseBridgeResultJson(output) {
  try {
    const result = JSON.parse(output);
    if (!isRecord(result) || result.protocolVersion !== 1 || !Array.isArray(result.warnings)) {
      return;
    }
    if (result.status === "completed") {
      if (typeof result.outputText === "string" && isRecord(result.structuredOutput)) {
        return result;
      }
      return;
    }
    if (result.status === "failed" && isRecord(result.failure)) {
      return result;
    }
    return;
  } catch {
    return;
  }
}

export function codexJsonlTelemetry(usage) {
  if (
    !isRecord(usage) ||
    !isTokenCount(usage.inputTokens) ||
    !isTokenCount(usage.cachedInputTokens) ||
    !isTokenCount(usage.outputTokens) ||
    !isTokenCount(usage.reasoningOutputTokens)
  ) {
    return;
  }
  const totalTokens = usage.inputTokens + usage.outputTokens;
  if (!Number.isSafeInteger(totalTokens)) {
    return;
  }
  return {
    source: "codex_exec_jsonl",
    cacheWriteInputTokens: { availability: "unavailable" },
    cachedInputTokens: {
      availability: "measured",
      value: usage.cachedInputTokens,
    },
    inputTokens: { availability: "measured", value: usage.inputTokens },
    outputTokens: { availability: "measured", value: usage.outputTokens },
    reasoningOutputTokens: {
      availability: "measured",
      value: usage.reasoningOutputTokens,
    },
    totalTokens: {
      availability: "derived",
      derivedFrom: ["inputTokens", "outputTokens"],
      value: totalTokens,
    },
  };
}

export function isCodexUsage(value) {
  return (
    isRecord(value) &&
    isTokenCount(value.inputTokens) &&
    isTokenCount(value.cachedInputTokens) &&
    isTokenCount(value.outputTokens) &&
    isTokenCount(value.reasoningOutputTokens)
  );
}

function isCompleteBridgeUsage(value) {
  if (!isRecord(value)) {
    return false;
  }
  const completeTokenNames = [
    "cacheWriteInputTokens",
    "cachedInputTokens",
    "inputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ];
  return completeTokenNames.every((name) => isTokenCount(value[name]));
}
