import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, vi } from "vitest";
import { DurableCraigRecordingIngress } from "@discord-meeting/recording-ingress-adapter";
import { VoicetextLiveTranscriptionAdapter, type OssSessionEvidenceEvent,
  type VoicetextInboundFrame, type VoicetextWebSocketConnection } from "@discord-meeting/voicetext-adapter";
import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { LiveFencedSummaryPublicationPort } from "../src/application/live-fenced-summary-publication.js";
import { mapLiveAdmission } from "../src/composition/live-admission-mapper.js";
import { mapLiveSttDurability } from "../src/composition/live-stt-durability-mapper.js";
import { PlatformLiveMeetingRuntime } from "../src/live-runtime/platform-live-meeting-runtime.js";
import { LiveTranscriptionAcceptanceUnknown } from "../src/live-runtime/contracts.js";
import { MemoryLiveMeetingRepository, ProjectionStub, SummaryStub, started } from "./live-runtime/live-runtime-fixtures.js";

// Only the external WebSocket port is fake. No listener, DNS or network is used.
// ACK delivery is independent of send completion, as is gateway-owned close.
class HeldAckSocket implements VoicetextWebSocketConnection {
  public readonly secondPacket = Promise.withResolvers<void>();
  public readonly controls: string[] = [];
  public readonly binary: Uint8Array[] = [];
  public closeCalls = 0;
  public terminateCalls = 0;
  private readonly frames: VoicetextInboundFrame[] = [];
  private waiter: ((frame: VoicetextInboundFrame) => void) | undefined;

