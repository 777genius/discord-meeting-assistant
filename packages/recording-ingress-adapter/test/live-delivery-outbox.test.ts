import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { afterEach, expect, it, vi } from "vitest";

import {
  appendPendingLivePackets as appendUnlocked,
  markLivePacketDelivered,
  pendingLivePackets,
} from "../src/live-delivery-outbox.js";
import { RecordingIngressRuntime } from "../src/recording-ingress-runtime.js";
import { spoolToken } from "../src/spool.js";

const effects = vi.hoisted(() => ({ syncs: 0, reads: 0, countSyncOnly: false }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rm: vi.fn(actual.rm),
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...values: Parameters<typeof handle.read>) => {
        effects.reads += 1;
        return read(...values);
      });
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

it("drains 1612 packets without historical parses, retaining each durable receipt", async () => {
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
  expect(vi.mocked(fs.readFile).mock.calls.length - reads).toBe(0);
  expect(parse).not.toHaveBeenCalled();
  expect(effects.syncs - syncs).toBe(1612);
  await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

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

it("retains acceleration beyond the former byte budget", async () => {
  const { runtime } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0, new Uint8Array(25 * 1024 * 1024)), packet(1)]);
  await pendingLivePackets(runtime, "r");
  const reads = vi.mocked(fs.readFile).mock.calls.length;
  await pendingLivePackets(runtime, "r");
  expect(vi.mocked(fs.readFile).mock.calls.length - reads).toBe(0);
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

it("retains acceleration beyond the former identity budget", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0)]);
  await fs.appendFile(path, Array.from({ length: 65_536 }, (_, i) =>
    JSON.stringify({ schemaVersion: 1, type: "delivered", packetId: `old:${i}` }) + "\n",
  ).join(""));
  expect(await pendingLivePackets(runtime, "r")).toHaveLength(1);
  const reads = vi.mocked(fs.readFile).mock.calls.length;
  expect(await pendingLivePackets(runtime, "r")).toHaveLength(1);
  expect(vi.mocked(fs.readFile).mock.calls.length - reads).toBe(0);
}, 30_000);

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

it.each([128, 256, 512])("keeps two alternating recordings indexed at N=%i", async (count) => {
  const { runtime } = await fixture();
  effects.countSyncOnly = true;
  for (const recordingId of ["r", "s"]) {
    await runtime.withExclusiveSpoolOwnership(() => runtime.exclusive(recordingId, () =>
      appendUnlocked(runtime, Array.from({ length: count + 1 }, (_, i) => ({ ...packet(i), recordingId })))));
  }
  const parse = vi.spyOn(JSON, "parse");
  const syncs = effects.syncs;
  for (let i = 0; i < count; i += 1) {
    for (const recordingId of ["r", "s"]) {
      expect(await markLivePacketDelivered(runtime, identity(i).replace(/^r:/, `${recordingId}:`))).toBe("marked");
    }
  }
  expect(parse).not.toHaveBeenCalled();
  expect(effects.syncs - syncs).toBe(count * 2);
}, 30_000);

it.each([
  { count: 65_538, bytes: 1 },
  { count: 6_000, bytes: 4_096 },
])("marks retained metadata past both old thresholds: $count x $bytes", async ({ count, bytes }) => {
  const { runtime, path } = await fixture();
  effects.countSyncOnly = true;
  // Bounded admission batches; real SQLite and counted durability barriers.
  for (let start = 0; start < count; start += 256) {
    await appendPendingLivePackets(runtime, Array.from({ length: Math.min(256, count - start) },
      (_, i) => packet(start + i, new Uint8Array(bytes))));
  }
  if (bytes === 4096) { expect((await fs.stat(path)).size).toBeGreaterThan(32 * 1024 * 1024); }
  const parse = vi.spyOn(JSON, "parse");
  const syncs = effects.syncs;
  const reads = effects.reads;
  // Exercise healthy marking on both sides of 65,536 retained identities.
  for (let i = 0; i < count - 1; i += 1) {
    expect(await markLivePacketDelivered(runtime, identity(i))).toBe("marked");
  }
  expect(parse).not.toHaveBeenCalled();
  expect(effects.syncs - syncs).toBe(count - 1);
  expect(effects.reads - reads).toBe(0);
}, 180_000);

