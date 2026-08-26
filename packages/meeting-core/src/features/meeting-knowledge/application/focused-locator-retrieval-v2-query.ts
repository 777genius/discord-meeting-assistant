import { identityAliasSpans, type IdentitySkeletonPortV1,
  type RetrievalActorAliasOwnerV1 } from
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
  skeletons?: IdentitySkeletonPortV1,
): string {
  let redacted = canonicalIdentityText(question)
    .replace(/<(?:@!?|@&|#)\d{17,20}>/gu, "participant")
    .replace(/(?<!\d)\d{17,20}(?!\d)/gu, "participant");
  for (const owner of aliases) {
    for (const alias of owner.aliases) {
      if (/^\d{17,20}$/u.test(alias)) {
        continue;
      }
      const spans = identityAliasSpans(redacted, alias, skeletons)
        .filter(({ certainty }) => certainty === "certain")
        .toSorted((left, right) => right.start - left.start);
      for (const span of spans) {
        redacted = redacted.slice(0, span.start) + "participant" +
          redacted.slice(span.end);
      }
    }
  }
  return redacted;
}

function canonicalIdentityText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function clockMs(minutes: string | undefined, seconds: string | undefined): number {
  return (Number(minutes ?? 0) * 60_000) + (Number(seconds ?? 0) * 1_000);
}
