import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeConversationGreetingPlaybackReadinessEnvelope } from
  "@discord-meeting/conversation-runtime-contracts";
import { describe, expect, it, vi } from "vitest";

import {
  armInitialConversationObserver,
  publishGreetingObserverReady,
} from "../src/conversation-greeting-ready.js";
import type { ConversationVoiceObserverConfig } from
  "../src/conversation-voice-observer-config.js";

describe("initial conversation observer readiness", () => {
  it("releases the meeting actor before waiting for Craig to join", async () => {
    const events: string[] = [];
    let releaseCraig!: () => void;
    const craigJoined = new Promise<void>((resolve) => { releaseCraig = resolve; });
    const arming = armInitialConversationObserver({
      publishObserverSubscribed: () => { events.push("observer-subscribed"); },
      waitForCraigBot: async () => {
        events.push("waiting-for-craig");
        await craigJoined;
        events.push("craig-joined");
      },
    });

    await vi.waitFor(() => {
      expect(events).toEqual(["observer-subscribed", "waiting-for-craig"]);
    });
    releaseCraig();
    await arming;

    expect(events).toEqual([
      "observer-subscribed",
      "waiting-for-craig",
      "craig-joined",
    ]);
  });

  it("fails when Craig never arrives", async () => {
    await expect(armInitialConversationObserver({
      publishObserverSubscribed: vi.fn(),
      waitForCraigBot: async () => { throw new Error("Craig timeout"); },
    })).rejects.toThrow("Craig timeout");
  });

  it("publishes readiness for the participant bound to each planned greeting", async () => {
    const root = await mkdtemp(join(tmpdir(), "conversation-greeting-ready-"));
    const participantId = "1533227577286852649";
    const intent = {
      capturePlan: "observer-greeting" as const,
      kind: "greeting" as const,
      meetingId: "meeting-1",
      participantId,
      protocolVersion: 1 as const,
      runId: "run-1",
      turnId: `participant-greeting:${participantId}`,
      type: "playback-intent" as const,
    };
    const stem = createHash("sha256")
      .update(serializeConversationGreetingPlaybackReadinessEnvelope(intent)).digest("hex");
    await writeFile(join(root, `${stem}.intent.json`), JSON.stringify(intent), {
      flag: "wx", mode: 0o600,
    });
    try {
      await publishGreetingObserverReady({
        authenticatedBotId: "1533867700575670282",
        config: {
          craigBotId: "1533877611258708230",
          greetingHandshakeRoot: root,
          guildId: "1533228590643155034",
          observerApplicationId: "1533867700575670282",
          readyTimeoutMilliseconds: 1_000,
          runId: "run-1",
          voiceChannelId: "1533228823045214398",
        } as ConversationVoiceObserverConfig,
        handshakeNotBeforeEpochMilliseconds: Date.now() - 1_000,
        participantId,
      });
      expect(JSON.parse(await readFile(join(root, `${stem}.ready.json`), "utf8")))
        .toMatchObject({ participantId, turnId: intent.turnId, type: "observer-ready" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
