import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { appendPendingLivePackets, initializeLiveStt, liveSttJournal, pendingLivePackets } from "../src/live-delivery-outbox.js";
import { LiveDeliveryIndex } from "../src/live-delivery-index.js";
import { RecordingIngressRuntime } from "../src/recording-ingress-runtime.js";
import type { DecodedPacket } from "../src/recording-ingress-invariants.js";

// Vitest timeout does not cancel async filesystem work. Keep the lock through
// each body's finally block so a timed-out workload cannot consume another
// test's process-global fault injection or overlap prototype restoration.
let previousWork = Promise.resolve();
function serialTest(name: string, run: () => Promise<void>, timeout = 5_000): void {
  it(name, () => {
    const work = previousWork.then(run);
    previousWork = work.catch(() => {});
    return work;
  }, timeout);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stt-review-storage-"));
  const makeRuntime = () => new RecordingIngressRuntime({ spoolRoot: root, artifactLocatorPrefix: "synthetic",
    writer: { write: () => { throw new Error("no artifact effects allowed"); } } });
  const runtime = makeRuntime();
  await runtime.withExclusiveSpoolOwnership(() => initializeLiveStt(runtime, "r"));
  const journal = liveSttJournal(runtime);
  const owner = (await journal.recoverRecording("r")).owner;
  const original = Buffer.from("synthetic authoritative original");
  await writeFile(join(root, "original.ogg"), original);
  return { root, runtime, journal, owner, makeRuntime, original };
}
function packet(speakerId: string, sequence: number): DecodedPacket {
  return { channelId: "room", guildId: "scope", recordingId: "r", speakerId, receivedAtMs: sequence,
    relativeTimeMs: sequence * 20, rtpTimestamp: sequence * 960, rtpSequence: sequence, opus: Uint8Array.of(0xf8, 0xff, 0xfe) };
}

