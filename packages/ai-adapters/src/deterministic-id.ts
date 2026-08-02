export function deterministicAdapterId(
  kind:
    | "action"
    | "decision"
    | "summary"
    | "summary-request"
    | "summary-request-v2"
    | "transcript"
    | "transcription-request"
    | "turn",
  idempotencyKey: string,
  index?: number,
): string {
  const base = `${kind}:${idempotencyKey.length}:${idempotencyKey}`;
  return index === undefined ? base : `${base}:${index}`;
}
