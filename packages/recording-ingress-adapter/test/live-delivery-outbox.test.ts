import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  appendPendingLivePackets as appendUnlocked,
  markLivePacketDelivered,
  pendingLivePackets,
} from "../src/live-delivery-outbox.js";
import { RecordingIngressRuntime } from "../src/recording-ingress-runtime.js";
import { spoolToken } from "../src/spool.js";

const effects = vi.hoisted(() => ({ syncs: 0, countSyncOnly: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rm: vi.fn(actual.rm),
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => {
        effects.syncs += 1;
        if (!effects.countSyncOnly) {
          await sync();
        }
      });
      return handle;
    }),
  };
});
const roots: string[] = [];
const runtimes: RecordingIngressRuntime[] = [];
afterEach(async () => {
  effects.countSyncOnly = false;
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) {
    await runtime.close();
  }
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "live-outbox-index-"));
  roots.push(root);
  const runtime = createRuntime(root);
  return { runtime, path: join(root, "live-delivery-v1", spoolToken("live-delivery-v1", "r") + ".jsonl") };
}
function createRuntime(root: string) {
  const runtime = new RecordingIngressRuntime({
    spoolRoot: root,
    artifactLocatorPrefix: "test",
    writer: { write: () => { throw new Error("unexpected artifact write"); } },
  });
  runtimes.push(runtime);
  return runtime;
}
async function appendPendingLivePackets(
  runtime: RecordingIngressRuntime,
  packets: Parameters<typeof appendUnlocked>[1],
) {
  await runtime.withExclusiveSpoolOwnership(
    () => runtime.exclusive("r", () => appendUnlocked(runtime, packets)),
  );
}
function packet(sequence: number, payload = Uint8Array.of(1)) {
  return {
    guildId: "g", channelId: "c", recordingId: "r", speakerId: sequence % 2 === 0 ? "a" : "b",
    rtpTimestamp: sequence * 960, rtpSequence: sequence,
    relativeTimeMs: sequence * 20, receivedAtMs: sequence * 20, opus: payload,
  };
}
function identity(sequence: number) {
  const value = packet(sequence);
  return `r:${value.speakerId}:${value.rtpTimestamp}:${sequence}:${value.relativeTimeMs}`;
}

it("drains 1612 packets with one linear parse, retaining each durable receipt", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, Array.from({ length: 1612 }, (_, i) => packet(i)));
  const reads = vi.mocked(fs.readFile).mock.calls.length;
  // Count the durability barrier without benchmarking host disk latency.
  // Failure/replay tests below exercise real file sync separately.
  effects.countSyncOnly = true;
  const syncs = effects.syncs;
  const parse = vi.spyOn(JSON, "parse");
  for (let i = 0; i < 1612; i += 1) {
    expect(await markLivePacketDelivered(runtime, identity(i))).toBe("marked");
  }
  expect(vi.mocked(fs.readFile).mock.calls.length - reads).toBe(1);
  expect(parse).toHaveBeenCalledTimes(1612);
  expect(effects.syncs - syncs).toBe(1612);
  await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("updates interleaved speaker appends and duplicate receipts without rescanning", async () => {
  const { runtime } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  await markLivePacketDelivered(runtime, identity(0));
  const reads = vi.mocked(fs.readFile).mock.calls.length;
  await appendPendingLivePackets(runtime, [packet(2), packet(3), packet(0)]);
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("reused");
  expect((await pendingLivePackets(runtime, "r")).map((p) => p.packetId))
    .toEqual([identity(1), identity(2), identity(3)]);
  expect(vi.mocked(fs.readFile).mock.calls.length).toBe(reads);
  await appendPendingLivePackets(runtime, [packet(0, Uint8Array.of(2))]);
  await expect(pendingLivePackets(runtime, "r")).rejects.toMatchObject({ failure: "conflicting-duplicate" });
});