serialTest("pages only eligible payloads through prolonged degradation and repeated reconnects without deleting evidence", async () => {
  const f = await fixture();
  try {
    const opening = await f.journal.beginOpen(f.owner, "a");
    assert.equal(opening.status, "granted");
    await f.journal.fence(opening.operation.session, "acceptance-unknown");
    await appendPendingLivePackets(f.runtime, Array.from({ length: 4096 }, (_, index) => packet("a", index)));
    await appendPendingLivePackets(f.runtime, Array.from({ length: 600 }, (_, index) => packet("b", 599 - index)));
    const probe = await open(join(f.root, "original.ogg"));
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const { value: read } = Object.getOwnPropertyDescriptor(prototype, "read") as { value: FileHandle["read"] };
    let reads = 0;
    prototype.read = function (this: FileHandle, ...args: Parameters<FileHandle["read"]>) { reads += 1; return read.apply(this, args); };
    try {
      for (let reconnect = 0; reconnect < 8; reconnect += 1) {
        const recovered = await f.journal.recoverRecording("r");
        assert.deepEqual(recovered.owner, f.owner);
        let after = "";
        let count = 0;
        for (;;) {
          const page = await pendingLivePackets(f.runtime, "r", after);
          assert.ok(page.length <= 256);
          if (page.length === 0) { break; }
          for (const row of page) { assert.equal(row.speakerId, "b"); assert.equal(row.relativeTimeMs, count++ * 20); }
          after = page[page.length - 1]!.packetId;
        }
        assert.equal(count, 600);
      }
      assert.equal(reads, 8 * 600, "fenced payloads were never read into memory");
      await f.journal.closeRecording(f.owner, 100_000);
      assert.deepEqual(await pendingLivePackets(f.runtime, "r", ""), []);
      assert.equal(reads, 8 * 600, "closed recording reads no payloads");
    } finally { prototype.read = read; await probe.close(); }
    assert.equal((await pendingLivePackets(f.runtime, "r")).length, 4696);
    assert.deepEqual(await readFile(join(f.root, "original.ogg")), f.original);
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000); // Real fsync workload: thousands of packets and repeated paged reads.

serialTest("reconstructs spool ownership after cache eviction with constant journal bookkeeping and many completed recordings", async () => {
  const f = await fixture();
  try {
    const opening = await f.journal.beginOpen(f.owner, "a");
    if (opening.status !== "granted" || opening.operation.kind !== "open") { throw new Error("missing intent"); }
    await f.journal.complete({ operation: opening.operation, outcome: "opened" });
    for (let index = 0; index < 300; index += 1) {
      const id = `completed-${index}`;
      const owner = (await f.journal.recoverRecording(id)).owner;
      await f.journal.closeRecording(owner, index);
    }
    const db = await f.runtime.liveDeliveryIndex();
    await db.forget(db.find("r")!);
    const recovered = await f.journal.recoverRecording("r");
    assert.deepEqual(recovered.owner, f.owner);
    assert.deepEqual(recovered.fences, []);
    db.close();
    assert.deepEqual(await f.journal.recoverRecording("r"), recovered, "whole cache recreation is not an ownership change");
    await appendPendingLivePackets(f.runtime, [packet("a", 0)]);
    assert.equal((await f.journal.beginSend(opening.operation.session, "r:a:0:0:0")).status, "granted");
    await f.runtime.close();
    const restarted = f.makeRuntime();
    try {
      const cold = await liveSttJournal(restarted).recoverRecording("r");
      assert.equal(cold.owner.epoch, f.owner.epoch + 1);
      assert.equal(cold.fences[0]?.reason, "acceptance-unknown");
    } finally { await restarted.close(); }
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
}, 30_000); // 300 recording journals require hundreds of real durable syncs.

for (const stage of ["intent", "outcome", "fence"] as const) {
  for (const failure of ["torn", "sync", "cache"] as const) {
    serialTest(`preserves authoritative bytes and recovers new-format ${stage} after ${failure} failure`, async () => {
      const f = await fixture();
      const probe = await open(join(f.root, "original.ogg"));
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const { value: write } = Object.getOwnPropertyDescriptor(prototype, "writeFile") as { value: FileHandle["writeFile"] };
      const { value: sync } = Object.getOwnPropertyDescriptor(prototype, "sync") as { value: FileHandle["sync"] };
      const { value: publish } = Object.getOwnPropertyDescriptor(LiveDeliveryIndex.prototype, "publish") as { value: LiveDeliveryIndex["publish"] };
      let fired = false;
      let next: RecordingIngressRuntime | undefined;
      try {
        const opening = await f.journal.beginOpen(f.owner, "a");
        if (opening.status !== "granted" || opening.operation.kind !== "open") { throw new Error("missing open"); }
        await f.journal.complete({ operation: opening.operation, outcome: "opened" });
        await appendPendingLivePackets(f.runtime, [packet("a", 0)]);
        const send = stage === "outcome" ? await f.journal.beginSend(opening.operation.session, "r:a:0:0:0") : undefined;
        if (failure === "torn") {
          prototype.writeFile = async function (this: FileHandle, data, options) {
            if (!fired && typeof data === "string" && data.includes(`"type":"stt-${stage}"`)) {
              fired = true; await write.call(this, data.slice(0, Math.floor(data.length / 2)), options);
              throw new Error("synthetic torn write");
            }
            return write.call(this, data, options);
          };
        } else if (failure === "sync") {
          prototype.sync = async function (this: FileHandle) { await sync.call(this); if (!fired) { fired = true; throw new Error("synthetic thrown sync after surviving bytes"); } };
        } else {
          LiveDeliveryIndex.prototype.publish = function (this: LiveDeliveryIndex, index) { if (!fired) { fired = true; throw new Error("synthetic cache publication failure"); } publish.call(this, index); };
        }
        await assert.rejects(stage === "intent" ? f.journal.beginSend(opening.operation.session, "r:a:0:0:0")
          : stage === "fence" ? f.journal.fence(opening.operation.session, "acceptance-unknown")
          : send?.status === "granted" && send.operation.kind === "send"
            ? f.journal.complete({ operation: send.operation, outcome: "accepted" }) : Promise.reject(new Error("missing send")));
        assert.equal(fired, true);
        prototype.writeFile = write; prototype.sync = sync; LiveDeliveryIndex.prototype.publish = publish;
        await f.runtime.close(); next = f.makeRuntime();
        const recovery = await liveSttJournal(next).recoverRecording("r");
        assert.equal(recovery.fences[0]?.reason, "acceptance-unknown");
        assert.equal((await liveSttJournal(next).beginOpen(recovery.owner, "a")).status, "fenced");
        const retained = await pendingLivePackets(next, "r");
        assert.equal(retained.length, stage === "outcome" && failure !== "torn" ? 0 : 1);
        assert.deepEqual(await readFile(join(f.root, "original.ogg")), f.original);
      } finally {
        prototype.writeFile = write; prototype.sync = sync; LiveDeliveryIndex.prototype.publish = publish;
        await probe.close(); await f.runtime.close(); await next?.close(); await rm(f.root, { recursive: true, force: true });
      }
    });
  }
}

for (const stage of ["send", "finalize"] as const) {
  serialTest(`closed warm drain survives cache recreation but cold ${stage} uncertainty never replays`, async () => {
    const f = await fixture();
    let next: RecordingIngressRuntime | undefined;
    try {
      await appendPendingLivePackets(f.runtime, [packet("a", 0), packet("b", 1), packet("c", 2)]);
      const opening = await f.journal.beginOpen(f.owner, "a");
      assert.equal(opening.status, "granted");
      assert.equal(opening.operation.kind, "open");
      await f.journal.complete({ operation: opening.operation, outcome: "opened" });
      const fenced = await f.journal.beginOpen(f.owner, "c");
      assert.equal(fenced.status, "granted");
      assert.equal(fenced.operation.kind, "open");
      await f.journal.complete({ operation: fenced.operation, outcome: "opened" });
      await f.journal.fence(fenced.operation.session, "acceptance-unknown");
      await f.journal.closeRecording(f.owner, 1000);
      assert.equal((await f.journal.beginOpen(f.owner, "b")).status, "recording-closed");
      const eligible = () => pendingLivePackets(f.runtime, "r", "");
      assert.deepEqual((await eligible()).map((p) => p.speakerId), ["a"]);
      const db = await f.runtime.liveDeliveryIndex();
      await db.forget(db.find("r")!);
      assert.deepEqual((await eligible()).map((p) => p.speakerId), ["a"]);
      db.close();
      assert.deepEqual((await eligible()).map((p) => p.speakerId), ["a"]);
      const operation = stage === "send"
        ? await f.journal.beginSend(opening.operation.session, "r:a:0:0:0")
        : await f.journal.beginFinalize(opening.operation.session);
      assert.equal(operation.status, "granted");
      await f.runtime.close(); next = f.makeRuntime();
      assert.deepEqual(await pendingLivePackets(next, "r", ""), [], "cold reads cannot inherit warm eligibility");
      const journal = liveSttJournal(next);
      const cold = await journal.recoverRecording("r");
      assert.equal(cold.owner.epoch, f.owner.epoch + 1);
      assert.equal(cold.closed, true);
      assert.deepEqual(cold.fences.map((fence) => fence.speakerId).toSorted(), ["a", "c"]);
      assert.ok(cold.fences.every((fence) => fence.reason === "acceptance-unknown"));
      assert.deepEqual(await pendingLivePackets(next, "r", ""), []);
      await assert.rejects(journal.beginSend(opening.operation.session, "r:a:0:0:0"));
      await assert.rejects(journal.beginFinalize(opening.operation.session));
      assert.equal((await pendingLivePackets(next, "r")).length, 3, "uncertain and unopened payloads remain evidence");
      assert.deepEqual(await readFile(join(f.root, "original.ogg")), f.original);
    } finally { await f.runtime.close(); await next?.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}

serialTest("closed drain eligibility ends at clean settlement even with retained payloads", async () => {
  const f = await fixture();
  try {
    await appendPendingLivePackets(f.runtime, [packet("a", 0)]);
    const opening = await f.journal.beginOpen(f.owner, "a");
    assert.equal(opening.status, "granted");
    assert.equal(opening.operation.kind, "open");
    await f.journal.complete({ operation: opening.operation, outcome: "opened" });
    await f.journal.closeRecording(f.owner, 1000);
    assert.equal((await pendingLivePackets(f.runtime, "r", "")).length, 1);
    const finalizing = await f.journal.beginFinalize(opening.operation.session);
    assert.equal(finalizing.status, "granted");
    assert.equal(finalizing.operation.kind, "finalize");
    await f.journal.complete({ operation: finalizing.operation, outcome: "finalized" });
    assert.deepEqual(await pendingLivePackets(f.runtime, "r", ""), []);
    assert.equal((await pendingLivePackets(f.runtime, "r")).length, 1);
    assert.equal((await f.journal.beginFinalize(opening.operation.session)).status, "recording-closed");
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});

serialTest("speaker pending reads retain next-page knowledge, bound payloads, and fence exhaustion through cache rebuild and late ingress", async () => {
  const f = await fixture();
  try {
    const { pendingLiveSpeakerPackets } = await import("../src/live-delivery-outbox.js");
    await appendPendingLivePackets(f.runtime, [...Array.from({ length: 255 }, (_, n) => packet("a", n)),
      packet("b", 254), packet("b", 255)]);
    const page = await pendingLivePackets(f.runtime, "r", "");
    assert.equal(page.length, 256);
    assert.equal(page.filter(p => p.speakerId === "b").length, 1);
    const opening = await f.journal.beginOpen(f.owner, "b");
    assert.equal(opening.status, "granted"); assert.equal(opening.operation.kind, "open");
    await f.journal.complete({ operation: opening.operation, outcome: "opened" });
    let next = await pendingLiveSpeakerPackets(f.runtime, "r", "b");
    assert.equal(next.closed, false); assert.equal(next.packets.length, 1);
    const send = await f.journal.beginSend(opening.operation.session, next.packets[0]!.packetId);
    assert.equal(send.status, "granted"); assert.equal(send.operation.kind, "send");
    await f.journal.closeRecording(f.owner, 10_000);
    // An outstanding ACK/receipt remains pending; it cannot prove exhaustion.
    assert.equal((await pendingLiveSpeakerPackets(f.runtime, "r", "b")).packets[0]!.packetId, send.operation.packetId);
    await f.journal.complete({ operation: send.operation, outcome: "accepted" });
    const db = await f.runtime.liveDeliveryIndex(); await db.forget(db.find("r")!);
    next = await pendingLiveSpeakerPackets(f.runtime, "r", "b");
    assert.equal(next.closed, true); assert.equal(next.packets.length, 1); assert.equal(next.packets[0]!.relativeTimeMs, 5100);
    const last = await f.journal.beginSend(opening.operation.session, next.packets[0]!.packetId);
    assert.equal(last.status, "granted"); assert.equal(last.operation.kind, "send");
    await f.journal.complete({ operation: last.operation, outcome: "accepted" });
    assert.deepEqual(await pendingLiveSpeakerPackets(f.runtime, "r", "b"), { packets: [], closed: true });
    await appendPendingLivePackets(f.runtime, [packet("b", 256)]);
    assert.deepEqual(await pendingLiveSpeakerPackets(f.runtime, "r", "b"), { packets: [], closed: true });
    assert.equal((await pendingLivePackets(f.runtime, "r")).length, 255, "unopened retained evidence survives closed eligibility");
    await f.journal.fence(opening.operation.session, "acceptance-unknown");
    assert.equal((await pendingLiveSpeakerPackets(f.runtime, "r", "b")).packets.length, 0);
    assert.deepEqual(await readFile(join(f.root, "original.ogg")), f.original);
  } finally { await f.runtime.close(); await rm(f.root, { recursive: true, force: true }); }
});
