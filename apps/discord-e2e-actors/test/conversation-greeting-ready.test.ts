import { describe, expect, it, vi } from "vitest";

import { armInitialConversationObserver } from "../src/conversation-greeting-ready.js";

describe("initial conversation observer readiness", () => {
  it("releases the meeting actor before waiting for Craig to join", async () => {
    const events: string[] = [];
    let releaseCraig!: () => void;
    const craigJoined = new Promise<void>((resolve) => { releaseCraig = resolve; });
    const arming = armInitialConversationObserver({
      publishGreetingReady: async () => { events.push("greeting-ready"); },
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
      "greeting-ready",
    ]);
  });

  it("does not publish greeting readiness when Craig never arrives", async () => {
    const publishGreetingReady = vi.fn(async () => {});

    await expect(armInitialConversationObserver({
      publishGreetingReady,
      publishObserverSubscribed: vi.fn(),
      waitForCraigBot: async () => { throw new Error("Craig timeout"); },
    })).rejects.toThrow("Craig timeout");
    expect(publishGreetingReady).not.toHaveBeenCalled();
  });
});
