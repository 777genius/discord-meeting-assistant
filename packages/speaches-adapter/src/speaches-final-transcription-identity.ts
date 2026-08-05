export function createSpeachesStableId(
  kind: string,
  idempotencyKey: string,
  ...parts: readonly string[]
): string {
  return [kind, "v1", encodeIdentityPart(idempotencyKey), ...parts.map(encodeIdentityPart)].join(":");
}

function encodeIdentityPart(value: string): string {
  return `${value.length}:${value}`;
}
