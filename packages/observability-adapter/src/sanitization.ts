import type { LogFields } from "./contracts.js";

export const REDACTED_VALUE = "[REDACTED]";

const BINARY_VALUE = "[BINARY_REDACTED]";
const CIRCULAR_VALUE = "[CIRCULAR]";
const TRUNCATED_VALUE = "[TRUNCATED]";
const UNAVAILABLE_VALUE = "[UNAVAILABLE]";
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 4_096;

const SENSITIVE_KEY_PARTS = new Set([
  "audio",
  "auth",
  "authorization",
  "cookie",
  "key",
  "password",
  "prompt",
  "secret",
  "token",
  "transcription",
  "transcript",
]);

const PROVIDER_CONTENT_PARTS = new Set([
  "body",
  "completion",
  "content",
  "output",
  "payload",
  "response",
]);

function keyParts(key: string): readonly string[] {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length > 0);
}

function isSensitiveKey(key: string): boolean {
  const parts = keyParts(key);
  if (parts.some((part) => SENSITIVE_KEY_PARTS.has(part))) {
    return true;
  }

  return (
    (parts.includes("provider") || parts.includes("llm") || parts.includes("stt")) &&
    parts.some((part) => PROVIDER_CONTENT_PARTS.has(part))
  );
}

function boundedString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}${TRUNCATED_VALUE}`;
}

export function sanitizeLogMessage(message: string): string {
  return boundedString(message)
    .replaceAll(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, `Bearer ${REDACTED_VALUE}`)
    .replaceAll(
      /\b(authorization|auth|cookie|password|prompt|secret|token|transcript|audio|provider[ _-]?output)\s*[:=]\s*[^\s,;]+/giu,
      `$1=${REDACTED_VALUE}`,
    );
}

function errorCode(error: Error): string | undefined {
  const candidate = (error as Error & { readonly code?: unknown }).code;
  if (typeof candidate !== "string" || !/^[A-Z0-9_.:-]{1,64}$/u.test(candidate)) {
    return undefined;
  }

  return candidate;
}

function sanitizeError(
  error: Error,
  environment: LogEnvironment,
): Readonly<Record<string, unknown>> {
  const serialized: Record<string, unknown> = {
    name: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
      ? error.name
      : "Error",
  };
  const code = errorCode(error);
  if (code !== undefined) {
    serialized.code = code;
  }

  if (environment !== "production") {
    serialized.message = sanitizeLogMessage(error.message);
    if (error.stack !== undefined) {
      serialized.stack = sanitizeLogMessage(error.stack);
    }
  }

  return Object.freeze(serialized);
}

function sanitizeValue(
  value: unknown,
  environment: LogEnvironment,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return boundedString(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined") {
    return undefined;
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return UNAVAILABLE_VALUE;
  }

  if (value instanceof Error) {
    return sanitizeError(value, environment);
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return BINARY_VALUE;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? UNAVAILABLE_VALUE : value.toISOString();
  }

  if (depth >= MAX_DEPTH) {
    return TRUNCATED_VALUE;
  }

  if (seen.has(value)) {
    return CIRCULAR_VALUE;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, environment, seen, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(TRUNCATED_VALUE);
    }
    return Object.freeze(items);
  }

  const output: Record<string, unknown> = {};
  const keys = Object.keys(value).toSorted().slice(0, MAX_OBJECT_KEYS);
  for (const key of keys) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED_VALUE;
      continue;
    }

    try {
      output[key] = sanitizeValue(
        Reflect.get(value, key),
        environment,
        seen,
        depth + 1,
      );
    } catch {
      output[key] = UNAVAILABLE_VALUE;
    }
  }
  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    output.truncated = true;
  }

  return Object.freeze(output);
}

export type LogEnvironment = "development" | "production" | "test";

export function sanitizeLogFields(
  fields: LogFields,
  environment: LogEnvironment,
): LogFields {
  return sanitizeValue(fields, environment, new WeakSet(), 0) as LogFields;
}
