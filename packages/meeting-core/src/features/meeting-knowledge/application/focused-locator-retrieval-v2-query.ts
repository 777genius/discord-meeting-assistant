import { resolveRequestedActorAliases, type RetrievalActorAliasOwnerV1 } from
  "./speaker-alias-resolution.js";

export function relativeTimeFilter(question: string):
{ readonly endMs: number; readonly startMs: number } | null {
  const range = /(?:between|from|с)\s+(\d{1,2}):(\d{2})\s+(?:and|to|до|—|-)\s+(\d{1,2}):(\d{2})/iu
    .exec(question);
  if (range !== null) {
    const startMs = clockMs(range[1], range[2]);
    const endMs = clockMs(range[3], range[4]);
    return startMs < endMs ? Object.freeze({ endMs, startMs }) : null;
  }
  const first = /(?:first|первые?)\s+(\d{1,3})\s*(?:minutes?|минут)/iu.exec(question);
  const minutes = first?.[1] === undefined ? null : Number(first[1]);
  return minutes !== null && Number.isSafeInteger(minutes) && minutes > 0
    ? Object.freeze({ endMs: minutes * 60_000, startMs: 0 })
    : null;
}

export function boundedRetrievalQuery(value: string): string {
  let output = "";
  for (const character of value) {
    if (new TextEncoder().encode(output + character).byteLength > 512) {
      break;
    }
    output += character;
  }
  return output.trim();
}

export function redactRetrievalQueryIdentities(
  question: string,
  aliases: readonly RetrievalActorAliasOwnerV1[],
  requestedActorKeys: ReadonlySet<string>,
): string {
  let redacted = question
    .replace(/<(?:@!?|@&|#)\d{17,20}>/gu, "participant")
    .replace(/(?<!\d)\d{17,20}(?!\d)/gu, "participant");
  const matchedAliases = resolveRequestedActorAliases(question, aliases)
    .filter(({ actorKeys }) => actorKeys.some((actorKey) =>
      requestedActorKeys.has(actorKey)))
    .map(({ matchedAlias }) => matchedAlias);
  for (const owner of aliases) {
    if (!owner.actorKeys.some((actorKey) => requestedActorKeys.has(actorKey))) {
      continue;
    }
    for (const alias of owner.aliases) {
      if (/^\d{17,20}$/u.test(alias)) {
        continue;
      }
      redacted = redacted.replace(
        identityAliasPattern(alias),
        "participant",
      );
    }
  }
  for (const matchedAlias of matchedAliases) {
    redacted = redacted.replace(identityAliasPattern(matchedAlias), "participant");
  }
  return redacted;
}

function identityAliasPattern(alias: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(alias)}(?![\\p{L}\\p{N}])`,
    "giu",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function clockMs(minutes: string | undefined, seconds: string | undefined): number {
  return (Number(minutes ?? 0) * 60_000) + (Number(seconds ?? 0) * 1_000);
}