it("recovers delivered-before-pending, exact duplicates, isolation and readmission", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  const text = await fs.readFile(path, "utf8");
  await fs.writeFile(path, JSON.stringify({ schemaVersion: 1, type: "delivered", packetId: identity(0) }) + "\n" + text + text);
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("reused");
  const first = await pendingLivePackets(runtime, "r");
  expect(first.map((p) => p.packetId)).toEqual([identity(1)]);
  Object.assign(first[0]!, { payloadBase64: "tampered" });
  expect((await pendingLivePackets(runtime, "r"))[0]?.payloadBase64).toBe("AQ==");
  await expect(markLivePacketDelivered(runtime, "r:absent")).rejects.toMatchObject({ failure: "invalid-input" });
  expect(await markLivePacketDelivered(runtime, identity(1))).toBe("marked");
  await expect(markLivePacketDelivered(runtime, identity(1))).rejects.toMatchObject({ failure: "invalid-input" });
  await appendPendingLivePackets(runtime, [packet(1)]);
  expect(await markLivePacketDelivered(runtime, identity(1))).toBe("marked");
});

it.each(["delete", "corrupt"])("recreates a %s cache from durable evidence", async (fault) => {
  const { runtime } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  await markLivePacketDelivered(runtime, identity(0));
  const cache = join(runtime.spool.root, "live-delivery-cache-v1", "metadata.sqlite");
  if (fault === "delete") { await fs.rm(cache); }
  else { await fs.writeFile(cache, "not a sqlite database"); }
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("reused");
  expect((await pendingLivePackets(runtime, "r")).map((p) => p.packetId)).toEqual([identity(1)]);
});

it("rejects symlinks and complete malformed rows without erasing evidence", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  await fs.rename(path, path + ".saved");
  await fs.symlink(path + ".saved", path);
  await expect(markLivePacketDelivered(runtime, identity(0))).rejects.toMatchObject({ failure: "path-policy" });
  await fs.unlink(path);
  await fs.rename(path + ".saved", path);
  await fs.appendFile(path, "bad complete row\n");
  await expect(pendingLivePackets(runtime, "r")).rejects.toMatchObject({ failure: "corrupt-spool" });
  expect(await fs.readFile(path, "utf8")).toContain("bad complete row\n");
});

it("does not hold a global cache gate across receipt sync and close waits for admitted work", async () => {
  const { runtime } = await fixture();
  for (const recordingId of ["r", "s"]) {
    await runtime.withExclusiveSpoolOwnership(() => runtime.exclusive(recordingId, () =>
      appendUnlocked(runtime, [0, 1].map((i) => ({ ...packet(i), recordingId })))));
  }
  const other = createRuntime(runtime.spool.root);
  await expect(pendingLivePackets(other, "r")).rejects.toBeDefined();
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const syncing = new Promise<void>((resolve) => { entered = resolve; });
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
      entered(); await blocked; await sync();
    });
    return handle;
  });
  const marking = markLivePacketDelivered(runtime, identity(0));
  await syncing;
  expect(await markLivePacketDelivered(runtime, identity(0).replace(/^r:/, "s:"))).toBe("marked");
  const cacheClose = vi.spyOn(await runtime.liveDeliveryIndex(), "close");
  const releaseOwnership = vi.spyOn(runtime.spool, "releaseExclusiveOwnership");
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; return true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  await expect(pendingLivePackets(runtime, "r")).rejects.toMatchObject({ failure: "invalid-state" });
  release();
  expect(await marking).toBe("marked");
  await closing;
  expect(cacheClose.mock.invocationCallOrder[0]).toBeLessThan(releaseOwnership.mock.invocationCallOrder[0]!);
  const restarted = createRuntime(runtime.spool.root);
  expect(await markLivePacketDelivered(restarted, identity(0))).toBe("reused");
});

