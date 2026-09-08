import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { appendPendingLivePackets, initializeLiveStt, liveSttJournal, pendingLivePackets } from "../src/live-delivery-outbox.js";
import { LiveDeliveryIndex } from "../src/live-delivery-index.js";
import { RecordingIngressRuntime } from "../src/recording-ingress-runtime.js";
import type { DecodedPacket } from "../src/recording-ingress-invariants.js";

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

it("pages only eligible payloads through prolonged degradation and repeated reconnects without deleting evidence", async () => {
  const f = await fixture();
  try {
    const opening = await f.journal.beginOpen(f.owner, "a");
    assert.equal(opening.status, "granted");
    if (opening.status !== "granted") { throw new Error("missing intent"); }
    await f.journal.fence(opening.operation.session, "acceptance-unknown");
    await appendPendingLivePackets(f.runtime, Array.from({ length: 4096 }, (_, index) => packet("a", index)));
    await appendPendingLivePackets(f.runtime, Array.from({ length: 600 }, (_, index) => packet("b", 599 - index)));
    const probe = await open(join(f.root, "original.ogg"));
    const prototype = Object.getPrototypeOf(probe) as FileHandle;
    const read = prototype.read;
    let reads = 0;
    prototype.read = function (...args: Parameters<FileHandle["read"]>) { reads += 1; return read.apply(this, args); } as FileHandle["read"];
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
});

it("reconstructs spool ownership after cache eviction with constant journal bookkeeping and many completed recordings", async () => {
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
});

for (const stage of ["intent", "outcome", "fence"] as const) {
  for (const failure of ["torn", "sync", "cache"] as const) {
    it(`preserves authoritative bytes and recovers new-format ${stage} after ${failure} failure`, async () => {
      const f = await fixture();
      const probe = await open(join(f.root, "original.ogg"));
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const write = prototype.writeFile;
      const sync = prototype.sync;
      const publish = LiveDeliveryIndex.prototype.publish;
      let fired = false;
      let next: RecordingIngressRuntime | undefined;
      try {
        const opening = await f.journal.beginOpen(f.owner, "a");
        if (opening.status !== "granted" || opening.operation.kind !== "open") { throw new Error("missing open"); }
        await f.journal.complete({ operation: opening.operation, outcome: "opened" });
        await appendPendingLivePackets(f.runtime, [packet("a", 0)]);
        const send = stage === "outcome" ? await f.journal.beginSend(opening.operation.session, "r:a:0:0:0") : undefined;
        if (failure === "torn") {
          prototype.writeFile = async function (data, options) {
            if (!fired && typeof data === "string" && data.includes(`"type":"stt-${stage}"`)) {
              fired = true; await write.call(this, data.slice(0, Math.floor(data.length / 2)), options);
              throw new Error("synthetic torn write");
            }
            return write.call(this, data, options);
          };
        } else if (failure === "sync") {
          prototype.sync = async function () { await sync.call(this); if (!fired) { fired = true; throw new Error("synthetic thrown sync after surviving bytes"); } };
        } else {
          LiveDeliveryIndex.prototype.publish = function (index) { if (!fired) { fired = true; throw new Error("synthetic cache publication failure"); } return publish.call(this, index); };
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
