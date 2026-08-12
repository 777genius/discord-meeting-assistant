import { describe, expect, it, vi } from "vitest";

import {
  HOSTED_CAMPAIGN_TARGET,
  runHostedCampaign,
  validateHostedCampaign,
  type HostedCampaignAction,
  type HostedCampaignInput,
  type HostedCampaignPorts,
} from "../src/hosted-campaign-coordinator.js";

function input(): HostedCampaignInput {
  return {
    target: HOSTED_CAMPAIGN_TARGET,
    runs: [
      { ordinal: 1, scenario: "sequential", campaignId: "campaign-1", runId: "run-1", retainedCaptureCount: 0 },
      { ordinal: 2, scenario: "overlap", campaignId: "campaign-1", runId: "run-2", retainedCaptureCount: 0 },
      { ordinal: 3, scenario: "reconnect", campaignId: "campaign-1", runId: "run-3", retainedCaptureCount: 6 },
    ],
  };
}

function ports(
  perform: HostedCampaignPorts["perform"] = () => Promise.resolve(),
): HostedCampaignPorts & { readonly actions: HostedCampaignAction[] } {
  const actions: HostedCampaignAction[] = [];
  return {
    actions,
    perform: async (action) => {
      actions.push(action);
      return perform(action);
    },
    closeOwnedChild: vi.fn(() => Promise.resolve()),
    issuePassReceipt: vi.fn(() => Promise.resolve()),
  };
}

describe("hosted campaign coordinator", () => {
  it("validates the exact private target and run set before calling a port", async () => {
    const invalid = {
      ...input(),
      target: { ...HOSTED_CAMPAIGN_TARGET, guildId: "wrong" },
    } as unknown as HostedCampaignInput;
    const fakePorts = ports();

    await expect(runHostedCampaign(invalid, fakePorts)).rejects.toThrow(/guildId/u);
    expect(fakePorts.actions).toEqual([]);
    expect(fakePorts.closeOwnedChild).not.toHaveBeenCalled();
  });

  it("rejects reordered, duplicate, or capture-owning non-reconnect runs", () => {
    const base = input();
    expect(() => validateHostedCampaign({ ...base, runs: [base.runs[1]!, base.runs[0]!, base.runs[2]!] })).toThrow(
      /ordinal or scenario/u,
    );
    expect(() => validateHostedCampaign({
      ...base,
      runs: [base.runs[0]!, { ...base.runs[1]!, runId: "run-1" }, base.runs[2]!],
    })).toThrow(/unique/u);
    expect(() => validateHostedCampaign({
      ...base,
      runs: [{ ...base.runs[0]!, retainedCaptureCount: 1 }, base.runs[1]!, base.runs[2]!],
    })).toThrow(/Only the reconnect/u);
  });

  it.each([3_999, 4_000])("accepts answer first-packet latency %ims and receipts only after teardown", async (latency) => {
    const fakePorts = ports((action) => Promise.resolve(
      action === "answer-first-packet" ? { answerLatencyMilliseconds: latency } : undefined,
    ));

    const receipt = await runHostedCampaign(input(), fakePorts);

    expect(fakePorts.actions).toEqual([
      "preflight", "provenance-before", "observer-subscribed",
      ...Array.from({ length: 6 }, () => "capture-retained"),
      "reconnect-left", "reconnect-ready", "answer-intent", "answer-observer-ready",
      "answer-first-packet", "run-verified", "provenance-after", "campaign-verified",
      "child-closed", "teardown-complete",
    ]);
    expect(receipt.teardownComplete).toBe(true);
    expect(fakePorts.issuePassReceipt).toHaveBeenCalledOnce();
    expect(fakePorts.actions.at(-1)).toBe("teardown-complete");
  });

  it.each([-1, 4_001])("rejects answer latency %ims, closes every owned child, and emits no receipt", async (latency) => {
    const fakePorts = ports((action) => {
      if (action === "preflight") {
        return Promise.resolve({ ownedChildIds: ["speaker-a", "speaker-b"] });
      }
      if (action === "answer-first-packet") {
        return Promise.resolve({ answerLatencyMilliseconds: latency, ownedChildIds: ["observer"] });
      }
      return Promise.resolve();
    });

    await expect(runHostedCampaign(input(), fakePorts)).rejects.toThrow(/SLA failed/u);
    expect(fakePorts.closeOwnedChild).toHaveBeenCalledTimes(3);
    expect(fakePorts.closeOwnedChild).toHaveBeenCalledWith("speaker-a");
    expect(fakePorts.closeOwnedChild).toHaveBeenCalledWith("speaker-b");
    expect(fakePorts.closeOwnedChild).toHaveBeenCalledWith("observer");
    expect(fakePorts.issuePassReceipt).not.toHaveBeenCalled();
  });

  it("attempts cleanup for every child when one close fails", async () => {
    const fakePorts = ports((action) => Promise.resolve(
      action === "preflight" ? { ownedChildIds: ["a", "b"] } : undefined,
    ));
    vi.mocked(fakePorts.closeOwnedChild).mockImplementation(async (childId) => {
      if (childId === "a") {
        throw new Error("close a failed");
      }
    });

    await expect(runHostedCampaign(input(), fakePorts)).rejects.toThrow(/cleanup was incomplete/u);
    expect(fakePorts.closeOwnedChild).toHaveBeenCalledTimes(2);
    expect(fakePorts.issuePassReceipt).not.toHaveBeenCalled();
  });
});