it.each(["write", "close", "replace"])("retains evidence after an uncertain %s boundary", async (fault) => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  const original = await fs.readFile(path, "utf8");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    if (fault === "write") {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async (...values) => {
        await write(...values); throw new Error("uncertain write");
      });
    } else if (fault === "close") {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close(); throw new Error("uncertain close");
      });
    } else {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
        await sync();
        await actual.rename(path, path + ".retained");
        await actual.writeFile(path, original);
      });
    }
    return handle;
  });
  await expect(markLivePacketDelivered(runtime, identity(0))).rejects.toBeDefined();
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe(fault === "replace" ? "marked" : "reused");
  if (fault === "replace") { expect(await fs.readFile(path + ".retained", "utf8")).toContain('"delivered"'); }
});

it("fails closed on cache ENOSPC without appending a receipt and recovers after repair", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  const original = await fs.readFile(path, "utf8");
  const cache = join(runtime.spool.root, "live-delivery-cache-v1", "metadata.sqlite");
  await fs.rm(cache);
  vi.mocked(fs.rm).mockRejectedValueOnce(Object.assign(new Error("cache ENOSPC"), { code: "ENOSPC" }));
  await expect(markLivePacketDelivered(runtime, identity(0))).rejects.toThrow("cache ENOSPC");
  expect(await fs.readFile(path, "utf8")).toBe(original);
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("marked");
});

it("rejects same-inode mutation while streaming recovery", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  await fs.appendFile(path, "\n");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementationOnce(async (...values: Parameters<typeof handle.read>) => {
      const result = await read(...values);
      await actual.appendFile(path, "\n");
      return result;
    });
    return handle;
  });
  await expect(pendingLivePackets(runtime, "r")).rejects.toMatchObject({ failure: "corrupt-spool" });
  expect(await pendingLivePackets(runtime, "r")).toHaveLength(2);
});

it("stores only exact identity and offset metadata in the real disposable database", async () => {
  const { runtime } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  const path = join(runtime.spool.root, "live-delivery-cache-v1", "metadata.sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    expect(db.prepare("PRAGMA table_info(packets)").all().map((row) => row.name))
      .toEqual(["generation", "packet", "offset", "length", "delivered"]);
    expect(db.prepare("SELECT count(*) AS count FROM packets").get()?.count).toBe(2);
  } finally { db.close(); }
});

