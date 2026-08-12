import { chmod, lstat, mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createCampaignBarrierRoot,
  writeCreateOnlyBarrier,
} from "../src/campaign-barrier.js";

describe("campaign barriers", () => {
  it("creates a private root and create-only private barrier", async () => {
    const parent = await mkdtemp(join(tmpdir(), "campaign-barrier-"));
    const root = join(parent, "root");

    await createCampaignBarrierRoot(root);
    const barrier = await writeCreateOnlyBarrier(root, "observer-ready", "ready\n");

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(barrier)).mode & 0o777).toBe(0o600);
    await expect(writeCreateOnlyBarrier(root, "observer-ready", "again\n")).rejects.toThrow();
  });

  it("fails for root collisions, symlinks, and wrong permissions", async () => {
    const parent = await mkdtemp(join(tmpdir(), "campaign-barrier-invalid-"));
    const root = join(parent, "root");
    await mkdir(root, { mode: 0o700 });

    await expect(createCampaignBarrierRoot(root)).rejects.toThrow();
    await chmod(root, 0o755);
    await expect(writeCreateOnlyBarrier(root, "ready", "ready\n")).rejects.toThrow(/0700/u);

    const actual = join(parent, "actual");
    const linked = join(parent, "linked");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, linked);
    await expect(writeCreateOnlyBarrier(linked, "ready", "ready\n")).rejects.toThrow(/real directory/u);
  });

  it("rejects names that could escape the private root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "campaign-barrier-name-"));
    const root = join(parent, "root");
    await createCampaignBarrierRoot(root);

    await expect(writeCreateOnlyBarrier(root, "../ready", "ready\n")).rejects.toThrow(
      /Invalid campaign barrier name/u,
    );
  });
});
