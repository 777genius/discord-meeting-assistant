import { chmod, lstat, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deriveHostedClockPreflightReceiptV2 } from "../src/hosted-clock-proof-v2.js";
import { writeCreateOnlyClockPreflightProof } from "../src/hosted-clock-preflight-proof-store.js";

describe("hosted clock preflight proof store", () => {
  it("writes the exact V2 proof mode-0600 and never replaces it", async () => {
    const directory = await privateDirectory();
    const path = join(directory, "clock.json");
    const proof = clockProof();
    await writeCreateOnlyClockPreflightProof(path, proof);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(proof);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    await expect(writeCreateOnlyClockPreflightProof(path, proof)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects a permissive or symlink parent", async () => {
    const directory = await privateDirectory();
    await chmod(directory, 0o755);
    await expect(writeCreateOnlyClockPreflightProof(join(directory, "clock.json"), clockProof()))
      .rejects.toThrow("mode-0700");
    const root = await privateDirectory();
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, alias);
    await expect(writeCreateOnlyClockPreflightProof(join(alias, "clock.json"), clockProof()))
      .rejects.toThrow("mode-0700");
  });
});

async function privateDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clock-proof-store-"));
  await chmod(path, 0o700);
  return path;
}

function clockProof() {
  return deriveHostedClockPreflightReceiptV2({
    observer: {
      after: { bootId: "observer-boot", epochMs: 1_010, monotonicNs: "1010000000" },
      before: { bootId: "observer-boot", epochMs: 1_000, monotonicNs: "1000000000" },
    }, observerClockId: "observer-clock",
    source: {
      after: { bootId: "source-boot", epochMs: 1_008, monotonicNs: "1008000000" },
      before: { bootId: "source-boot", epochMs: 1_005, monotonicNs: "1005000000" },
      sample: { bootId: "source-boot", epochMs: 1_007, monotonicNs: "1007000000" },
    }, sourceClockId: "source-clock",
    target: { environment: "private-test-guild", host: "codex-workers-eu-01", project: "discord-meeting-assistant" },
  });
}