// Optional root qualification: LIVE_OUTBOX_QUALIFY_IDS=2000000 vitest run <this file>
// -t 'optional aggregate' --silent=false. At most 2 million aggregate IDs, 100 recordings,
// synthetic 100-byte payloads and 80-character speaker IDs. No providers.
// Writes LIVE_OUTBOX_QUALIFY_REPORT (default: tmpdir/live-outbox-qualification-<count>.json).
// It asserts no RSS/disk guarantee.
it.skipIf(process.env.LIVE_OUTBOX_QUALIFY_IDS === undefined)("optional aggregate disk and RSS qualification", async () => {
  const count = Number(process.env.LIVE_OUTBOX_QUALIFY_IDS);
  expect(Number.isSafeInteger(count) && count >= 100 && count <= 2_000_000).toBe(true);
  const { runtime } = await fixture();
  await runtime.acquireExclusiveSpoolOwnership();
  const directory = join(runtime.spool.root, "live-delivery-v1");
  await fs.mkdir(directory, { recursive: true });
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let peakRss = process.memoryUsage().rss;
  let allocated = 0;
  let logical = 0;
  const started = performance.now();
  const syncs = effects.syncs;
  const markIds: string[] = [];
  try {
    for (let recording = 0; recording < 100; recording += 1) {
      const recordingId = `qualification-${recording}`;
      const path = join(directory, spoolToken("live-delivery-v1", recordingId) + ".jsonl");
      const handle = await fs.open(path, "wx", 0o600);
      const rows = Math.floor(count / 100) + (recording < count % 100 ? 1 : 0);
      try {
        for (let start = 0; start < rows; start += 256) {
          const batch = Array.from({ length: Math.min(256, rows - start) }, (_, j) => {
            const i = start + j;
            const speakerId = "synthetic-speaker".padEnd(80, "x");
            const packetId = `${recordingId}:${speakerId}:${i * 960}:${i}:${i * 20}`;
            if (i === 0) { markIds.push(packetId); }
            return JSON.stringify({ schemaVersion: 1, type: "pending", recordingId,
              packetId, speakerId, mediaTimestamp: i * 960, sequenceNumber: i,
              relativeTimeMs: i * 20, receivedAtMs: i * 20,
              payloadBase64: Buffer.alloc(100).toString("base64") }) + "\n";
          });
          await handle.writeFile(batch.join(""));
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
        }
        await handle.sync();
      } finally { await handle.close(); }
    }
    const fixtureMs = performance.now() - started;
    const rebuildStarted = performance.now();
    const sampling = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
    try {
      for (const id of markIds) { await markLivePacketDelivered(runtime, id); }
    } finally { clearInterval(sampling); }
    const rebuildMs = performance.now() - rebuildStarted;
    for (const subdirectory of [directory, join(runtime.spool.root, "live-delivery-cache-v1")]) {
      for (const name of await fs.readdir(subdirectory)) {
        const stat = await fs.stat(join(subdirectory, name));
        allocated += stat.blocks * 512;
        logical += stat.size;
      }
    }
    const measurements = { count, recordings: 100, fixtureMs, rebuildMs, sampledPeakRss: peakRss,
      processPeakRss: process.resourceUsage().maxRSS * 1024,
      allocatedBytes: allocated, logicalBytes: logical, fsyncs: effects.syncs - syncs,
      eventLoopMaxMs: delay.max / 1e6, eventLoopP99Ms: delay.percentile(99) / 1e6,
      metadataRowUpserts: count + markIds.length, maxRowsPerTransaction: 256,
      note: "outbox plus metadata only; excludes native journals and pending array materialization" };
    await fs.writeFile(process.env.LIVE_OUTBOX_QUALIFY_REPORT ??
      join(tmpdir(), `live-outbox-qualification-${count}.json`), JSON.stringify(measurements, null, 2) + "\n");
  } finally { delay.disable(); }
}, 3_600_000);

it("recovers a fsynced receipt after cache publication fails", async () => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  const index = await runtime.liveDeliveryIndex();
  vi.spyOn(index, "publish").mockImplementationOnce(() => {
    throw new Error("cache publication failure");
  });
  await expect(markLivePacketDelivered(runtime, identity(0))).rejects.toThrow("cache publication failure");
  expect(await fs.readFile(path, "utf8")).toContain('"delivered"');
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("reused");
});

it("preserves exact legacy identities including lone surrogates and NUL", async () => {
  const { runtime } = await fixture();
  const speakers = ["\ud800", "\ud801", "\u0000", "!"];
  await appendPendingLivePackets(runtime, speakers.map((speakerId) => ({ ...packet(0), speakerId })));
  const ids = speakers.map((speaker) => `r:${speaker}:0:0:0`);
  expect(new Set((await pendingLivePackets(runtime, "r")).map((row) => row.packetId))).toEqual(new Set(ids));
  for (const id of ids) { expect(await markLivePacketDelivered(runtime, id)).toBe("marked"); }
});

