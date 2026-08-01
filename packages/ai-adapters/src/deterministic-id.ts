export function deterministicAdapterId(
  kind:
    | "action"
    | "decision"
    | "summary"
    | "summary-request"
    | "transcript"
    | "transcription-request"
    | "turn",
  idempotencyKey: string,
  index?: number,
): string {
  const base = `${kind}:${idempotencyKey.length}:${idempotencyKey}`;
  return index === undefined ? base : `${base}:${index}`;
}
