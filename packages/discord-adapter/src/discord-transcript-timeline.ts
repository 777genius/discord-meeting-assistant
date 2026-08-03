import {
  escapeDiscordMarkdown,
  formatDiscordSpeaker,
  formatDiscordTimestamp,
  truncateDiscordGraphemes,
  truncateDiscordGraphemesByCodeUnits,
} from "./discord-markdown-formatting.js";

/**
 * Presentation-only shape shared by derived live captions and the
 * authoritative final transcript. It deliberately does not depend on a
 * provider-specific turn model.
 */
export interface DiscordTranscriptTimelineEntry {
  readonly endMs: number;
  readonly isFinal?: boolean;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
}

export type DiscordTranscriptTimelineKind = "final" | "live";

const discordTimelineDescriptionLimit = 1_900;
const maximumTimelineEntryCodeUnits = 320;
const maximumTimelineEntryGraphemes = 280;

const liveTimeline = {
  footer: "_✓ - finalized; … - being refined. History remains until final reconciliation._",
  heading: "## 🎙️ Meeting captions",
} as const;

const finalTimeline = {
  footer: "_Final transcript based on the meeting recording._",
  heading: "## 🗣️ Meeting transcript",
} as const;

/**
 * Renders a bounded, chronological transcript timeline for the one mutable
 * Discord message. If the timeline cannot fit, retain the opening and newest
 * contiguous history and explain the omission instead of silently replacing
 * the whole view with a placeholder.
 */
export function renderRussianTranscriptTimelineMarkdown(
  entries: readonly DiscordTranscriptTimelineEntry[],
  kind: DiscordTranscriptTimelineKind,
): string {
  const frame = kind === "live" ? liveTimeline : finalTimeline;
  const orderedEntries = entries
    .filter(({ text }) => text.trim().length > 0)
    .toSorted(compareTimelineEntries);

  if (orderedEntries.length === 0) {
    return [
      frame.heading,
      "",
      "No captions recognized yet.",
      "",
      frame.footer,
    ].join("\n");
  }

  const budget = discordTimelineDescriptionLimit - frame.heading.length - frame.footer.length - 4;
  const body = selectTimelineEntries(orderedEntries, budget, kind);
  return [frame.heading, "", ...body, "", frame.footer].join("\n");
}

function selectTimelineEntries(
  entries: readonly DiscordTranscriptTimelineEntry[],
  budget: number,
  kind: DiscordTranscriptTimelineKind,
): readonly string[] {
  const rendered = new Map<number, string>();
  const renderAt = (index: number): string => {
    const existing = rendered.get(index);
    if (existing !== undefined) {
      return existing;
    }
    const line = renderTimelineEntry(entries[index]!, kind);
    rendered.set(index, line);
    return line;
  };
  const complete: string[] = [];
  let completeLength = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const line = renderAt(index);
    const nextLength = completeLength + (complete.length === 0 ? 0 : 1) + line.length;
    if (nextLength > budget) {
      break;
    }
    complete.push(line);
    completeLength = nextLength;
  }
  if (complete.length === entries.length) {
    return complete;
  }

  const first = renderAt(0);
  const tail: string[] = [];
  for (let index = entries.length - 1; index >= 1; index -= 1) {
    const omittedCount = index - 1;
    const candidate = [first, collapsedHistoryNotice(omittedCount), renderAt(index), ...tail];
    if (candidate.join("\n").length > budget) {
      break;
    }
    tail.unshift(renderAt(index));
  }

  if (tail.length > 0) {
    const omittedCount = entries.length - tail.length - 1;
    return [first, collapsedHistoryNotice(omittedCount), ...tail];
  }

  const firstBudget = Math.max(1, budget - collapsedHistoryNotice(entries.length - 1).length - 1);
  return [
    truncateTimelineLine(first, firstBudget),
    collapsedHistoryNotice(entries.length - 1),
  ];
}

function collapsedHistoryNotice(omittedCount: number): string {
  return omittedCount <= 0
    ? "_… Captions were shortened due to Discord's limit._"
    : `_… ${omittedCount} captions did not fit. Showing the beginning and most recent captions._`;
}

function renderTimelineEntry(
  entry: DiscordTranscriptTimelineEntry,
  kind: DiscordTranscriptTimelineKind,
): string {
  const state = kind === "live" && entry.isFinal === false ? "…" : "✓";
  const interval = `${formatDiscordTimestamp(entry.startMs)}-${formatDiscordTimestamp(entry.endMs)}`;
  const text = escapeDiscordMarkdown(
    truncateDiscordGraphemes(
      entry.text.trim().replaceAll(/\s+/gu, " "),
      maximumTimelineEntryGraphemes,
    ),
  );
  return truncateTimelineLine(
    `${state} \`${interval}\` **${formatDiscordSpeaker(entry.speakerId)}:** ${text}`,
    maximumTimelineEntryCodeUnits,
  );
}

function truncateTimelineLine(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  if (maximumLength <= 1) {
    return "…";
  }
  return `${truncateDiscordGraphemesByCodeUnits(value, maximumLength - 1).trimEnd()}…`;
}

function compareTimelineEntries(
  left: DiscordTranscriptTimelineEntry,
  right: DiscordTranscriptTimelineEntry,
): number {
  return left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    left.speakerId.localeCompare(right.speakerId) ||
    left.text.localeCompare(right.text) ||
    Number(left.isFinal === false) - Number(right.isFinal === false);
}