it("allows healthy delivery while another recording is paused in streaming recovery", async () => {
  const { runtime, path } = await fixture();
  for (const recordingId of ["r", "s"]) {
    await runtime.withExclusiveSpoolOwnership(() => runtime.exclusive(recordingId, () =>
      appendUnlocked(runtime, [0, 1].map((i) => ({ ...packet(i), recordingId })))));
  }
  await fs.appendFile(path, "\n");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementationOnce(async (...values: Parameters<typeof handle.read>) => {
      entered(); await paused; return read(...values);
    });
    return handle;
  });
  const recovering = pendingLivePackets(runtime, "r");
  await reading;
  try {
    expect(await markLivePacketDelivered(runtime, identity(0).replace(/^r:/, "s:"))).toBe("marked");
  } finally { release(); }
  expect(await recovering).toHaveLength(2);
});

it("streams exactly one historical rebuild per restart or changed generation", async () => {
  const { runtime, path } = await fixture();
  effects.countSyncOnly = true;
  await appendPendingLivePackets(runtime, Array.from({ length: 256 }, (_, i) => packet(i)));
  await runtime.close();
  const restarted = createRuntime(runtime.spool.root);
  const parse = vi.spyOn(JSON, "parse");
  await markLivePacketDelivered(restarted, identity(0));
  expect(parse).toHaveBeenCalledTimes(256);
  await markLivePacketDelivered(restarted, identity(1));
  expect(parse).toHaveBeenCalledTimes(256);
  parse.mockClear();
  await fs.writeFile(path, await fs.readFile(path, "utf8"));
  await markLivePacketDelivered(restarted, identity(2));
  expect(parse).toHaveBeenCalledTimes(258);
  await markLivePacketDelivered(restarted, identity(3));
  expect(parse).toHaveBeenCalledTimes(258);
});

it.each([
  { operation: "pending", acquisition: 2 },
  { operation: "mark", acquisition: 2 },
  { operation: "mark", acquisition: 3 },
  { operation: "admit", acquisition: 2 },
])("fails closed when cache recreation crosses $operation acquisition $acquisition", async ({ operation, acquisition }) => {
  const { runtime, path } = await fixture();
  await appendPendingLivePackets(runtime, [packet(0), packet(1)]);
  const original = await fs.readFile(path, "utf8");
  const acquire = runtime.liveDeliveryIndex.bind(runtime);
  const previous = await acquire();
  let calls = 0;
  const spy = vi.spyOn(runtime, "liveDeliveryIndex").mockImplementation(async () => {
    calls += 1;
    if (calls === acquisition) {
      await fs.rm(join(runtime.spool.root, "live-delivery-cache-v1", "metadata.sqlite"));
      const replacement = await acquire();
      expect(replacement).not.toBe(previous);
      return replacement;
    }
    return acquire();
  });
  const result = operation === "pending" ? pendingLivePackets(runtime, "r") :
    operation === "mark" ? markLivePacketDelivered(runtime, identity(0)) :
      appendPendingLivePackets(runtime, [packet(2)]);
  await expect(result).rejects.toMatchObject({ failure: "corrupt-spool" });
  expect(calls).toBe(acquisition);
  spy.mockRestore();
  expect(await fs.readFile(path, "utf8")).toBe(original);
  expect((await pendingLivePackets(runtime, "r")).map((row) => row.packetId))
    .toEqual([identity(0), identity(1)]);
  await appendPendingLivePackets(runtime, [packet(2)]);
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("marked");
  expect(await markLivePacketDelivered(runtime, identity(0))).toBe("reused");
  await expect(markLivePacketDelivered(runtime, "r:absent")).rejects.toMatchObject({ failure: "invalid-input" });
  expect(await markLivePacketDelivered(runtime, identity(1))).toBe("marked");
  expect((await pendingLivePackets(runtime, "r")).map((row) => row.packetId)).toEqual([identity(2)]);
  expect(await markLivePacketDelivered(runtime, identity(2))).toBe("marked");
  await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
});
