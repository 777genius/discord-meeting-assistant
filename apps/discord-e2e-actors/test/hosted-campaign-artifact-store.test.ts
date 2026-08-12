import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { actionFileName, HostedCampaignArtifactStore } from "../src/hosted-campaign-artifact-store.js";

const bounded = () => ({ deadlineEpochMilliseconds: Date.now() + 1_000, signal: new AbortController().signal });

describe("hosted campaign artifact store", () => {
  it("creates a private root and an exclusive lease", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const root = join(parent, "root");
    const store = new HostedCampaignArtifactStore(root, "campaign-1");
    await store.initialize();
    await store.acquireLease(bounded());
    expect(await readFile(join(root, "campaign.lease"), "utf8")).toBe("campaign-1\n");
    await expect(store.acquireLease(bounded())).rejects.toMatchObject({ code: "EEXIST" });
    await store.releaseLease();
  });

  it("requires exact action and campaign correlation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const root = join(parent, "root");
    const store = new HostedCampaignArtifactStore(root, "campaign-1");
    await store.initialize();
    const action = { kind: "capture-retained" as const, ordinal: 1 };
    await writeFile(join(root, actionFileName(action)), JSON.stringify({
      action, campaignId: "wrong", evidence: { ordinal: 1, retained: true },
    }), { mode: 0o600 });
    await expect(store.awaitAction(action, bounded())).rejects.toThrow(/correlation mismatch/u);
  });

  it("rejects symlink and non-private artifacts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const root = join(parent, "root");
    const store = new HostedCampaignArtifactStore(root, "campaign-1");
    await store.initialize();
    const source = join(parent, "source.json");
    await writeFile(source, "{}", { mode: 0o600 });
    const action = { kind: "provenance-before" as const };
    await symlink(source, join(root, actionFileName(action)));
    await expect(store.awaitAction(action, bounded())).rejects.toThrow(/Unsafe/u);
    await chmod(root, 0o755);
    await expect(store.acquireLease(bounded())).rejects.toThrow(/0700/u);
  });
});
