import { createHash } from "node:crypto";

import { truncateDiscordGraphemesByCodeUnits } from "./discord-markdown-formatting.js";

const MARKER_PREFIX = "meeting-projection:";
const projectionMarkerUrlBase = "https://meeting-platform.invalid/projection/";
const recoveryThreadPrefix = "Meeting Platform recovery ";

export function createProjectionMarker(projectionKey: string): string {
  const digest = createHash("sha256").update(projectionKey, "utf8").digest("hex").slice(0, 20);
  return `${MARKER_PREFIX}${digest}`;
}

/**
 * The marker is deliberately carried in the projection embed metadata rather
 * than the visible thread name. A stable, human title is easier to scan and
 * does not leak an implementation digest into Discord's UI.
 */
export function createDiscordThreadName(title: string): string {
  return truncateDiscordGraphemesByCodeUnits(title.trim(), 100);
}

/**
 * A short-lived thread name used only between Discord's create acknowledgement
 * and the first marker-bearing message. It makes an unknown create outcome
 * recoverable without relying on a non-unique human meeting title. A successful
 * publication immediately replaces it with `createDiscordThreadName`.
 */
export function createDiscordThreadRecoveryName(marker: string): string {
  return truncateDiscordGraphemesByCodeUnits(
    `${recoveryThreadPrefix}${marker.slice(-20)}`,
    100,
  );
}

/**
 * Discord renders an embed URL only when there is a linked title. Projection
 * embeds have no title, so this stores an opaque reconciliation marker without
 * exposing it in the visible summary or thread name.
 */
export function createProjectionMarkerUrl(marker: string): string {
  return `${projectionMarkerUrlBase}${encodeURIComponent(marker)}`;
}
