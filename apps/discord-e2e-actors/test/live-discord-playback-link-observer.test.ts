import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  observeFirstSeenLiveDiscordPlaybackLink as observePlaybackLink,
  type LiveDiscordPlaybackLinkClock,
  type LiveDiscordPollTiming,
  type ObserveLiveDiscordPlaybackLinkInput,
} from "../src/live-discord-playback-link-observer.js";
import type {
  LiveDiscordMessageInput,
  LiveDiscordProjectionMessages,
  LiveDiscordProjectionReader,
} from "../src/live-discord-observer.js";

function observeFirstSeenLiveDiscordPlaybackLink(
  observeInput: ObserveLiveDiscordPlaybackLinkInput,
  reader: LiveDiscordProjectionReader,
  clock: LiveDiscordPlaybackLinkClock,
) {
  return observePlaybackLink(observeInput, reader, clock, {
    prove: ({ messageId, recordingId, recordingPlaybackUrl }) => Promise.resolve({
      capabilitySha256: createHash("sha256").update(new URL(recordingPlaybackUrl).hash.slice(1)).digest("hex"),
      messageId,
      recordingId,
      status: "ready" as const,
      trackCount: 2,
    }),
  });
}

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
  meetingId: "meeting-42",
  pollIntervalMs: 2_000,
  projectionMarkers: [marker],
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
      readiness: {
        capabilitySha256: createHash("sha256").update(rawCapability).digest("hex"),
        messageId: "33333333333333333",
        recordingId: "recording-42",
        status: "ready",
        trackCount: 2,
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

  it("rejects an unchanged pre-arm playback-link candidate", async () => {
    await expect(observeFirstSeenLiveDiscordPlaybackLink(input, new PollReader([[{
      container: thread,
      messages: [message({ createdAtMilliseconds: 500, editedAtMilliseconds: null })],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(11_001, 20_001),
    ]))).rejects.toThrow("not observed before the deadline");
  });

  it("does not retain a link when immediate readiness is unavailable", async () => {
    const rawCapability = "secret";
    await expect(observePlaybackLink(input, new PollReader([[{
      container: thread, messages: [message()],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(1_002, 10_002),
    ]), {
      prove: () => Promise.reject(new Error("visible but unavailable")),
    })).rejects.toThrow("visible but unavailable");
    expect(JSON.stringify(rawCapability)).toBe('"secret"');
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

  it("accepts exactly one of canonical live/final markers and rejects ambiguity", async () => {
    const finalMarker = "meeting-projection:fedcba98765432100123";
    const hostedInput = { ...input, projectionMarkers: [marker, finalMarker] as const };
    const finalMessage = message({ embeds: [{
      description: null, fields: [], footerText: finalMarker, title: null,
    }] });
    await expect(observeFirstSeenLiveDiscordPlaybackLink(hostedInput, new PollReader([[{
      container: thread, messages: [finalMessage],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(1_002, 10_002),
    ]))).resolves.toMatchObject({ projectionMarker: finalMarker });

    await expect(observeFirstSeenLiveDiscordPlaybackLink(hostedInput, new PollReader([[{
      container: thread, messages: [message(), { ...finalMessage, id: "final-message" }],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(1_002, 10_002),
    ]))).rejects.toThrow("duplicate exact marker candidates");
  });

  it("rejects the right marker in a wrong channel-message container", async () => {
    const channelInput = {
      ...input, container: { kind: "channel-message" as const, parentChannelId: resultChannelId },
    };
    await expect(observeFirstSeenLiveDiscordPlaybackLink(channelInput, new PollReader([[{
      container: { kind: "channel-message", parentChannelId: "99999999999999999" },
      messages: [message()],
    }]]), new FakeClock([
      timing(1_000, 10_000), timing(1_001, 10_001), timing(11_001, 20_001),
    ]))).rejects.toThrow("not observed before the deadline");
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
