import { createHash } from "node:crypto";

const MARKER_PREFIX = "meeting-projection:";

export function createProjectionMarker(projectionKey: string): string {
  const digest = createHash("sha256").update(projectionKey, "utf8").digest("hex").slice(0, 20);
  return `${MARKER_PREFIX}${digest}`;
}

export function createDiscordThreadName(title: string, marker: string): string {
  const suffix = ` [${marker.slice(-20)}]`;
  const titleGraphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(title),
    (segment) => segment.segment,
  );
  const maximumTitleLength = 100 - suffix.length;
  return `${titleGraphemes.slice(0, maximumTitleLength).join("")}${suffix}`;
}
