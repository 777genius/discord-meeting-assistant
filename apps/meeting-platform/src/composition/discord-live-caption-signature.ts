import { createHash } from "node:crypto";

import { renderRussianLiveCaptionsMarkdown } from "@discord-meeting/discord-adapter";
import {
  type LiveCaptionSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";

function calculateDiscordLiveCaptionSignature(
  captions: readonly LiveCaptionSnapshot[],
): string {
  return createHash("sha256")
    .update(renderRussianLiveCaptionsMarkdown(captions), "utf8")
    .digest("hex");
}

/**
 * Production projection identity: schedule an edit only when the exact
 * Markdown sent by the Discord adapter changes.
 */
export const discordLiveCaptionSignature = Object.freeze({
  calculate: calculateDiscordLiveCaptionSignature,
});
