import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { afterEach, expect, it, vi } from "vitest";
import { PlatformRecordingIngress } from "../../src/application/platform-ingress.js";
import { PlatformLiveMeetingRuntime } from "../../src/live-runtime/platform-live-meeting-runtime.js";
import { LiveTranscriptionAcceptanceUnknown, type LiveFenceReason, type LiveOperation, type LiveSttDurabilityPort, type LiveVoicePacket } from "../../src/live-runtime/contracts.js";
import { livePacketIdentity } from "../../src/live-runtime/packet-delivery-ledger.js";
import { ended, logger, MemoryLiveMeetingRepository, packets, ProjectionStub, started, SummaryStub } from "./live-runtime-fixtures.js";

afterEach(() => vi.useRealTimers());

const grant = (operation: LiveOperation) => ({ status: "granted" as const, operation });
const stream = (speakerId: string, count: number, start = 0): LiveVoicePacket[] => Array.from({ length: count }, (_, index) => ({
    ...packets().packets[0]!, speakerId, relativeTimeMs: (index + start) * 20,
    mediaTimestamp: (index + start + 1) * 960, sequenceNumber: index + start + 1,
  }));


it.each([false, true])("acknowledges upstream pressure independently, drains terminal pages and preserves unknown-close fence=%s", async (failClose) => {
  vi.useFakeTimers();
  vi.setSystemTime(started().occurredAt);
  const source = { scopeId: "11111111111111111", roomId: started().roomId };
  const recordingId = started().recordingId;
  const speakerA = "11111111111111111";
  const speakerB = "22222222222222222";
  const retained = new Map<string, LiveVoicePacket>();
  const accepted = new Set<string>();
  const fences = new Map<string, LiveFenceReason>();
  const effects: string[] = [];
  const sends: string[] = [];
  const pages: number[] = [];
  const opens: string[] = [];
  let closed = false;
  let operationId = 0;
  let generation = 0;
  let activeSends = 0;
  let maximumActiveSends = 0;
  const owner = { recordingId, epoch: 1 };
  const durability: LiveSttDurabilityPort = {
    recoverRecording: async () => ({ owner, closed, legacy: false,
      fences: [...fences].map(([speakerId, reason]) => ({ speakerId, reason })) }),
    beginOpen: async (_, speakerId) => {
      const reason = fences.get(speakerId);
      if (reason !== undefined) { return { status: "fenced", reason }; }
      if (closed) { return { status: "recording-closed" }; }
      return grant({ kind: "open", session: { owner, speakerId, generation: ++generation }, operation: ++operationId });
    },
    beginSend: async (session, packetId) => {
      const reason = fences.get(session.speakerId);
      if (reason !== undefined) { return { status: "fenced", reason }; }
      if (accepted.has(packetId)) { return { status: "already-accepted" }; }
      expect(closed).toBe(false);
      return grant({ kind: "send", session, packetId, operation: ++operationId });
    },
    beginFinalize: async (session) => grant({ kind: "finalize", session, operation: ++operationId }),
    complete: async (completion) => {
      effects.push(completion.outcome);
      if (completion.outcome === "accepted") { accepted.add(completion.operation.packetId); }
      if (completion.outcome === "acceptance-unknown") { fences.set(completion.operation.session.speakerId, completion.outcome); }
    },
    fence: async (session, reason) => { fences.set(session.speakerId, reason); },
    closeRecording: async () => { effects.push("close"); closed = true; },
  };
  const meetings = new MemoryLiveMeetingRepository();
  const runtime = new PlatformLiveMeetingRuntime({
    logger, liveSttDurability: durability,
    appendTurn: new AppendLiveTranscriptTurn(meetings), finishMeeting: new FinishLiveMeeting(meetings),
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector: new ProjectionStub(), summarizer: new SummaryStub() }),
    startMeeting: new StartLiveMeeting({ meetings }),
    packetFlowControl: { maximumQueuedPacketsPerSpeaker: 1, maximumQueuedPacketsGlobally: 2, maximumConcurrentSessions: 2 },
    pendingLivePackets: async (_, after = "") => {
      // Retain accepted metadata so keyset cursors remain meaningful, as in the
      // production disposable index. Only eligible payloads enter the page.
      const sorted = [...retained.values()].toSorted((a, b) => a.relativeTimeMs - b.relativeTimeMs || a.speakerId.localeCompare(b.speakerId));
      const offset = after === "" ? 0 : sorted.findIndex((p) => livePacketIdentity(p) === after) + 1;
      const page = closed ? [] : sorted.slice(offset).filter((p) => !accepted.has(livePacketIdentity(p)) && !fences.has(p.speakerId)).slice(0, 256);
      pages.push(page.length);
      return page;
    },
    transcriber: { openSession: async (request) => {
      opens.push(request.speakerId);
      const delivered: { relativeTimeMs: number }[] = [];
      return {
        terminate: () => {},
        sendPacket: async (packet) => {
          sends.push(packet.packetId);
          activeSends++;
          maximumActiveSends = Math.max(maximumActiveSends, activeSends);
          if (request.speakerId === speakerA) { await new Promise<void>((resolve) => { setTimeout(resolve, 100); }); }
          activeSends--;
          delivered.push(packet);
          return "accepted";
        },
        finalize: async () => {
          request.onTranscript({ meetingId: recordingId, speakerId: request.speakerId, isFinal: true,
            startMs: delivered[0]!.relativeTimeMs, endMs: delivered.at(-1)!.relativeTimeMs + 20,
            text: `${request.speakerId}: ${delivered.length} packets` });
          // A flush followed by ambiguous close must retain evidence and fence
          // every subsequent generation, even though the outbox still has audio.
          if (failClose && request.speakerId === speakerB) { throw new LiveTranscriptionAcceptanceUnknown(); }
        },
      };
    } },
  });
  const ingress = new PlatformRecordingIngress({
    logger, live: runtime, failureClassifier: { classify: () => null },
    metrics: { recordIngress: () => {}, recordDerivedLiveFailure: () => {} },
    dispatcher: { dispatchPending: async () => ({ dispatched: 0, failed: 0 }) },
    outbox: { recordAndSchedule: async () => {} }, publicationTargets: { resolve: async () => null },
    ingress: {
      ingestAuthoritativeTrack: async () => { throw new Error("unexpected authoritative upload"); },
      ingestLifecycleEvent: async () => { throw new Error("unexpected lifecycle ingress"); },
      ingestPacketBatch: async (batch) => {
        for (const packet of batch.packets) { retained.set(livePacketIdentity(packet), packet); }
        return { recordingId, acceptedPackets: batch.packets.length, duplicatePackets: 0 };
      },
    },
  });
  const admit = async (batch: readonly LiveVoicePacket[]) => {
    const before = Date.now();
    let acknowledged = false;
    const acknowledgement = ingress.ingestVoiceBatch({ schemaVersion: 1, format: packets().format,
      packets: batch.map((packet) => ({ ...packet, schemaVersion: 1, source })) })
      .then(() => { acknowledged = true; return; });
    await vi.advanceTimersByTimeAsync(0);
    expect(acknowledged).toBe(true);
    await acknowledgement;
    // No virtual time or provider ACK is necessary for durable ingress ACK.
    expect(Date.now()).toBe(before);
  };
  try {
    await runtime.acceptLifecycle(started(recordingId, [speakerA, speakerB]));
    await runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_lost" });
    await runtime.acceptLifecycle({ ...ended(), type: "meeting.connection_recovered" });
    const initial = [...stream(speakerA, 100), ...stream(speakerB, 1)];
    await admit([initial[0]!, initial.at(-1)!]);
    for (const packet of initial.slice(1, -1)) { await admit([packet]); }
    await vi.advanceTimersByTimeAsync(1_000); // B's real 750ms idle expires while A remains pressured.
    expect(accepted.size).toBeLessThan(initial.length);
    expect(meetings.finalizedTurns.some((turn) => turn.speakerId === speakerB)).toBe(true);
    const tail = stream(speakerB, 513, 1);
    for (let index = 0; index < tail.length; index += 256) { await admit(tail.slice(index, index + 256)); }
    // Coalesced duplicate notifications neither retain extra pages nor replay sends.
    for (let index = 0; index < 50; index++) { await admit(tail.slice(0, 1)); }
    const finish = runtime.acceptLifecycle(ended());
    await vi.advanceTimersByTimeAsync(30_000);
    await finish;
    const eligible = failClose ? initial : [...initial, ...tail];
    expect(new Set(sends)).toEqual(new Set(eligible.map(livePacketIdentity)));
    expect(sends).toHaveLength(eligible.length);
    expect(accepted).toEqual(new Set(sends));
    expect(maximumActiveSends).toBeLessThanOrEqual(2);
    expect(Math.max(...pages)).toBeLessThanOrEqual(256);
    expect(effects.indexOf("close")).toBeGreaterThan(effects.lastIndexOf("accepted"));
    expect(meetings.snapshot?.status).toBe("ended");
    expect(meetings.finalizedTurns.map((turn) => turn.text)).toContain(`${speakerA}: 100 packets`);
    if (failClose) {
      expect(fences.get(speakerB)).toBe("acceptance-unknown");
      expect(opens.filter((id) => id === speakerB)).toHaveLength(1);
      expect([...retained.keys()].filter((id) => !accepted.has(id))).toEqual(tail.map(livePacketIdentity));
    } else {
      expect(fences.size).toBe(0);
      expect(meetings.finalizedTurns.map((turn) => turn.text)).toContain(`${speakerB}: 513 packets`);
    }
  } finally {
    const close = runtime.close();
    await vi.advanceTimersByTimeAsync(30_000);
    await close;
  }
  expect(vi.getTimerCount()).toBe(0);
}, 10_000);
