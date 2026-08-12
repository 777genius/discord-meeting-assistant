import { describe, expect, it } from "vitest";

import {
  extractRecordingPlaybackLink,
  footerHasMarker,
  threadNameHasLegacyMarker,
} from "../src/discord-evidence-probe.js";

const marker = "meeting-projection:0123456789abcdef0123";
const capability = `v1.${Buffer.from("meeting-42").toString("base64url")}.${"s".repeat(43)}`;

describe("Discord projection marker compatibility", () => {
  it("accepts current human-readable and legacy thread suffixes", () => {
    expect(threadNameHasLegacyMarker("Итоги встречи [код 0123456789abcdef0123]", marker)).toBe(true);
    expect(threadNameHasLegacyMarker("Итоги встречи [0123456789abcdef0123]", marker)).toBe(true);
    expect(threadNameHasLegacyMarker("Итоги встречи [код ffffffffffffffffffff]", marker)).toBe(false);
  });

  it("accepts the hidden v3 marker and legacy thread metadata", () => {
    expect(footerHasMarker(
      "Meeting Platform · meeting summary",
      `https://meeting-platform.invalid/projection/${encodeURIComponent(marker)}`,
      marker,
    )).toBe(true);
    expect(footerHasMarker(marker, undefined, marker)).toBe(true);
    expect(footerHasMarker("Meeting Platform · meeting summary", undefined, marker, true)).toBe(true);
    expect(footerHasMarker("Meeting Platform · итог встречи", undefined, marker, true)).toBe(true);
    expect(footerHasMarker("unrelated", undefined, marker)).toBe(false);
  });
});

describe("Discord recording playback link extraction", () => {
  it.each([
    "Listen to the recording",
    "Прослушать запись",
    "Прослухати запис",
  ])("extracts and redacts the %s link", (label) => {
    const rawUrl = `https://recordings.example.com:8443/recordings/playback#${capability}`;
    const description = `# Summary\n\n## Recording\n[${label}](${rawUrl})`;

    expect(extractRecordingPlaybackLink(description)).toEqual({
      embedDescription: [
        "# Summary",
        "",
        "## Recording",
        `[${label}](https://recordings.example.com:8443/recordings/playback)`,
      ].join("\n"),
      recordingPlaybackUrl: rawUrl,
    });
  });

  it("rejects a missing, false, or duplicated recording link", () => {
    const validUrl = `https://recordings.example.com/recordings/playback#${capability}`;

    expect(() => extractRecordingPlaybackLink("# Summary")).toThrow(/exactly one/u);
    expect(() => extractRecordingPlaybackLink(`[Download](${validUrl})`)).toThrow(/exactly one/u);
    expect(() => extractRecordingPlaybackLink([
      `[Прослушать запись](${validUrl})`,
      `[Listen to the recording](${validUrl})`,
    ].join("\n"))).toThrow(/exactly one/u);
  });

  it.each([
    `http://recordings.example.com/recordings/playback#${capability}`,
    `https://user:password@recordings.example.com/recordings/playback#${capability}`,
    `https://recordings.example.com/not-playback#${capability}`,
    `https://recordings.example.com/recordings/playback?source=discord#${capability}`,
    "https://recordings.example.com/recordings/playback",
    "https://recordings.example.com/recordings/playback#signed-token",
  ])("rejects malformed playback target %s", (rawUrl) => {
    expect(() => extractRecordingPlaybackLink(
      `[Прослушать запись](${rawUrl})`,
    )).toThrow(/malformed/u);
  });

  it("rejects another playback target or repeated capability outside the link", () => {
    const rawUrl = `https://recordings.example.com/recordings/playback#${capability}`;

    expect(() => extractRecordingPlaybackLink([
      `[Прослушать запись](${rawUrl})`,
      `[Mirror](https://mirror.example.com/recordings/playback#${capability})`,
    ].join("\n"))).toThrow(/exactly one/u);
    expect(() => extractRecordingPlaybackLink(
      `[Прослушать запись](${rawUrl})\n${capability}`,
    )).toThrow(/outside its link target/u);
  });
});
