import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runSupplementalPlaybackAfterGates,
  waitForSupplementalPlaybackGate,
  writeSupplementalPlaybackGate,
  type SupplementalPlaybackGate,
} from "../src/supplemental-playback-gate.js";

async function context(phase: "connection" | "playback" = "connection") {
  const root = await mkdtemp(join(tmpdir(), "supplemental-gate-"));
  await chmod(root, 0o700);
  const path = join(root, `${phase}.json`);
  const gate: SupplementalPlaybackGate = {
    campaignId: "campaign-1", guildId: "1533228590643155034", path, phase,
    releasedAtEpochMs: Date.now(), runId: "run-3", schemaVersion: 1,
    voiceChannelId: "1533228823045214398",
  };
  return { gate, path, root };
}

describe("supplemental playback two-phase gate", () => {
  it("connects only after connection admission and plays only after playback admission", async () => {
    const events: string[] = [];
    const connection = await context("connection");
    const playback = await context("playback");
    await expect(runSupplementalPlaybackAfterGates({
      connectionGate: connection.gate,
      connect: async () => { events.push("connect"); return "actor"; },
      play: async (actor) => { events.push(`play:${actor}`); return "played"; },
      playbackGate: playback.gate,
      timeoutMilliseconds: 1_000,
    }, async (expected) => { events.push(`gate:${expected.phase}`); })).resolves.toBe("played");
    expect(events).toEqual(["gate:connection", "connect", "gate:playback", "play:actor"]);
  });
  it("waits for exact create-only connection and playback gates", async () => {
    for (const phase of ["connection", "playback"] as const) {
      const { gate } = await context(phase);
      const waiting = waitForSupplementalPlaybackGate(gate, AbortSignal.timeout(1_000));
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      await writeSupplementalPlaybackGate({ ...gate, releasedAtEpochMs: Date.now() });
      await expect(waiting).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(gate.path, "utf8"))).toMatchObject({
        campaignId: "campaign-1", phase, runId: "run-3", schemaVersion: 1,
        target: { guildId: gate.guildId, voiceChannelId: gate.voiceChannelId },
      });
    }
  });

  it("fails closed for stale, mismatched, duplicate, or symlink gates", async () => {
    const stale = await context();
    const staleWaiting = waitForSupplementalPlaybackGate(stale.gate, AbortSignal.timeout(1_000));
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    await writeSupplementalPlaybackGate({ ...stale.gate, releasedAtEpochMs: Date.now() - 1_000 });
    await expect(staleWaiting).rejects.toThrow(/not fresh/u);
    await expect(writeSupplementalPlaybackGate(stale.gate)).rejects.toMatchObject({ code: "EEXIST" });

    const mismatch = await context("playback");
    const waiting = waitForSupplementalPlaybackGate(mismatch.gate, AbortSignal.timeout(1_000));
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    await writeSupplementalPlaybackGate({ ...mismatch.gate, campaignId: "other", releasedAtEpochMs: Date.now() });
    await expect(waiting).rejects.toThrow(/correlation mismatch/u);

    const unsafe = await context();
    const target = join(unsafe.root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, unsafe.path);
    await expect(waitForSupplementalPlaybackGate(unsafe.gate, AbortSignal.timeout(100)))
      .rejects.toThrow(/create-only/u);
  });
});
