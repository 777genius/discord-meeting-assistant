import { appendPendingLivePackets, initializeLiveStt, liveSttJournal, pendingLivePackets } from "../../src/live-delivery-outbox.js";
import { RecordingIngressRuntime } from "../../src/recording-ingress-runtime.js";
import type { SttOperation } from "../../src/live-stt-journal-contracts.js";

const [root, phase, scenario] = process.argv.slice(2);
if (root === undefined || phase === undefined || scenario === undefined || process.send === undefined) {
  throw new Error("synthetic worker requires sandbox path, phase, scenario and parent IPC");
}
const runtime = new RecordingIngressRuntime({ spoolRoot: root, artifactLocatorPrefix: "synthetic",
  writer: { write: () => { throw new Error("live worker must not write original artifacts"); } } });
const journal = liveSttJournal(runtime);
let messageNumber = 0;
async function parent(type: string, detail: unknown = null): Promise<void> {
  const id = ++messageNumber;
  await new Promise<void>((resolve) => {
    const listener = (message: { ack?: number }): void => {
      if (message.ack === id) { process.off("message", listener); resolve(); }
    };
    process.on("message", listener);
    process.send!({ id, type, detail });
  });
}
function packet(sequence: number) {
  return { guildId: "g", channelId: "c", recordingId: "r", speakerId: "s",
    rtpTimestamp: sequence * 960, rtpSequence: sequence, relativeTimeMs: sequence * 20,
    receivedAtMs: sequence * 20, opus: Uint8Array.of(0xf8, 0xff, 0xfe) };
}
async function append(sequence: number): Promise<void> {
  await runtime.withExclusiveSpoolOwnership(() => runtime.exclusive("r", () => appendPendingLivePackets(runtime, [packet(sequence)])));
}
function requireOperation(value: { status: string; operation?: SttOperation }): SttOperation {
  if (value.status !== "granted" || value.operation === undefined) { throw new Error("expected executable grant"); }
  return value.operation;
}
async function run(): Promise<void> {
  if (phase === "first") {
    await runtime.withExclusiveSpoolOwnership(() => runtime.exclusive("r", async () => {
      if (scenario !== "legacy") { await initializeLiveStt(runtime, "r"); }
    }));
    await append(0);
    await parent("pending");
  }
  const recovered = await journal.recoverRecording("r");
  const pending = await pendingLivePackets(runtime, "r");
  await parent("recovery", { ...recovered, pending: pending.map((value) => value.packetId) });
  if (phase === "restart") {
    await parent("repeat-recovery", await journal.recoverRecording("r"));
    if (scenario === "finalized") {
      await append(0);
      await append(1);
    }
    if (recovered.closed || recovered.fences.length > 0 || scenario === "legacy") {
      await parent("denied", await journal.beginOpen(recovered.owner, "s"));
      return;
    }
    if ((await pendingLivePackets(runtime, "r")).length === 0) { return; }
  }
  const grant = await journal.beginOpen(recovered.owner, "s");
  if (grant.status !== "granted") { await parent("denied", grant); return; }
  const opening = requireOperation(grant);
  if (opening.kind !== "open") { throw new Error("wrong open kind"); }
  await parent("open-before", opening);
  await parent("open-effect", opening.session);
  await parent("open-after");
  await journal.complete({ operation: opening, outcome: "opened" });
  const payloads = await pendingLivePackets(runtime, "r");
  const payload = payloads[0];
  if (payload === undefined) { throw new Error("expected synthetic payload"); }
  const sending = requireOperation(await journal.beginSend(opening.session, payload.packetId));
  if (sending.kind !== "send") { throw new Error("wrong send kind"); }
  await parent("before-send");
  if (scenario === "not-accepted" && phase === "first") {
    await parent("nonacceptance-effect");
    await journal.complete({ operation: sending, outcome: "not-accepted" });
    await parent("not-accepted");
    return;
  }
  await parent("accepted-effect", payload.packetId);
  if (scenario === "terminal" && phase === "first") {
    await parent("terminal");
    await journal.complete({ operation: sending, outcome: "provider-terminal" });
    return;
  }
  await parent("after-accept");
  await journal.complete({ operation: sending, outcome: "accepted" });
  await parent("accepted-unfinalized");
  const finalizing = requireOperation(await journal.beginFinalize(opening.session));
  if (finalizing.kind !== "finalize") { throw new Error("wrong finalize kind"); }
  await parent("finalize-before");
  await parent("finalize-effect");
  await parent("finalize-after");
  await journal.complete({ operation: finalizing, outcome: "finalized" });
  await parent("finalized");
  if (scenario === "closed") {
    await journal.closeRecording(recovered.owner, 1000);
    await parent("closed");
  }
}
try { await run(); await runtime.close(); process.send({ type: "done" }); }
catch (error) { process.send({ type: "failed", detail: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
finally { process.disconnect(); }
