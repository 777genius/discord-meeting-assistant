import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { liveSttJournal, initializeLiveStt } from "../src/live-delivery-outbox.js";
import { RecordingIngressRuntime } from "../src/recording-ingress-runtime.js";

const roots: string[] = [];
const runtimes: RecordingIngressRuntime[] = [];
afterEach(async () => {
  for (const activeRuntime of runtimes.splice(0)) { await activeRuntime.close(); }
  for (const root of roots.splice(0)) { await rm(root, { recursive: true, force: true }); }
});
function runtime(root: string) {
  const value = new RecordingIngressRuntime({ spoolRoot: root, artifactLocatorPrefix: "synthetic",
    writer: { write: () => { throw new Error("unexpected artifact write"); } } });
  runtimes.push(value);
  return value;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stt-journal-"));
  roots.push(root);
  const ingress = runtime(root);
  await ingress.withExclusiveSpoolOwnership(() => ingress.exclusive("r", () => initializeLiveStt(ingress, "r")));
  return { root, ingress, journal: liveSttJournal(ingress) };
}
it("persists ownership before grants and fences unfinished openings on cold recovery", async () => {
  const { root, ingress, journal } = await fixture();
  const first = await journal.recoverRecording("r");
  const grant = await journal.beginOpen(first.owner, "a");
  expect(grant.status).toBe("granted");
  expect(await journal.recoverRecording("r")).toEqual(first);
  await expect(journal.beginOpen(first.owner, "a")).rejects.toBeDefined();
  await ingress.close();
  const recovered = liveSttJournal(runtime(root));
  const next = await recovered.recoverRecording("r");
  expect(next.owner.epoch).toBe(first.owner.epoch + 1);
  expect(next.fences).toEqual([{ speakerId: "a", reason: "acceptance-unknown" }]);
  expect(await recovered.beginOpen(next.owner, "a")).toEqual({ status: "fenced", reason: "acceptance-unknown" });
  expect((await recovered.beginOpen(next.owner, "b")).status).toBe("granted");
  await expect(recovered.beginOpen(first.owner, "c")).rejects.toBeDefined();
});
it("fails closed for missing markers and retains recording closure", async () => {
  const { journal } = await fixture();
  const legacy = await journal.recoverRecording("legacy");
  expect(await journal.beginOpen(legacy.owner, "a")).toEqual({ status: "fenced", reason: "legacy-unknown" });
  const current = await journal.recoverRecording("r");
  await journal.closeRecording(current.owner, 100);
  expect(await journal.beginOpen(current.owner, "a")).toEqual({ status: "recording-closed" });
  await journal.closeRecording(current.owner, 100);
  await expect(journal.closeRecording(current.owner, 101)).rejects.toBeDefined();
});

it("keeps known nonacceptance retry bounded across cold owners", async () => {
  const { root, ingress, journal } = await fixture();
  const first = await journal.recoverRecording("r");
  const grant = await journal.beginOpen(first.owner, "a");
  if (grant.status !== "granted") { throw new Error("expected open intent"); }
  await journal.complete({ operation: grant.operation, outcome: "not-accepted" });
  await journal.complete({ operation: grant.operation, outcome: "not-accepted" });
  await ingress.close();
  const recovered = liveSttJournal(runtime(root));
  const second = await recovered.recoverRecording("r");
  await expect(recovered.complete({ operation: grant.operation, outcome: "not-accepted" })).rejects.toBeDefined();
  const retry = await recovered.beginOpen(second.owner, "a");
  if (retry.status !== "granted") { throw new Error("expected one bounded retry"); }
  expect(retry.operation.session.generation).toBe(2);
  await recovered.complete({ operation: retry.operation, outcome: "not-accepted" });
  expect(await recovered.beginOpen(second.owner, "a")).toEqual({ status: "fenced", reason: "admission-rejected" });
});

it("rejects conflicting completion and cannot clear a durable fence with late success", async () => {
  const { journal } = await fixture();
  const owner = (await journal.recoverRecording("r")).owner;
  const grant = await journal.beginOpen(owner, "a");
  if (grant.status !== "granted" || grant.operation.kind !== "open") { throw new Error("expected open intent"); }
  await journal.fence(grant.operation.session, "provider-terminal");
  await journal.fence(grant.operation.session, "admission-rejected");
  await journal.complete({ operation: grant.operation, outcome: "opened" });
  await journal.complete({ operation: grant.operation, outcome: "opened" });
  await expect(journal.complete({ operation: grant.operation, outcome: "not-accepted" })).rejects.toBeDefined();
  expect(await journal.beginOpen(owner, "a")).toEqual({ status: "fenced", reason: "provider-terminal" });
});
