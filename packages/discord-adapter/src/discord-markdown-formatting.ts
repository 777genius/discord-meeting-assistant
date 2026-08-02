const discordSnowflake = /^\d{17,20}$/u;

export function formatDiscordTimestamp(milliseconds: number): string {
  const totalSeconds = Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.floor(milliseconds / 1_000)
    : 0;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const base = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours === 0 ? base : `${String(hours).padStart(2, "0")}:${base}`;
}

/**
 * Discord mention syntax is useful for attribution, while the message payload
 * always disables allowed mentions so it cannot notify participants.
 */
export function formatDiscordSpeaker(speakerId: string): string {
  const normalized = speakerId.trim();
  return discordSnowflake.test(normalized)
    ? `<@${normalized}>`
    : escapeDiscordMarkdown(normalized);
}

export function escapeDiscordMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(/([*_~`|>()])/gu, "\\$1")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

export function truncateDiscordGraphemes(value: string, maximumLength: number): string {
  if (maximumLength <= 0) {
    return "";
  }
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
    (segment) => segment.segment,
  );
  return graphemes.length <= maximumLength
    ? value
    : `${graphemes.slice(0, Math.max(0, maximumLength - 1)).join("")}…`;
}

export function truncateDiscordGraphemesByCodeUnits(value: string, maximumLength: number): string {
  if (maximumLength <= 0) {
    return "";
  }
  let result = "";
  for (const { segment } of new Intl.Segmenter(
    undefined,
    { granularity: "grapheme" },
  ).segment(value)) {
    if (result.length + segment.length > maximumLength) {
      break;
    }
    result += segment;
  }
  return result;
}

export function truncateDiscordCodeUnits(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  let sliced = value.slice(0, Math.max(0, maximumLength));
  const finalCodeUnit = sliced.charCodeAt(sliced.length - 1);
  if (finalCodeUnit >= 0xD800 && finalCodeUnit <= 0xDBFF) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}
