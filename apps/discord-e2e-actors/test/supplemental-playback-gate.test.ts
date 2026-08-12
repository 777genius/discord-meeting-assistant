import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runSupplementalPlaybackAfterGates,
  waitForSupplementalGateArmed,
  waitForSupplementalPlaybackGate,
  writeSupplementalPlaybackGate,
  type SupplementalPlaybackGate,
} from "../src/supplemental-playback-gate.js";

async function context(phase: "connection" | "playback" = "connection") {
  const root = await mkdtemp(join(tmpdir(), "supplemental-gate-"));
  await chmod(root, 0o700);
  const path = join(root, `${phase}.json`);
  const armedPath = join(root, `${phase}.armed.json`);
  const gate: SupplementalPlaybackGate = {
    armedPath, campaignId: "campaign-1", guildId: "1533228590643155034", path, phase,
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
      await expect(waitForSupplementalGateArmed(gate, AbortSignal.timeout(1_000)))
        .resolves.toBeUndefined();
      await writeSupplementalPlaybackGate({ ...gate, releasedAtEpochMs: Date.now() });
      await expect(waiting).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(gate.path, "utf8"))).toMatchObject({
        campaignId: "campaign-1", phase, runId: "run-3", schemaVersion: 1,
        target: { guildId: gate.guildId, voiceChannelId: gate.voiceChannelId },
      });
    }
  });

  it("publishes readiness before accepting a release and rejects pre-released gates", async () => {
    const ordered = await context();
    const waiting = waitForSupplementalPlaybackGate(ordered.gate, AbortSignal.timeout(1_000));
    await expect(waitForSupplementalGateArmed(ordered.gate, AbortSignal.timeout(1_000)))
      .resolves.toBeUndefined();
    await writeSupplementalPlaybackGate({ ...ordered.gate, releasedAtEpochMs: Date.now() });
    await expect(waiting).resolves.toBeUndefined();

    const preReleased = await context("playback");
    await writeSupplementalPlaybackGate({ ...preReleased.gate, releasedAtEpochMs: Date.now() });
    await expect(waitForSupplementalPlaybackGate(preReleased.gate, AbortSignal.timeout(100)))
      .rejects.toThrow(/create-only/u);
  });

  it("fails closed on mismatched, public, stale, or duplicate armed receipts", async () => {
    const mismatch = await context();
    const mismatchWaiting = waitForSupplementalPlaybackGate(mismatch.gate, AbortSignal.timeout(1_000));
    const mismatchWaitFailure = expect(mismatchWaiting).rejects.toThrow(/aborted/u);
    await expect(waitForSupplementalGateArmed(
      { ...mismatch.gate, campaignId: "other" }, AbortSignal.timeout(1_000),
    )).rejects.toThrow(/correlation mismatch/u);
    await mismatchWaitFailure;

    const publicReceipt = await context("playback");
    const publicWaiting = waitForSupplementalPlaybackGate(publicReceipt.gate, AbortSignal.timeout(1_000));
    const publicWaitFailure = expect(publicWaiting).rejects.toThrow(/aborted/u);
    await expect(waitForSupplementalGateArmed(publicReceipt.gate, AbortSignal.timeout(1_000)))
      .resolves.toBeUndefined();
    await chmod(publicReceipt.gate.armedPath, 0o644);
    await expect(waitForSupplementalGateArmed(publicReceipt.gate, AbortSignal.timeout(100)))
      .rejects.toThrow(/Unsafe/u);
    await publicWaitFailure;

    const staleReceipt = await context();
    await writeFile(staleReceipt.gate.armedPath, JSON.stringify({
      armedAtEpochMs: Date.now() - 120_001,
      campaignId: staleReceipt.gate.campaignId,
      gatePath: staleReceipt.gate.path,
      phase: staleReceipt.gate.phase,
      runId: staleReceipt.gate.runId,
      schemaVersion: 1,
      target: { guildId: staleReceipt.gate.guildId, voiceChannelId: staleReceipt.gate.voiceChannelId },
    }), { mode: 0o600 });
    await expect(waitForSupplementalGateArmed(staleReceipt.gate, AbortSignal.timeout(100)))
      .rejects.toThrow(/not fresh/u);

    const duplicate = await context();
    const first = waitForSupplementalPlaybackGate(duplicate.gate, AbortSignal.timeout(1_000));
    const firstWaitFailure = expect(first).rejects.toThrow(/aborted/u);
    await expect(waitForSupplementalGateArmed(duplicate.gate, AbortSignal.timeout(1_000)))
      .resolves.toBeUndefined();
    await expect(waitForSupplementalPlaybackGate(duplicate.gate, AbortSignal.timeout(100)))
      .rejects.toMatchObject({ code: "EEXIST" });
    await firstWaitFailure;
  });

  it("fails closed for stale, mismatched, duplicate, or symlink gates", async () => {
    const stale = await context();
    const staleWaiting = waitForSupplementalPlaybackGate(stale.gate, AbortSignal.timeout(1_000));
    const staleFailure = expect(staleWaiting).rejects.toThrow(/not fresh/u);
    await expect(waitForSupplementalGateArmed(stale.gate, AbortSignal.timeout(1_000)))
      .resolves.toBeUndefined();
    await writeSupplementalPlaybackGate({ ...stale.gate, releasedAtEpochMs: Date.now() - 1_000 });
    await staleFailure;
    await expect(writeSupplementalPlaybackGate(stale.gate)).rejects.toMatchObject({ code: "EEXIST" });

    const mismatch = await context("playback");
    const waiting = waitForSupplementalPlaybackGate(mismatch.gate, AbortSignal.timeout(1_000));
    const mismatchFailure = expect(waiting).rejects.toThrow(/correlation mismatch/u);
    await expect(waitForSupplementalGateArmed(mismatch.gate, AbortSignal.timeout(1_000)))
      .resolves.toBeUndefined();
    await writeSupplementalPlaybackGate({ ...mismatch.gate, campaignId: "other", releasedAtEpochMs: Date.now() });
    await mismatchFailure;

    const unsafe = await context();
    const target = join(unsafe.root, "target.json");
    await writeFile(target, "{}", { mode: 0o600 });
    await symlink(target, unsafe.path);
    await expect(waitForSupplementalPlaybackGate(unsafe.gate, AbortSignal.timeout(100)))
      .rejects.toThrow(/create-only/u);
  });
});
