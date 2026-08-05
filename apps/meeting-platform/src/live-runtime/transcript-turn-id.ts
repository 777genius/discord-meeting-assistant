import { createHash } from "node:crypto";

import type { LiveTranscriptionEvent } from "./contracts.js";

export function stableLiveTranscriptTurnId(
  event: LiveTranscriptionEvent,
): string {
  const digest = createHash("sha256")
    .update(
      [
        event.meetingId,
        event.speakerId,
        event.startMs,
        event.endMs,
        event.text,
      ].join("\u0000"),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return `live-turn:v1:${digest}`;
}
