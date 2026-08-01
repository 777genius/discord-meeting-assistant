import { AsyncLocalStorage } from "node:async_hooks";

export interface CorrelationContext {
  readonly requestId: string;
  readonly traceId?: string;
}

const correlationStorage = new AsyncLocalStorage<CorrelationContext>();
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function requireCorrelationId(value: string, field: string): string {
  if (!CORRELATION_ID_PATTERN.test(value)) {
    throw new TypeError(
      `${field} must be 1-128 URL-safe correlation characters`,
    );
  }

  return value;
}

function normalizeContext(context: CorrelationContext): CorrelationContext {
  const requestId = requireCorrelationId(context.requestId, "requestId");
  if (context.traceId === undefined) {
    return Object.freeze({ requestId });
  }

  return Object.freeze({
    requestId,
    traceId: requireCorrelationId(context.traceId, "traceId"),
  });
}

export function currentCorrelation(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

export function runWithCorrelation<T>(
  context: CorrelationContext,
  work: () => T,
): T {
  return correlationStorage.run(normalizeContext(context), work);
}