  public async sendText(data: string): Promise<void> {
    const message = JSON.parse(data) as { type: string };
    this.controls.push(message.type);
    if (message.type === "config") {
      this.message({ type: "ready", provider: "deepgram", model: "nova-3",
        session_id: "00000000-0000-4000-8000-000000000001" });
    } else if (message.type === "finalize") {
      this.message({ type: "final", start_ms: 0, duration_ms: 10_300,
        text: "Complete durable speech: 515 packets" });
      this.message({ type: "finalize_complete", status: "flushed", saw_result: true });
    } else { throw new Error("Unexpected client control: " + message.type); }
  }
  public async sendBinary(data: Uint8Array): Promise<void> {
    this.binary.push(Uint8Array.from(data));
    if (this.binary.length === 2) { this.secondPacket.resolve(); }
    else { this.message({ type: "ack", seq: this.binary.length }); }
  }
  public async close(): Promise<void> { this.closeCalls += 1; }
  public terminate(): void { this.terminateCalls += 1; }
  public message(message: Readonly<Record<string, unknown>>): void {
    this.push({ type: "text", data: JSON.stringify(message) });
  }
  public serverClose(): void { this.push({ type: "close", code: 1000, reason: "synthetic" }); }
  public receive(signal: AbortSignal): Promise<VoicetextInboundFrame> {
    signal.throwIfAborted();
    const frame = this.frames.shift();
    if (frame !== undefined) { return Promise.resolve(frame); }
    assert.equal(this.waiter, undefined, "one receive pump owns the transport");
    return new Promise((resolve, reject) => {
      const abort = () => { this.waiter = undefined; reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      this.waiter = received => {
        signal.removeEventListener("abort", abort);
        resolve(received);
      };
    });
  }
  private push(frame: VoicetextInboundFrame): void {
    const waiter = this.waiter;
    if (waiter === undefined) { this.frames.push(frame); return; }
    this.waiter = undefined;
    waiter(frame);
  }
}

const speakerId = "33333333333333333";
const event = { schemaVersion: 1, recordingId: "r", guildId: "11111111111111111", channelId: "22222222222222222" } as const;
const endedAt = "2026-08-02T10:00:16.000Z";
const unknownFence = (error: unknown) => error instanceof AggregateError &&
  error.errors.length === 1 && error.errors[0] instanceof LiveTranscriptionAcceptanceUnknown;
const publicationRequest = {
  meetingId: "r", publicationTargetId: "synthetic", idempotencyKey: "synthetic-final",
  transcript: { recordingId: "r", transcriptId: "final", version: 1,
    turns: [{ turnId: "final-1", speakerId, startMs: 0, endMs: 20, text: "Authoritative speech" }] },
  summary: { summaryId: "summary", transcriptId: "final", version: 1, title: "Synthetic", overview: "Authoritative speech",
    topics: [], decisions: [], actionItems: [], openQuestions: [] },
};

for (const close of ["delayed-normal", "missing"] as const) {
  it(`real live adapter drains 515 held-ACK packets before finalize and ${close} close gates publication`, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const root = await mkdtemp(join(tmpdir(), "stt-terminal-adapter-"));
    const makeIngress = () => new DurableCraigRecordingIngress({ spoolRoot: root, artifactLocatorPrefix: "synthetic",
      writer: { write: () => { throw new Error("Unexpected authoritative write"); } } });
    const ingress = makeIngress();
    const storage = mapLiveSttDurability(ingress.liveSttDurability);
    const socket = new HeldAckSocket();
    const native: OssSessionEvidenceEvent[] = [];
    const terminalObserved = Promise.withResolvers<void>();
    const failureStarted = Promise.withResolvers<void>();
    const persistFailure = Promise.withResolvers<void>();
    const failurePersisted = Promise.withResolvers<void>();
    const completions: string[] = [];
    const pages: number[] = [];
    let opens = 0;
    let publications = 0;
    let publicationSettled = false;
    let endingSettled = false;
    const meetings = new MemoryLiveMeetingRepository();
    const transcriber = new VoicetextLiveTranscriptionAdapter({
      endpoint: "wss://offline.invalid", token: "synthetic-machine-token", finalizeTimeoutMs: 1000,
      evidenceSink: { open: () => ({ record: evidence => {
        native.push(evidence);
        if (evidence.type === "received" && evidence.message.type === "finalize_complete") { terminalObserved.resolve(); }
      } }) },
    }, { connect: async () => { opens += 1; return socket; } });
    const runtime = new PlatformLiveMeetingRuntime({
      appendTurn: new AppendLiveTranscriptTurn(meetings), startMeeting: new StartLiveMeeting({ meetings }),
      finishMeeting: new FinishLiveMeeting(meetings),
      refreshMeeting: new RefreshLiveMeeting({ meetings, projector: new ProjectionStub(), summarizer: new SummaryStub() }),
      transcriber: mapLiveAdmission(transcriber),
      // Advance source pacing with each transport delivery; only terminal timers
      // are advanced below. Filesystem journal operations still run normally.
      clock: { nowMilliseconds: () => Date.parse(endedAt) + socket.binary.length * 20,
        monotonicMilliseconds: () => 0 },
      liveSttDurability: { ...storage, complete: async completion => {
        if (completion.outcome === "acceptance-unknown") {
          failureStarted.resolve(); await persistFailure.promise;
        }
        await storage.complete(completion);
        completions.push(completion.outcome);
        if (completion.outcome === "acceptance-unknown") { failurePersisted.resolve(); }
      } },
      pendingLiveSpeakerPackets: (id, speaker) => ingress.pendingLiveSpeakerPackets(id, speaker),
      pendingLivePackets: async (id, after) => {
        const page = await ingress.pendingLivePackets(id, after); pages.push(page.length); return page;
      },
      packetFlowControl: { maximumQueuedPacketsPerSpeaker: 1, maximumQueuedPacketsGlobally: 1 },
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
    let restarted: ReturnType<typeof makeIngress> | undefined;
    try {
      await ingress.ingestLifecycleEvent({ ...event, type: "meeting.started", eventId: "start",
        occurredAt: "2026-08-02T10:00:00.000Z", participantIds: [speakerId] });
      const packets = Array.from({ length: 515 }, (_, index) => ({ ...event, speakerId,
        opusBase64: "+P/+", receivedAtMs: 0, relativeTimeMs: index * 20,
        rtpTimestamp: index * 960, rtpSequence: index }));
      await ingress.ingestPacketBatch({ schemaVersion: 1, packets: packets.slice(0, 1) });
      await runtime.acceptLifecycle(started("r", [speakerId]));
      for (let index = 1; index < packets.length; index += 256) {
        await ingress.ingestPacketBatch({ schemaVersion: 1, packets: packets.slice(index, index + 256) });
      }
      const pending = await ingress.pendingLivePackets("r", "");
      assert.equal(pending.length, 256);
      const draining = runtime.acceptVoiceBatch({ format: { channelCount: 1, codec: "opus", sampleRateHz: 48_000 }, packets: pending });
      await socket.secondPacket.promise;
      await ingress.ingestLifecycleEvent({ ...event, type: "meeting.ended", eventId: "end", occurredAt: endedAt, reason: null });
      const ending = runtime.acceptLifecycle({ type: "meeting.ended", recordingId: "r", occurredAt: endedAt });
      void ending.then(() => (endingSettled = true), () => (endingSettled = true));
      const publisher = new LiveFencedSummaryPublicationPort({ publish: async request => {
        // Authoritative publication may survive a failed derived branch, but only after its durable fence.
        const recovery = await storage.recoverRecording("r");
        assert.deepEqual(recovery.fences, close === "missing" ? [{ speakerId, reason: "acceptance-unknown" }] : []);
        assert.equal(native.some(e => e.type === "success"), close === "delayed-normal");
        assert.deepEqual(request.transcript, publicationRequest.transcript);
        publications += 1;
        return { ok: true, value: { externalPublicationId: "synthetic-final" } };
      } }, runtime, meetings);
      const publishing = publisher.publish(publicationRequest);
      void publishing.then(() => (publicationSettled = true), () => (publicationSettled = true));
      assert.deepEqual(socket.controls, ["config"]);
      assert.equal(socket.binary.length, 2);
      assert.equal(completions.filter(outcome => outcome === "accepted").length, 1);
      assert.equal(publications, 0);
      socket.message({ type: "ack", seq: 2 });
      await draining;
      await terminalObserved.promise;
      await vi.advanceTimersByTimeAsync(999);
      assert.equal(endingSettled, false);
      assert.equal(publicationSettled, false);
      assert.equal(publications, 0);
      assert.equal(native.some(e => e.type === "success"), false);
      assert.equal(completions.includes("finalized"), false);
      assert.deepEqual(socket.controls, ["config", "finalize"]);
      assert.equal(socket.binary.length, 515);
      assert.ok(socket.binary.every(bytes => Buffer.from(bytes).equals(Buffer.from([0xf8, 0xff, 0xfe]))));
      const sentIds = native.filter(e => e.type === "audio_send").map(e => e.packetId);
      assert.deepEqual(sentIds, packets.map(p => `r:${speakerId}:${p.rtpTimestamp}:${p.rtpSequence}:${p.relativeTimeMs}`));
      assert.equal(completions.filter(outcome => outcome === "accepted").length, 515);
      const finalizeIndex = native.findIndex(e => e.type === "finalize_send");
      assert.equal(native.slice(0, finalizeIndex).filter(e => e.type === "audio_accepted").length, 515);
      assert.ok(pages.includes(256));
      assert.ok(pages.every(size => size <= 256));
      assert.equal((await storage.recoverRecording("r")).closed, true);
      if (close === "delayed-normal") { socket.serverClose(); }
      else {
        await vi.advanceTimersByTimeAsync(1);
        await failureStarted.promise;
        // An unsynced failure cannot release the authoritative publication barrier.
        await assert.rejects(ending, unknownFence);
        await assert.rejects(publishing, unknownFence);
        assert.equal(publications, 0);
        persistFailure.resolve();
        await failurePersisted.promise;
        await new Promise<void>(resolve => { setImmediate(resolve); });
      }
      if (close === "delayed-normal") { await ending; await publishing; }
      else { await publisher.publish(publicationRequest); }
      assert.equal(publications, 1);
      assert.equal(meetings.snapshot?.status, "ended");
      assert.deepEqual(meetings.finalizedTurns.map(turn => turn.text), ["Complete durable speech: 515 packets"]);
      assert.equal(completions.filter(outcome => outcome === "finalized").length, close === "delayed-normal" ? 1 : 0);
      assert.deepEqual(socket.controls, ["config", "finalize"]);
      assert.equal(socket.closeCalls, 0);
      assert.equal(socket.terminateCalls, close === "missing" ? 1 : 0);
      assert.equal(opens, 1);
      assert.deepEqual(await ingress.pendingLivePackets("r"), []);
      const warm = await storage.recoverRecording("r");
      assert.deepEqual(warm.fences, close === "missing" ? [{ speakerId, reason: "acceptance-unknown" }] : []);
      assert.equal(warm.endedAtMs, Date.parse(endedAt));
      if (close === "missing") {
        assert.ok(native.some(e => e.type === "failure"));
        assert.equal(native.some(e => e.type === "close" || e.type === "success"), false);
      } else {
        assert.deepEqual(native.filter(e => e.type === "close" || e.type === "success"), [{ type: "close", code: 1000 }, { type: "success" }]);
      }
      await runtime.releaseForRestart();
      await ingress.close();
      restarted = makeIngress();
      const coldStorage = mapLiveSttDurability(restarted.liveSttDurability);
      const cold = await coldStorage.recoverRecording("r");
      assert.equal(cold.closed, true);
      assert.equal(cold.endedAtMs, warm.endedAtMs);
      assert.deepEqual(cold.fences, warm.fences, "journal replay preserves the unknown fence or proven clean completion");
      assert.notEqual((await coldStorage.beginOpen(cold.owner, speakerId)).status, "granted");
    } finally {
      persistFailure.resolve();
      await runtime.releaseForRestart();
      await restarted?.close();
      await ingress.close();
      await rm(root, { recursive: true, force: true });
      vi.useRealTimers();
    }
  }, 30_000);
}
