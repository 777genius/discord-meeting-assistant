import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectOssPublication, type OssPublicationReads } from "../src/oss-publication-collection.js";
import { createObservedMeetingProjectionMarkers } from "../src/live-discord-projection-marker-contract.js";
import { verifyOssCampaign } from "../src/oss-campaign-verification.js";
import { loadArchive, sha256 } from "../src/oss-campaign-artifacts.js";
import { campaignFixture } from "./oss-campaign-fixture.js";

describe("native Discord publication collection", () => {
  it("reads observer, exact message and attachments while excluding capability URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "oss-publication-test-"));
    try {
      const { plan } = await campaignFixture(root);
      const meetingId = "meeting-1", messageId = "1546407998778511380", channelId = plan.target.resultsChannelId;
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
      const input = { plan, meetingId, messageId: `discord:v2:channel:${channelId}:message:${messageId}`, startedAtMs: Date.parse(nativeMessage.timestamp) - 1000 };
      const result = await collectOssPublication(input, reads);
      for (const reference of [
        messageId,
        `discord:v2:channel:1533228891827736658:message:${messageId}`,
        `discord:v2:thread:${channelId}:message:${messageId}`,
        `discord:v1:thread:${channelId}:message:${messageId}`,
        `${input.messageId}:extra`,
      ]) {
        await expect(collectOssPublication({ ...input, messageId: reference }, {
          ...reads, readChannel: async () => { throw new Error("Unexpected read"); },
        })).rejects.toThrow("Invalid publication reference");
      }
      await expect(collectOssPublication({ ...input,
        messageId: `discord:v2:channel:${channelId}:message:1546407998778511381`,
      }, reads)).rejects.toThrow("duplicate");
      expect(downloads).toBe(2);
      expect(result.attachments[0]).toMatchObject({ sha256: sha256(summary), text: "Title\nOverview\nRecording" });
      expect(result.attachments[1]?.text).toBe(transcript.toString());
      expect(JSON.stringify(result)).not.toMatch(/https?:|secret-capability|temporary-secret/u);
      for (const change of [
        { id: "1546407998778511381" },
        { channel_id: "1533228891827736658" },
        { author: { id: "1533224474609057794", bot: true } },
        { timestamp: "2026-09-06T11:59:58.000Z" },
        { timestamp: "2026-09-06T12:00:01.000Z" },
      ]) {
        await expect(collectOssPublication(input, { ...reads,
          readMessage: async () => ({ ...nativeMessage, ...change }),
        })).rejects.toThrow("identity mismatch");
      }
      for (const change of [
        { authorId: "1533224474609057794" }, { embeds: [] },
      ]) {
        await expect(collectOssPublication(input, { ...reads, observer: { poll: async () => [{
          container: { kind: "channel-message", parentChannelId: channelId },
          messages: [{ ...observed, ...change }],
        }] } })).rejects.toThrow("Missing/duplicate");
      }
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

it("verifies collected canonical references without changing stored references or minting PASS", async () => {
  const root = await mkdtemp(join(tmpdir(), "oss-publication-verification-"));
  try {
    const fixture = await campaignFixture(root);
    for (const run of fixture.runs) {
      const database = fixture.files.get(run.databasePath)!.value as {
        snapshot: { transcript: object; publication: { externalPublicationId: string } }
      };
      Object.assign(database.snapshot.transcript, { version: 1, recordingId: run.recordingId });
      const storedReference = database.snapshot.publication.externalPublicationId;
      const { messageId, channelId, authorId, createdAtMs } = run.publication;
      const marker = createObservedMeetingProjectionMarkers(run.meetingId, channelId)[1];
      const bytes = [run.publication.summaryAttachmentPath, run.publication.transcriptAttachmentPath]
        .map((path) => fixture.files.get(path)!.value as Buffer);
      const capture = await collectOssPublication({ plan: fixture.plan, meetingId: run.meetingId,
        messageId: storedReference, startedAtMs: run.startedAtMs }, {
        observer: { poll: async () => [{ container: { kind: "channel-message", parentChannelId: channelId },
          messages: [{ id: messageId, authorId, createdAtMilliseconds: createdAtMs,
            editedAtMilliseconds: null, content: "", embeds: [{ title: "Title", description: "", fields: [], footerText: marker }] }] }] },
        readChannel: async () => ({ id: channelId, guild_id: fixture.plan.target.guildId, type: 0 }),
        readMessage: async (channel, message) => {
          expect([channel, message]).toEqual([channelId, messageId]);
          return { id: message, channel_id: channel, author: { id: authorId, bot: true },
            timestamp: new Date(createdAtMs).toISOString(), edited_timestamp: null,
            attachments: bytes.map((body, i) => ({ id: String(i + 1), size: body.length,
              filename: i === 0 ? "meeting-summary.md" : "meeting-transcript.md",
              url: `https://cdn.discordapp.com/attachments/${channelId}/${i + 1}/file.md` })) };
        },
        download: async (url) => bytes[url.includes("/1/") ? 0 : 1]!,
      });
      Object.assign(run.publication, { messageId: capture.messageId, channelId: capture.channelId,
        authorId: capture.authorId, createdAtMs: capture.createdAtMs });
      for (const [i, path] of [run.publication.summaryAttachmentPath, run.publication.transcriptAttachmentPath].entries()) {
        fixture.files.get(path)!.value = Buffer.from(capture.attachments[i]!.text);
      }
      expect(database.snapshot.publication.externalPublicationId).toBe(storedReference);
    }
    const verify = async () => {
      await fixture.save();
      return verifyOssCampaign(await loadArchive(fixture.planPath, root), fixture.manifestBytes);
    };
    expect(await verify()).toMatchObject({ status: "sources-unverified", consistency: "incomplete" });
    const database = fixture.files.get(fixture.runs[0]!.databasePath)!.value as {
      snapshot: { publication: { externalPublicationId: string } }
    };
    expect(database.snapshot.publication.externalPublicationId)
      .toBe("discord:v2:channel:1533228891827736657:message:1546407998778511380");
    for (const reference of [
      "1546407998778511380",
      "discord:v2:channel:1533228891827736658:message:1546407998778511380",
      "discord:v2:thread:1533228891827736657:message:1546407998778511380",
      "discord:v1:thread:1533228891827736657:message:1546407998778511380",
      "discord:v2:channel:1533228891827736657:message:1546407998778511380:extra",
      "discord:v2:channel:1533228891827736657:message:1546407998778511381",
    ]) {
      database.snapshot.publication.externalPublicationId = reference;
      await expect(verify()).rejects.toThrow(/publication reference|snapshot disagrees/u);
    }
  } finally { await rm(root, { recursive: true }); }
}, 60_000);
