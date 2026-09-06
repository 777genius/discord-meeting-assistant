import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectOssPublication, type OssPublicationReads } from "../src/oss-publication-collection.js";
import { createObservedMeetingProjectionMarkers } from "../src/live-discord-projection-marker-contract.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";
import { campaignFixture } from "./oss-campaign-fixture.js";

describe("native Discord publication collection", () => {
  it("reads observer, exact message and attachments while excluding capability URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "oss-publication-test-"));
    try {
      const { plan } = await campaignFixture(root);
      const meetingId = "meeting-1", messageId = "123456789", channelId = plan.target.resultsChannelId;
      const marker = createObservedMeetingProjectionMarkers(meetingId, channelId)[1];
      const summary = Buffer.from("Title\nOverview\n[Recording](https://example.test/recordings/playback#secret-capability)");
      const transcript = Buffer.from("Complete ordered transcript");
      const nativeMessage = {
        id: messageId, channel_id: channelId, author: { id: plan.target.publicationApplicationId, bot: true },
        timestamp: "2026-09-06T12:00:00.000Z", edited_timestamp: null,
        attachments: [summary, transcript].map((bytes, index) => ({ id: String(index + 1),
          filename: index === 0 ? "meeting-summary.md" : "meeting-transcript.md", size: bytes.length,
          url: `https://cdn.discordapp.com/attachments/${channelId}/${index + 1}/file.md?ex=temporary-secret` })),
      };
      let downloads = 0;
      const observed = { id: messageId, authorId: plan.target.publicationApplicationId,
        createdAtMilliseconds: Date.parse(nativeMessage.timestamp), editedAtMilliseconds: null, content: "",
        embeds: [{ description: "", fields: [], title: "Title",
          url: `https://meeting-platform.invalid/projection/${encodeURIComponent(marker)}` }] };
      const messages = [observed];
      const reads: OssPublicationReads = {
        observer: { poll: async () => [{ container: { kind: "channel-message", parentChannelId: channelId }, messages }] },
        readChannel: async () => ({ id: channelId, guild_id: plan.target.guildId, type: 0 }),
        readMessage: async () => nativeMessage,
        download: async (url) => { downloads++; return url.includes("/1/") ? summary : transcript; },
      };
      const input = { plan, meetingId, messageId, startedAtMs: Date.parse(nativeMessage.timestamp) - 1000 };
      const result = await collectOssPublication(input, reads);
      expect(downloads).toBe(2);
      expect(result.attachments[0]).toMatchObject({ sha256: sha256(summary), text: "Title\nOverview\nRecording" });
      expect(result.attachments[1]?.text).toBe(transcript.toString());
      expect(JSON.stringify(result)).not.toMatch(/https?:|secret-capability|temporary-secret/u);
      messages.push({ ...observed, id: "987654321" });
      await expect(collectOssPublication(input, reads)).rejects.toThrow("duplicate");
      messages.pop();
      nativeMessage.attachments[0]!.url = "https://attacker.test/file";
      await expect(collectOssPublication(input, reads)).rejects.toThrow("origin");
      expect(downloads).toBe(2);
      await expect(collectOssPublication(input, { ...reads,
        readChannel: async () => ({ id: channelId, guild_id: "wrong", type: 0 }),
      })).rejects.toThrow("target");
    } finally { await rm(root, { recursive: true }); }
  });
});
