export function deterministicAdapterId(
  kind:
    | "action"
    | "decision"
    | "question"
    | "summary"
    | "summary-request"
    | "summary-request-v2"
    | "summary-request-v3"
    | "transcript"
    | "transcription-request"
    | "turn",
  idempotencyKey: string,
  index?: number,
): string {
  const base = `${kind}:${idempotencyKey.length}:${idempotencyKey}`;
  return index === undefined ? base : `${base}:${index}`;
}
