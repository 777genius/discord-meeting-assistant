import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  observeFirstSeenLiveDiscordPlaybackLink,
  type LiveDiscordPlaybackLinkClock,
  type LiveDiscordPollTiming,
} from "../src/live-discord-playback-link-observer.js";
import type {
  LiveDiscordMessageInput,
  LiveDiscordProjectionMessages,
  LiveDiscordProjectionReader,
} from "../src/live-discord-observer.js";

const marker = "meeting-projection:0123456789abcdef0123";
const sutApplicationId = "22222222222222222";
const resultChannelId = "11111111111111111";
const thread = {
  kind: "thread",
  id: "44444444444444444",
  name: "Meeting results",
  parentId: resultChannelId,
} as const;
const input = {
  container: thread,
  durationMilliseconds: 10_000,
  pollIntervalMs: 2_000,
  projectionMarker: marker,
  recordingId: "recording-42",
  resultChannelId,
  runId: "run-42",
  sutApplicationId,
} as const;

describe("first-seen Live Discord playback link observation", () => {
  it("retains immutable first-seen timing and a sanitized capability digest", async () => {
    const clock = new FakeClock([
      timing(1_000, 10_000),
      timing(1_001, 10_001), timing(1_010, 10_010),
      timing(3_010, 12_010), timing(3_020, 12_020),
    ]);
    const rawCapability = "signed-recording-secret";
    const reader = new PollReader([
      [],
      [{
        container: thread,
        messages: [message({
          content: `[Listen](https://recordings.example.com/recordings/playback#${rawCapability})`,
          createdAtMilliseconds: 2_500,
        })],
      }],
      [{ container: thread, messages: [message({ content: "newer unrelated" })] }],
    ]);

    const proof = await observeFirstSeenLiveDiscordPlaybackLink(input, reader, clock);

    expect(proof).toEqual({
      schemaVersion: 1,
      runId: "run-42",
      recordingId: "recording-42",
      projectionMarker: marker,
      sutApplicationId,
      resultChannelId,
      messageId: "33333333333333333",
      container: thread,
      observerArmedAt: timing(1_000, 10_000),
      firstSeenPollStartedAt: timing(3_010, 12_010),
      firstSeenPollCompletedAt: timing(3_020, 12_020),
      pollIntervalMs: 2_000,
      link: {
        origin: "https://recordings.example.com",
        pathname: "/recordings/playback",
        capabilitySha256: createHash("sha256").update(rawCapability).digest("hex"),
      },
    });
    expect(JSON.stringify(proof)).not.toContain(rawCapability);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(reader.pollCount).toBe(2);
  });

  it("observes a pre-armed marker message only after an edit adds the playback link", async () => {
    const oldMessage = message({
      content: "Final summary is still publishing",
      createdAtMilliseconds: 500,
      editedAtMilliseconds: null,
    });
    const proof = await observeFirstSeenLiveDiscordPlaybackLink(input, new PollReader([
      [{ container: thread, messages: [oldMessage] }],
      [{
        container: thread,
        messages: [{
          ...oldMessage,
          content: playbackLink(),
          editedAtMilliseconds: 2_900,
        }],
      }],
    ]), new FakeClock([
      timing(1_000, 10_000),
      timing(1_001, 10_001), timing(1_010, 10_010),
      timing(3_010, 12_010), timing(3_020, 12_020),
    ]));

    expect(proof.messageId).toBe(oldMessage.id);
    expect(proof.firstSeenPollCompletedAt).toEqual(timing(3_020, 12_020));
  });

  it("ignores newer unrelated messages, wrong authors, and non-exact containers", async () => {
    const proof = await observeFirstSeenLiveDiscordPlaybackLink(input, new PollReader([[{
      container: thread,
      messages: [
        message({ content: "newer unrelated", embeds: [], id: "unrelated" }),
        message({ authorId: "99999999999999999", content: playbackLink(), id: "wrong-author" }),
        message({ content: playbackLink(), id: "exact" }),
      ],
    }, {
      container: { kind: "channel-message", parentChannelId: resultChannelId },
      messages: [message({ content: playbackLink(), id: "wrong-container" })],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(1_002, 10_002),
    ]));

    expect(proof.messageId).toBe("exact");
  });

  it("fails closed for duplicate exact marker candidates", async () => {
    await expect(observeFirstSeenLiveDiscordPlaybackLink(input, new PollReader([[{
      container: thread,
      messages: [
        message({ content: playbackLink(), id: "first" }),
        message({ content: playbackLink(), id: "second" }),
      ],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(1_002, 10_002),
    ]))).rejects.toThrow("duplicate exact marker candidates");
  });

  it.each([
    ["two valid links", `${playbackLink()} ${playbackLink("other-secret")}`],
  ])("rejects an exact candidate with %s", async (_case, content) => {
    await expect(observeFirstSeenLiveDiscordPlaybackLink(input, new PollReader([[{
      container: thread,
      messages: [message({ content })],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(1_002, 10_002),
    ]))).rejects.toThrow("exactly one valid playback URL");
  });

  it.each([
    ["no link", "summary without a link"],
    ["query-bearing link", "[Listen](https://recordings.example.com/recordings/playback?leak=yes#secret)"],
    ["capability-free link", "[Listen](https://recordings.example.com/recordings/playback)"],
  ])("keeps polling an exact candidate with %s", async (_case, content) => {
    await expect(observeFirstSeenLiveDiscordPlaybackLink(input, new PollReader([[{
      container: thread,
      messages: [message({ content })],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(11_001, 20_001),
    ]))).rejects.toThrow("not observed before the deadline");
  });

  it("rejects clocks that move backwards during a poll", async () => {
    await expect(observeFirstSeenLiveDiscordPlaybackLink(input, new PollReader([[]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(1_000, 10_002),
    ]))).rejects.toThrow("timing moved backwards");
  });
});

function playbackLink(capability = "secret"): string {
  return `[Listen](https://recordings.example.com/recordings/playback#${capability})`;
}

function message(overrides: Partial<LiveDiscordMessageInput> = {}): LiveDiscordMessageInput {
  return {
    authorId: sutApplicationId,
    content: playbackLink(),
    createdAtMilliseconds: 1_500,
    editedAtMilliseconds: null,
    embeds: [{
      description: null,
      fields: [],
      footerText: marker,
      title: null,
    }],
    id: "33333333333333333",
    ...overrides,
  };
}

function timing(epochMilliseconds: number, monotonicMilliseconds: number): LiveDiscordPollTiming {
  return { epochMilliseconds, monotonicMilliseconds };
}

class PollReader implements LiveDiscordProjectionReader {
  public pollCount = 0;

  public constructor(private readonly polls: readonly (readonly LiveDiscordProjectionMessages[])[]) {}

  public poll(): Promise<readonly LiveDiscordProjectionMessages[]> {
    const poll = this.polls[this.pollCount] ?? [];
    this.pollCount += 1;
    return Promise.resolve(poll);
  }
}

class FakeClock implements LiveDiscordPlaybackLinkClock {
  public constructor(private readonly timings: LiveDiscordPollTiming[]) {}

  public now(): LiveDiscordPollTiming {
    const next = this.timings.shift();
    if (next === undefined) {
      throw new Error("Fake clock exhausted");
    }
    return next;
  }

  public wait(): Promise<void> {
    return Promise.resolve();
  }
}
