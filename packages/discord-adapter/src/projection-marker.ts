import { createHash } from "node:crypto";

import { truncateDiscordGraphemesByCodeUnits } from "./discord-markdown-formatting.js";

const MARKER_PREFIX = "meeting-projection:";
const REFERENCE_PREFIX = "код ";

export function createProjectionMarker(projectionKey: string): string {
  const digest = createHash("sha256").update(projectionKey, "utf8").digest("hex").slice(0, 20);
  return `${MARKER_PREFIX}${digest}`;
}

export function createDiscordThreadName(title: string, marker: string): string {
  const suffix = ` [${REFERENCE_PREFIX}${marker.slice(-20)}]`;
  const maximumTitleLength = 100 - suffix.length;
  return `${truncateDiscordGraphemesByCodeUnits(title, maximumTitleLength)}${suffix}`;
}
