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
export type DiscordTranscriptLocale = "en" | "ru" | "uk";

const discordTimelineDescriptionLimit = 1_900;
const maximumTimelineEntryCodeUnits = 320;
const maximumTimelineEntryGraphemes = 280;

export const finalTranscriptAttachmentFilename = "meeting-transcript.md";

const liveTimeline = {
  empty: "No captions recognized yet.",
  footer: "_✓ - finalized; … - being refined. History remains until final reconciliation._",
  heading: "## 🎙️ Meeting captions",
} as const;

const finalTimelines = {
  en: {
    attachmentEmpty: "No transcript turns were recorded.",
    attachmentHeading: "# Meeting transcript",
    attachmentIntro: "_Final transcript based on the meeting recording._",
    empty: "No captions recognized yet.",
    footer: `_Final transcript based on the meeting recording. Full transcript attached: \`${finalTranscriptAttachmentFilename}\`._`,
    heading: "## 🗣️ Meeting transcript",
  },
  ru: {
    attachmentEmpty: "Реплики в транскрипте не зафиксированы.",
    attachmentHeading: "# Транскрипт встречи",
    attachmentIntro: "_Финальный транскрипт составлен по записи встречи._",
    empty: "Реплики пока не распознаны.",
    footer: `_Финальный транскрипт составлен по записи встречи. Полная версия приложена: \`${finalTranscriptAttachmentFilename}\`._`,
    heading: "## 🗣️ Транскрипт встречи",
  },
  uk: {
    attachmentEmpty: "Репліки в транскрипті не зафіксовані.",
    attachmentHeading: "# Транскрипт зустрічі",
    attachmentIntro: "_Фінальний транскрипт складено за записом зустрічі._",
    empty: "Репліки ще не розпізнані.",
    footer: `_Фінальний транскрипт складено за записом зустрічі. Повну версію додано: \`${finalTranscriptAttachmentFilename}\`._`,
    heading: "## 🗣️ Транскрипт зустрічі",
  },
} as const;

/**
 * Renders a bounded, chronological transcript timeline for the active Discord
 * projection. If the timeline cannot fit, retain the opening and newest
 * contiguous history and explain the omission instead of silently replacing
 * the whole view with a placeholder.
 */
export function renderRussianTranscriptTimelineMarkdown(
  entries: readonly DiscordTranscriptTimelineEntry[],
  kind: DiscordTranscriptTimelineKind,
  locale: DiscordTranscriptLocale = "en",
): string {
  const frame = kind === "live" ? liveTimeline : finalTimelines[locale];
  const orderedEntries = orderedTranscriptEntries(entries);

  if (orderedEntries.length === 0) {
    return [
      frame.heading,
      "",
      frame.empty,
      "",
      frame.footer,
    ].join("\n");
  }

  const budget = discordTimelineDescriptionLimit - frame.heading.length - frame.footer.length - 4;
  const body = selectTimelineEntries(orderedEntries, budget, kind, locale);
  return [frame.heading, "", ...body, "", frame.footer].join("\n");
}

/**
 * Produces the complete, human-readable authoritative transcript for the
 * attachment on the final summary message. It intentionally does not inherit
 * Discord's embed-description limit and never exposes internal evidence IDs.
 */
export function renderRussianFinalTranscriptAttachmentMarkdown(
  entries: readonly DiscordTranscriptTimelineEntry[],
  locale: DiscordTranscriptLocale = "en",
): string {
  const orderedEntries = orderedTranscriptEntries(entries);
  const copy = finalTimelines[locale];
  const lines = [
    copy.attachmentHeading,
    "",
    copy.attachmentIntro,
  ];

  if (orderedEntries.length === 0) {
    lines.push("", copy.attachmentEmpty);
    return lines.join("\n");
  }

  for (const entry of orderedEntries) {
    const interval = `${formatDiscordTimestamp(entry.startMs)}-${formatDiscordTimestamp(entry.endMs)}`;
    lines.push(
      "",
      `## \`${interval}\` · ${formatDiscordSpeaker(entry.speakerId)}`,
      "",
      escapeTranscriptAttachmentMarkdown(entry.text),
    );
  }
  return lines.join("\n");
}

function selectTimelineEntries(
  entries: readonly DiscordTranscriptTimelineEntry[],
  budget: number,
  kind: DiscordTranscriptTimelineKind,
  locale: DiscordTranscriptLocale,
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
    const candidate = [
      first,
      collapsedHistoryNotice(omittedCount, kind, locale),
      renderAt(index),
      ...tail,
    ];
    if (candidate.join("\n").length > budget) {
      break;
    }
    tail.unshift(renderAt(index));
  }

  if (tail.length > 0) {
    const omittedCount = entries.length - tail.length - 1;
    return [first, collapsedHistoryNotice(omittedCount, kind, locale), ...tail];
  }

  const firstBudget = Math.max(
    1,
    budget - collapsedHistoryNotice(entries.length - 1, kind, locale).length - 1,
  );
  return [
    truncateTimelineLine(first, firstBudget),
    collapsedHistoryNotice(entries.length - 1, kind, locale),
  ];
}

function collapsedHistoryNotice(
  omittedCount: number,
  kind: DiscordTranscriptTimelineKind,
  locale: DiscordTranscriptLocale,
): string {
  if (kind === "final") {
    if (locale === "ru") {
      return omittedCount <= 0
        ? `_… Полный транскрипт приложен: \`${finalTranscriptAttachmentFilename}\`._`
        : `_… Ещё ${omittedCount} реплик доступны в приложенном полном транскрипте._`;
    }
    if (locale === "uk") {
      return omittedCount <= 0
        ? `_… Повний транскрипт додано: \`${finalTranscriptAttachmentFilename}\`._`
        : `_… Ще ${omittedCount} реплік доступні в доданому повному транскрипті._`;
    }
    return omittedCount <= 0
      ? `_… Full transcript attached: \`${finalTranscriptAttachmentFilename}\`._`
      : `_… ${omittedCount} captions are available in the attached full transcript._`;
  }
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
    truncateDiscordGraphemes(normalizeTranscriptText(entry.text), maximumTimelineEntryGraphemes),
  );
  return truncateTimelineLine(
    `${state} \`${interval}\` **${formatDiscordSpeaker(entry.speakerId)}:** ${text}`,
    maximumTimelineEntryCodeUnits,
  );
}

function orderedTranscriptEntries(
  entries: readonly DiscordTranscriptTimelineEntry[],
): readonly DiscordTranscriptTimelineEntry[] {
  return entries
    .filter(({ text }) => text.trim().length > 0)
    .toSorted(compareTimelineEntries);
}

function normalizeTranscriptText(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

function escapeTranscriptAttachmentMarkdown(value: string): string {
  return value
    .trim()
    .split(/\r?\n/gu)
    .map((line) => escapeDiscordMarkdown(line).replaceAll("#", "\\#"))
    .join("\n");
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
