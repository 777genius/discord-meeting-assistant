import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
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
    const lease = await store.acquireLease(bounded());
    expect(JSON.parse(await readFile(join(root, "campaign.lease"), "utf8"))).toEqual({
      campaignId: "campaign-1", campaignRoot: parent, planSha256: "0".repeat(64),
    });
    await expect(store.acquireLease(bounded())).rejects.toMatchObject({ code: "EEXIST" });
    await store.releaseLease(lease);
  });

  it("fails closed and retains the live lease when exact deletion identity cannot be proven", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-cleanup-failure-"));
    const root = join(parent, "barriers");
    const store = new HostedCampaignArtifactStore(root, "campaign-1");
    await store.initialize();
    const lease = await store.acquireLease(bounded());
    await expect(store.releaseLease({ ...lease, inode: lease.inode + 1 }))
      .rejects.toThrow(/identity changed/u);
    expect(await lstat(join(root, "campaign.lease"))).toBeDefined();
  });

  it("creates one fresh campaign layout and refuses every stale retry", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const campaignRoot = join(parent, "campaign-1");
    const store = new HostedCampaignArtifactStore(join(campaignRoot, "barriers"), "campaign-1");
    await store.initializeFreshCampaignLayout();
    expect((await readdir(campaignRoot)).toSorted()).toEqual(["barriers", "run-1", "run-2", "run-3"]);
    for (const name of ["barriers", "run-1", "run-2", "run-3"]) {
      expect((await lstat(join(campaignRoot, name))).mode & 0o777).toBe(0o700);
    }

    const action = { kind: "provenance-before" as const };
    await store.publishAction(action, { digestSha256: "a".repeat(64) });
    const lease = await store.acquireLease(bounded());
    await store.releaseLease(lease);

    const retry = new HostedCampaignArtifactStore(join(campaignRoot, "barriers"), "campaign-1");
    await expect(retry.initializeFreshCampaignLayout()).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(join(campaignRoot, "barriers", actionFileName(action)), "utf8")))
      .toMatchObject({ campaignId: "campaign-1", evidence: { digestSha256: "a".repeat(64) } });
  });

  it("accepts only the exact pre-created private control surface", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const campaignRoot = join(parent, "campaign-1");
    const controlRoot = join(campaignRoot, "control");
    await mkdir(controlRoot, { mode: 0o700, recursive: true });
    const controlFiles = ["definition.json", "bindings.json", "plan.json", "admission.json"]
      .map((name) => join(controlRoot, name));
    await Promise.all(controlFiles.map((path) => writeFile(path, "{}\n", { mode: 0o600 })));

    const store = new HostedCampaignArtifactStore(join(campaignRoot, "barriers"), "campaign-1");
    await store.initializeFreshCampaignLayout(controlFiles);

    expect((await readdir(campaignRoot)).toSorted())
      .toEqual(["barriers", "control", "run-1", "run-2", "run-3"]);
    expect((await readdir(controlRoot)).toSorted())
      .toEqual(["admission.json", "bindings.json", "definition.json", "plan.json"]);
  });

  it("accepts the exact empty run-3 roots pre-created by Meeting Platform", async () => {
    const parent = await mkdtemp(join(tmpdir(), "hosted-artifacts-"));
    const campaignRoot = join(parent, "campaign-1");
    const controlRoot = join(campaignRoot, "control");
    await mkdir(controlRoot, { mode: 0o700, recursive: true });
    const controlPath = join(controlRoot, "definition.json");
    await writeFile(controlPath, "{}\n", { mode: 0o600 });
    await mkdir(join(campaignRoot, "run-3", "answer-handshakes"), { mode: 0o700, recursive: true });
    await mkdir(join(campaignRoot, "run-3", "greeting-handshakes"), { mode: 0o700, recursive: true });

    const store = new HostedCampaignArtifactStore(join(campaignRoot, "barriers"), "campaign-1");
    await store.initializeFreshCampaignLayout([controlPath]);

    expect((await readdir(campaignRoot)).toSorted())
      .toEqual(["barriers", "control", "run-1", "run-2", "run-3"]);
  });

  it("rejects undeclared, linked, or non-private pre-created control artifacts", async () => {
    const extra = await makeLayout("extra");
    await writeFile(join(extra.controlRoot, "undeclared.json"), "{}\n", { mode: 0o600 });
    await expect(new HostedCampaignArtifactStore(join(extra.campaignRoot, "barriers"), "campaign-1")
      .initializeFreshCampaignLayout([extra.declaredPath])).rejects.toThrow(/exactly the declared/u);

    const linked = await makeLayout("hardlink");
    await link(linked.declaredPath, join(linked.controlRoot, "alias.json"));
    await expect(new HostedCampaignArtifactStore(join(linked.campaignRoot, "barriers"), "campaign-1")
      .initializeFreshCampaignLayout([linked.declaredPath, join(linked.controlRoot, "alias.json")]))
      .rejects.toThrow(/single-link/u);

    const permissive = await makeLayout("mode");
    await chmod(permissive.declaredPath, 0o644);
    await expect(new HostedCampaignArtifactStore(join(permissive.campaignRoot, "barriers"), "campaign-1")
      .initializeFreshCampaignLayout([permissive.declaredPath])).rejects.toThrow(/0600/u);

    const symbolic = await makeLayout("symlink");
    const targetPath = join(symbolic.controlRoot, "target.json");
    await writeFile(targetPath, "{}\n", { mode: 0o600 });
    const symbolicPath = join(symbolic.controlRoot, "definition-link.json");
    await symlink(targetPath, symbolicPath);
    await expect(new HostedCampaignArtifactStore(join(symbolic.campaignRoot, "barriers"), "campaign-1")
      .initializeFreshCampaignLayout([symbolic.declaredPath, targetPath, symbolicPath]))
      .rejects.toMatchObject({ code: "ELOOP" });
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

async function makeLayout(suffix: string) {
  const parent = await mkdtemp(join(tmpdir(), `hosted-artifacts-${suffix}-`));
  const campaignRoot = join(parent, "campaign-1");
  const controlRoot = join(campaignRoot, "control");
  await mkdir(controlRoot, { mode: 0o700, recursive: true });
  const declaredPath = join(controlRoot, "definition.json");
  await writeFile(declaredPath, "{}\n", { mode: 0o600 });
  return { campaignRoot, controlRoot, declaredPath };
}
