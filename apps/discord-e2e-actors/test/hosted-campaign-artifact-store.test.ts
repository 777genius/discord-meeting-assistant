import { chmod, lstat, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
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

  it("rejects oversized and unsupported artifact envelopes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const root = join(parent, "root");
    const store = new HostedCampaignArtifactStore(root, "campaign-1");
    await store.initialize();
    const action = { kind: "provenance-before" as const };
    const path = join(root, actionFileName(action));
    await writeFile(path, `${"x".repeat(1024 * 1024)}x`, { mode: 0o600 });
    await expect(store.awaitAction(action, bounded())).rejects.toThrow(/Unsafe/u);
  });

  it("stops polling immediately when cancelled", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const store = new HostedCampaignArtifactStore(join(parent, "root"), "campaign-1");
    await store.initialize();
    const controller = new AbortController();
    const waiting = store.awaitAction(
      { kind: "provenance-before" },
      { deadlineEpochMilliseconds: Date.now() + 10_000, signal: controller.signal },
    );
    controller.abort(new Error("cancelled by test"));
    await expect(waiting).rejects.toThrow(/cancelled by test/u);
  });

  it("publishes a complete private artifact without leaving a partial file", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const root = join(parent, "root");
    const store = new HostedCampaignArtifactStore(root, "campaign-1");
    await store.initialize();
    const path = join(root, "release-gate.json");
    const value = { campaignId: "campaign-1", payload: "x".repeat(256 * 1024) };
    const observedInvalidContents: string[] = [];
    const observer = (async () => {
      for (let attempt = 0; attempt < 10_000; attempt += 1) {
        try {
          const contents = await readFile(path, "utf8");
          expect(JSON.parse(contents)).toEqual(value);
          return;
        } catch (error) {
          if (errorCode(error) !== "ENOENT") {
            observedInvalidContents.push(String(error));
          }
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      throw new Error("Artifact was not published before the observer attempt budget expired");
    })();

    await store.writeCreateOnly(path, value);
    await observer;

    expect(observedInvalidContents).toEqual([]);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(value);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(root)).filter((name) => name.includes(".partial-"))).toEqual([]);
  });

  it("fails closed on an existing file or symlink and preserves the collision target", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const root = join(parent, "root");
    const store = new HostedCampaignArtifactStore(root, "campaign-1");
    await store.initialize();
    const path = join(root, "release-gate.json");
    await store.writeCreateOnly(path, { first: true });
    await expect(store.writeCreateOnly(path, { second: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ first: true });

    const symlinkPath = join(root, "linked-release-gate.json");
    const targetPath = join(parent, "target.json");
    await writeFile(targetPath, "untouched\n", { mode: 0o600 });
    await symlink(targetPath, symlinkPath);
    await expect(store.writeCreateOnly(symlinkPath, { unsafe: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(targetPath, "utf8")).toBe("untouched\n");
    expect((await readdir(root)).filter((name) => name.includes(".partial-"))).toEqual([]);
  });

  it("refuses to publish through a non-private parent directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const root = join(parent, "root");
    const store = new HostedCampaignArtifactStore(root, "campaign-1");
    await store.initialize();
    await chmod(root, 0o755);
    await expect(store.writeCreateOnly(join(root, "release-gate.json"), { unsafe: true }))
      .rejects.toThrow(/0700/u);
  });
});

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}
