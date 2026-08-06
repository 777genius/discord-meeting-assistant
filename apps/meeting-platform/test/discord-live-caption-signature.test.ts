import { createHash } from "node:crypto";

import { renderRussianLiveCaptionsMarkdown } from "@discord-meeting/discord-adapter";
import { expect, it } from "vitest";

import { discordLiveCaptionSignature } from "../src/composition/discord-live-caption-signature.js";
import {
  type LiveCaptionSnapshot,
} from "@discord-meeting/meeting-core/live-meeting";

it("hashes the exact Markdown rendered for Discord live captions", () => {
  const captions: readonly LiveCaptionSnapshot[] = [
    {
      endMs: 4_200,
      isFinal: true,
      speakerId: "speaker-1",
      startMs: 1_000,
      text: "Первый участник подтвердил решение.",
    },
    {
      endMs: 5_500,
      isFinal: false,
      speakerId: "speaker-2",
      startMs: 4_300,
      text: "Вторая реплика еще уточняется.",
    },
  ];

  const expected = createHash("sha256")
    .update(renderRussianLiveCaptionsMarkdown(captions), "utf8")
    .digest("hex");

  expect(discordLiveCaptionSignature.calculate(captions)).toBe(expected);
});
