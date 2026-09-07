import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OssNativeEvidenceJournal } from "../src/oss-native-evidence.js";

const control = vi.hoisted(() => ({
  hold: false, releases: [] as (() => void)[], writes: 0, syncs: 0,
  failWrite: false, failSync: false, short: false, zero: false
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    write: (fd: number, row: Buffer, offset: number, length: number, position: null,
      callback: (error: Error | null, written: number) => void) => {
      control.writes++;
      if (control.failWrite) { queueMicrotask(() => { callback(new Error("disk"), 0); }); return; }
      if (control.zero) { queueMicrotask(() => { callback(null, 0); }); return; }
      fs.write(fd, row, offset, control.short ? Math.min(7, length) : length, position, callback);
    },
    fsync: (fd: number, callback: (error: Error | null) => void) => {
      control.syncs++;
      const run = () => {
        if (control.failSync) { callback(new Error("sync")); } else { fs.fsync(fd, callback); }
      };
      if (control.hold) { control.releases.push(run); } else { run(); }
    }
  };
});
const directories: string[] = [];
function fixture(maximumQueuedBytes?: number) {
  const directory = mkdtempSync(join(tmpdir(), "native-async-"));
  directories.push(directory);
  const input = { directory, project: "vtoss-test-oss-8f49a06-r1", testOnly: true,
    revision: "a".repeat(40), ...(maximumQueuedBytes === undefined ? {} : { maximumQueuedBytes }) };
  return { sink: new OssNativeEvidenceJournal(input), input,
    text: () => readFileSync(join(directory, "live-native.jsonl"), "utf8") };
}
afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(control, { hold: false, releases: [], writes: 0, syncs: 0,
    failWrite: false, failSync: false, short: false, zero: false });
  for (const directory of directories.splice(0)) { rmSync(directory, { recursive: true }); }
});
it("keeps record nonblocking during stalled fsync and waits for durable drain before sealing", async () => {
  control.hold = true;
  const { sink, text } = fixture();
  await vi.waitFor(() => { expect(control.releases).toHaveLength(1); });
  const session = sink.open();
  const event = { type: "audio_sent" as const, seq: 0 };
  vi.spyOn(Date, "now").mockReturnValue(1234);
  for (let seq = 0; seq < 100; seq++) { event.seq = seq; session.record(event); }
  session.record({ type: "success" });
  event.seq = 999;
  expect(control.writes).toBe(1);
  expect(() => { sink.seal(); }).toThrow("await close");
  let settled = false;
  const closing = sink.close().then(() => { settled = true; return; });
  expect(sink.close()).toBe(sink.close());
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  expect(settled).toBe(false);
  expect(text()).not.toContain("capture_seal");
  control.hold = false;
  control.releases.splice(0).forEach((release) => { release(); });
  await closing;
  const rows = text().trim().split("\n").map((line) => JSON.parse(line) as {
    index: number; atMs: number; event?: { seq: number }; type?: string;
  });
  expect(rows.map((row) => row.index)).toEqual(Array.from({ length: 103 }, (_, i) => i + 1));
  expect(rows.slice(1, 101).map((row) => row.event?.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  expect(rows.slice(1, 101).every((row) => row.atMs === 1234)).toBe(true);
  expect(rows.at(-1)?.type).toBe("capture_seal");
  expect(control.syncs).toBe(3);
  sink.seal();
  expect(() => sink.open()).toThrow();
});
it.each(["failWrite", "failSync", "zero"] as const)("rejects %s without a seal", async (failure) => {
  control[failure] = true;
  const { sink, text } = fixture();
  sink.open().record({ type: "success" });
  await expect(sink.settle()).rejects.toThrow("cannot qualify");
  await expect(sink.close()).rejects.toThrow("cannot qualify");
  expect(text()).not.toContain("capture_seal");
});
it("handles partial writes without duplication", async () => {
  control.short = true;
  const { sink, text } = fixture();
  sink.open().record({ type: "success" });
  await sink.close();
  expect(text().trim().split("\n")).toHaveLength(3);
  expect(control.writes).toBeGreaterThan(3);
});
it("counts in-flight bytes toward overflow and never seals rejected admission", async () => {
  control.hold = true;
  const { sink, text } = fixture(1024);
  await vi.waitFor(() => { expect(control.releases).toHaveLength(1); });
  const session = sink.open();
  for (let i = 0; i < 100; i++) { session.record({ type: "audio_sent", seq: i }); }
  session.record({ type: "success" });
  const closing = sink.close();
  control.hold = false;
  control.releases.splice(0).forEach((release) => { release(); });
  await expect(closing).rejects.toThrow("cannot qualify");
  expect(text()).not.toContain("capture_seal");
});
it("removes a seal whose fsync fails", async () => {
  const { sink, text } = fixture();
  sink.open().record({ type: "success" });
  await sink.settle();
  control.failSync = true;
  await expect(sink.close()).rejects.toThrow("cannot qualify");
  expect(text()).not.toContain("capture_seal");
});
it("rejects a symlink without touching its target", async () => {
  const { sink, input, text } = fixture();
  await sink.close();
  const other = mkdtempSync(join(tmpdir(), "native-symlink-"));
  directories.push(other);
  symlinkSync(join(input.directory, "live-native.jsonl"), join(other, "live-native.jsonl"));
  const before = text();
  expect(() => new OssNativeEvidenceJournal({ ...input, directory: other })).toThrow();
  expect(text()).toBe(before);
});
it("invalidates a late record during close instead of sealing incomplete evidence", async () => {
  control.hold = true;
  const { sink, text } = fixture();
  const session = sink.open();
  session.record({ type: "success" });
  await vi.waitFor(() => { expect(control.releases).toHaveLength(1); });
  const closing = sink.close();
  session.record({ type: "audio_accepted", seq: 1 });
  control.hold = false;
  control.releases.splice(0).forEach((release) => { release(); });
  await expect(closing).rejects.toThrow("cannot qualify");
  expect(text()).not.toContain("capture_seal");
});
it("bounds sessions even when callers never record an opening", async () => {
  const { sink } = fixture();
  for (let i = 0; i < 4096; i++) { sink.open(); }
  expect(() => sink.open()).toThrow("cannot qualify");
  await expect(sink.close()).rejects.toThrow("cannot qualify");
});
