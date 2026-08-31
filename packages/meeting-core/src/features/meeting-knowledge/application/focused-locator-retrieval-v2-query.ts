import { identityAliasSpans, type IdentitySkeletonPortV1,
  type RetrievalActorAliasOwnerV1 } from
  "./speaker-alias-resolution.js";

export type RelativeTimeFilterAdmission =
  | { readonly status: "absent" }
  | {
      readonly interval: { readonly endMs: number; readonly startMs: number };
      readonly status: "valid";
    }
  | { readonly status: "denied" };

const clockRangeIntent = /(?:between|from|с)\s+\S+\s+(?:and|to|до|—|-)\s+\S+/iu;
const firstMinutesIntent = /(?:first|первые?)\s+\S+\s*(?:minutes?|минут)/iu;

/**
 * Parses only the bounded relative-time grammar admitted by retrieval V2.
 * Recognized-but-malformed and reversed filters are denied, never weakened to
 * an unfiltered request.
 */
export function classifyRelativeTimeFilter(
  question: string,
): RelativeTimeFilterAdmission {
  const range = /(?:between|from|с)\s+(\d{1,3}):(\d{2})\s+(?:and|to|до|—|-)\s+(\d{1,3}):(\d{2})/iu
    .exec(question);
  if (range !== null) {
    const start = clockMs(range[1], range[2]);
    const end = clockMs(range[3], range[4]);
    if (start === null || end === null || start >= end) {
      return Object.freeze({ status: "denied" });
    }
    return Object.freeze({ interval: Object.freeze({ endMs: end, startMs: start }),
      status: "valid" });
  }
  if (clockRangeIntent.test(question)) {
    return Object.freeze({ status: "denied" });
  }
  const first = /(?:first|первые?)\s+(\d{1,6})\s*(?:minutes?|минут)/iu.exec(question);
  if (first !== null) {
    const minutes = Number(first[1]);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) {
      return Object.freeze({ status: "denied" });
    }
    return Object.freeze({ interval: Object.freeze({
      endMs: minutes * 60_000,
      startMs: 0,
    }), status: "valid" });
  }
  return Object.freeze({ status: firstMinutesIntent.test(question) ? "denied" : "absent" });
}

/** Legacy convenience for callers which already performed admission. */
export function relativeTimeFilter(question: string):
{ readonly endMs: number; readonly startMs: number } | null {
  const parsed = classifyRelativeTimeFilter(question);
  return parsed.status === "valid" ? parsed.interval : null;
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

function clockMs(minutes: string | undefined, seconds: string | undefined): number | null {
  const minuteValue = Number(minutes);
  const secondValue = Number(seconds);
  return Number.isSafeInteger(minuteValue) && minuteValue >= 0 && minuteValue <= 1_440 &&
    Number.isSafeInteger(secondValue) && secondValue >= 0 && secondValue < 60
    ? (minuteValue * 60_000) + (secondValue * 1_000)
    : null;
}
