import { lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { LiveDiscordPlaybackLinkObserverConfig } from "../src/live-discord-playback-link-observer-config.js";
import {
  runLiveDiscordPlaybackLinkObserver,
  writeCreateOnlyPrivateJson,
} from "../src/observe-live-discord-playback-link.js";
import type { LiveDiscordProjectionMessages } from "../src/live-discord-observer.js";

describe("live Discord playback-link observer CLI boundary", () => {
  it("authenticates the expected official bot and publishes one private correlated proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "playback-link-observer-"));
    const outputPath = join(root, "proof.json");
    const config = makeConfig(outputPath);
    const discord = new FakeDiscordReader(config);

    await runLiveDiscordPlaybackLinkObserver(
      config,
      { read: async () => "test-token" },
      discord,
      { prove: ({ messageId, recordingId }) => Promise.resolve({
        capabilitySha256: "2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b",
        messageId, readinessExpectation: "processing-to-ready",
        recordingId: recordingId ?? "recording-42", status: "ready",
        statuses: ["processing", "ready"], trackCount: 1,
      }) },
    );

    const proof = JSON.parse(await readFile(outputPath, "utf8")) as Record<string, unknown>;
    expect(proof).toMatchObject({
      messageId: "44444444444444444", projectionMarker: config.projectionMarkers[0],
      recordingId: "recording-42", resultChannelId: config.resultChannelId,
      runId: config.runId, sutApplicationId: config.sutApplicationId,
    });
    expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
    expect(discord.connectedToken).toBe("test-token");
    expect(discord.closed).toBe(true);
  });

  it("rejects a different authenticated bot and still closes the Discord reader", async () => {
    const config = makeConfig("/tmp/unused-playback-link-proof.json");
    const discord = new FakeDiscordReader(config, "99999999999999999");
    await expect(runLiveDiscordPlaybackLinkObserver(
      config, { read: async () => "test-token" }, discord,
    )).rejects.toThrow("does not match its authenticated bot");
    expect(discord.closed).toBe(true);
    expect(discord.pollCount).toBe(0);
  });

  it("never overwrites an existing proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "playback-link-observer-"));
    const outputPath = join(root, "proof.json");
    await writeCreateOnlyPrivateJson(outputPath, { first: true });
    await expect(writeCreateOnlyPrivateJson(outputPath, { second: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual({ first: true });
  });
});

function makeConfig(outputPath: string): LiveDiscordPlaybackLinkObserverConfig {
  return {
    container: { kind: "channel-message", parentChannelId: "11111111111111111" },
    durationMilliseconds: 1_000,
    keychainService: "test",
    outputPath,
    pollIntervalMs: 2_000,
    recordingPlaybackOrigin: "https://recordings.example.com",
    projectionMarkers: ["meeting-projection:0123456789abcdef0123"],
    recordingIdentity: { kind: "static", meetingId: "recording-42", recordingId: "recording-42" },
    resultChannelId: "11111111111111111",
    runId: "run-42",
    secretDirectory: "/run/test-secrets",
    sutAccount: "sut",
    sutApplicationId: "22222222222222222",
  };
}

class FakeDiscordReader {
  public closed = false;
  public connectedToken: string | undefined;
  public pollCount = 0;
  public constructor(
    private readonly config: LiveDiscordPlaybackLinkObserverConfig,
    private readonly applicationId = "22222222222222222",
  ) {}
  public authenticatedUserId(): string { return this.applicationId; }
  public close(): Promise<void> { this.closed = true; return Promise.resolve(); }
  public connect(token: string): Promise<void> { this.connectedToken = token; return Promise.resolve(); }
  public poll(): Promise<readonly LiveDiscordProjectionMessages[]> {
    this.pollCount += 1;
    return Promise.resolve([{
      container: this.config.container,
      messages: [{
        authorId: this.config.sutApplicationId,
        content: "[Listen](https://recordings.example.com/recordings/playback#secret)",
        createdAtMilliseconds: Date.now(),
        editedAtMilliseconds: null,
        embeds: [{
          description: null, fields: [], footerText: this.config.projectionMarkers[0], title: null,
        }],
        id: "44444444444444444",
      }],
    }]);
  }
}