it("rebuilds after restart, replacement, truncation, and same-size rewrite", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  const original = await fs.readFile(path, "utf8");
  await markLivePacketDelivered(runtime, identity(0));
  await runtime.close();
  const restarted = createRuntime(runtime.spool.root);
  expect((await pendingLivePackets(restarted, "r")).map((p) => p.packetId)).toEqual([identity(1)]);
  await fs.writeFile(path + ".new", original);
  await fs.rename(path + ".new", path);
  expect(await pendingLivePackets(restarted, "r")).toHaveLength(2);
  await fs.writeFile(path, original.replaceAll('"AQ=="', '"Ag=="'));
  expect((await pendingLivePackets(restarted, "r"))[0]?.payloadBase64).toBe("Ag==");
  await fs.truncate(path, 0);
  await expect(markLivePacketDelivered(restarted, identity(0))).rejects.toMatchObject({ failure: "invalid-input" });
  await fs.writeFile(path, original + '{"partial":');
  expect(await pendingLivePackets(restarted, "r")).toHaveLength(2);
  expect(await fs.readFile(path, "utf8")).toBe(original);
});

it("invalidates an uncertain fsync and permits replay when its receipt is lost", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  await pendingLivePackets(runtime, "r");
  const original = await fs.readFile(path, "utf8");
  const actualOpen = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actualOpen.open(...args);
    vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("synthetic fsync failure"));
    return handle;
  });
  await expect(markLivePacketDelivered(runtime, identity(0))).rejects.toThrow("synthetic fsync failure");
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("reused");
  // Simulated crash loses the uncertain write: no cached receipt may suppress replay.
  await fs.writeFile(path, original);
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("marked");
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("reused");
});

it("does not retain an index beyond its byte budget", async () => {
  const { runtime } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0, new Uint8Array(25 * 1024 * 1024)), packet(1)]);
  await pendingLivePackets(runtime, "r");
  const reads = vi.mocked(fs.readFile).mock.calls.length;
  await pendingLivePackets(runtime, "r");
  expect(vi.mocked(fs.readFile).mock.calls.length - reads).toBe(1);
});


it("replays a retained uncertain receipt and preserves failed-compaction semantics", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  await markLivePacketDelivered(runtime, identity(0));
  vi.mocked(fs.rm).mockRejectedValueOnce(new Error("synthetic cleanup failure"));
  await expect(markLivePacketDelivered(runtime, identity(1))).rejects.toThrow("synthetic cleanup failure");
  expect(await markLivePacketDelivered(runtime, identity(1))).toBe("reused");
  expect(await pendingLivePackets(runtime, "r")).toEqual([]);
  expect((await fs.readFile(path, "utf8")).trim().split("\n")).toHaveLength(4);
  await appendPendingLivePackets(runtime, [packet(2)]);
  expect(await markLivePacketDelivered(runtime, identity(2))).toBe("marked");
  await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("bounds retained identity count independently of payload bytes", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0)]);
  await fs.appendFile(path, Array.from({ length: 65_536 }, (_, i) =>
    JSON.stringify({ schemaVersion: 1, type: "delivered", packetId: `old:${i}` }) + "\n",
  ).join(""));
  expect(await pendingLivePackets(runtime, "r")).toHaveLength(1);
  const reads = vi.mocked(fs.readFile).mock.calls.length;
  expect(await pendingLivePackets(runtime, "r")).toHaveLength(1);
  expect(vi.mocked(fs.readFile).mock.calls.length - reads).toBe(1);
});

it("serializes concurrent speaker delivery and admission through the recording lock", async () => {
  const { runtime } = await fixture();
  await appendPendingLivePackets(runtime, Array.from({ length: 100 }, (_, i) => packet(i)));
  const operations = Array.from({ length: 99 }, (_, i) =>
    markLivePacketDelivered(runtime, identity(i)),
  );
  operations.push(appendPendingLivePackets(runtime, [packet(100), packet(101)]).then(() => "marked" as const));
  expect(await Promise.all(operations)).toEqual(Array.from({ length: 100 }, () => "marked"));
  expect((await pendingLivePackets(runtime, "r")).map((p) => p.packetId))
    .toEqual([identity(99), identity(100), identity(101)]);
});
