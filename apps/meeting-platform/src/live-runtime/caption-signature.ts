import { createHash } from "node:crypto";

import type {
  LiveCaptionSignature,
  LiveCaptionSnapshot,
} from "./contracts.js";

function captionSignature(captions: readonly LiveCaptionSnapshot[]): string {
  const canonical = captions
    .map((caption) => [
      caption.startMs,
      caption.endMs,
      caption.speakerId.length,
      caption.speakerId,
      caption.isFinal ? 1 : 0,
      visibleCaptionText(caption.text),
    ].join("\u0000"))
    .join("\u0001");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The fallback signature tracks the bounded visible part of a caption rather
 * than provider-only suffixes. Composition may inject a renderer-specific
 * signature when the publication adapter has stronger presentation knowledge.
 */
function visibleCaptionText(value: string): string {
  return Array.from(value.trim().replaceAll(/\s+/gu, " "))
    .slice(0, 280)
    .join("");
}

export const canonicalLiveCaptionSignature: LiveCaptionSignature = Object.freeze({
  calculate: captionSignature,
});
