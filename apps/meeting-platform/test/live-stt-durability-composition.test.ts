import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";
import { DurableCraigRecordingIngress } from "@discord-meeting/recording-ingress-adapter";
import { VoicetextAdapterError } from "@discord-meeting/voicetext-adapter";
import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { mapLiveAdmission } from "../src/composition/live-admission-mapper.js";
import { mapLiveSttDurability } from "../src/composition/live-stt-durability-mapper.js";
import { LiveSttAttemptController } from "../src/live-runtime/live-stt-attempt-controller.js";
import { LiveTranscriptionAcceptanceUnknown, LiveTranscriptionNotAccepted, type LiveTranscriptionPort } from "../src/live-runtime/contracts.js";
import { PlatformLiveMeetingRuntime } from "../src/live-runtime/platform-live-meeting-runtime.js";
import { LiveFencedSummaryPublicationPort } from "../src/application/live-fenced-summary-publication.js";
import { MemoryLiveMeetingRepository, ProjectionStub, SummaryStub, started } from "./live-runtime/live-runtime-fixtures.js";

const speakerId = "33333333333333333";
const event = { schemaVersion: 1, recordingId: "r", guildId: "11111111111111111", channelId: "22222222222222222" } as const;
const publicationRequest = {
  meetingId: "r", publicationTargetId: "synthetic", idempotencyKey: "synthetic-final",
  transcript: { recordingId: "r", transcriptId: "final", version: 1,
    turns: [{ turnId: "final-1", speakerId, startMs: 0, endMs: 20, text: "Authoritative speech" }] },
  summary: { summaryId: "summary", transcriptId: "final", version: 1, title: "Synthetic", overview: "Authoritative speech",
    topics: [], decisions: [], actionItems: [], openQuestions: [] },
};
const unavailable = () => new VoicetextAdapterError("provider_error", "synthetic", true, { gatewayCode: "PROVIDER_UNAVAILABLE" });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, resolve: release };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stt-review-composition-"));
  const makeIngress = () => new DurableCraigRecordingIngress({ spoolRoot: root, artifactLocatorPrefix: "synthetic",
    writer: { write: () => { throw new Error("unexpected authoritative write"); } } });
  const ingress = makeIngress();
  await ingress.ingestLifecycleEvent({ ...event, type: "meeting.started", eventId: "start", occurredAt: "2026-08-02T10:00:00.000Z", participantIds: [speakerId] });
  await ingress.ingestPacketBatch({ schemaVersion: 1, packets: [{ ...event, speakerId, opusBase64: "+P/+", receivedAtMs: 0, relativeTimeMs: 0, rtpTimestamp: 0, rtpSequence: 0 }] });
  const storage = mapLiveSttDurability(ingress.liveSttDurability);
  const packet = { durationSamples48Khz: 960, packetId: `r:${speakerId}:0:0:0`, opus: Uint8Array.of(0xf8, 0xff, 0xfe), relativeTimeMs: 0 };
  return { ingress, storage, packet, makeIngress, cleanup: async () => { await ingress.close(); await rm(root, { recursive: true, force: true }); } };
}
function controller(storage: ReturnType<typeof mapLiveSttDurability>, transcriber: LiveTranscriptionPort) {
  const failures: unknown[] = [];
  const attempt = new LiveSttAttemptController({ durability: storage, transcriber: mapLiveAdmission(transcriber),
    signal: new AbortController().signal, onFailure: (error) => { failures.push(error); return true; } });
  return { attempt, failures };
}
const request = (onTranscript: Parameters<LiveTranscriptionPort["openSession"]>[0]["onTranscript"]) => ({ meetingId: "r", speakerId, idempotencyKey: "synthetic", onTranscript });

for (const stage of ["opening", "send", "finalize"] as const) {
  it(`composition limits proven nonacceptance to opening, including ${stage} ambiguity`, async () => {
    const f = await fixture();
    let effects = 0;
    const { attempt } = controller(f.storage, { openSession: async () => {
      if (stage === "opening") { throw unavailable(); }
      return { terminate: () => {}, sendPacket: async () => { effects += 1; if (stage === "send") { throw unavailable(); } return "accepted"; },
        finalize: async () => { throw unavailable(); } };
    } });
    try {
      if (stage === "opening") {
        await assert.rejects(attempt.openSession(request(() => {})), LiveTranscriptionNotAccepted);
        await assert.rejects(attempt.openSession(request(() => {})), LiveTranscriptionNotAccepted);
      } else {
        const session = await attempt.openSession(request(() => {}));
        await assert.rejects(stage === "send" ? session.sendPacket(f.packet) : session.finalize(), LiveTranscriptionAcceptanceUnknown);
      }
      const recovery = await f.storage.recoverRecording("r");
      assert.equal(recovery.fences[0]?.reason, stage === "opening" ? "admission-rejected" : "acceptance-unknown");
      assert.notEqual((await f.storage.beginOpen(recovery.owner, speakerId)).status, "granted");
      assert.equal(effects, stage === "send" ? 1 : 0);
      await attempt.settle();
    } finally { await f.cleanup(); }
  });
}

it("settles a fenced abandoned send before its provider promise, but waits for the fence sync", async () => {
  const f = await fixture();
  const send = deferred();
  const sending = deferred();
  const fence = deferred();
  const persisted = deferred();
  const fencedStorage = { ...f.storage, fence: async (...args: Parameters<typeof f.storage.fence>) => {
    await fence.promise; await f.storage.fence(...args); persisted.resolve();
  } };
  const { attempt, failures } = controller(fencedStorage, { openSession: async () => ({ terminate: () => {}, finalize: async () => {}, sendPacket: async () => { sending.resolve(); await send.promise; return "accepted"; } }) });
  try {
    const session = await attempt.openSession(request(() => {}));
    const work = session.sendPacket(f.packet);
    const rejected = assert.rejects(work, LiveTranscriptionAcceptanceUnknown);
    // beginSend must have durably completed before terminating the provider work.
    await sending.promise;
    session.terminate();
    await assert.rejects(attempt.settle(), LiveTranscriptionAcceptanceUnknown);
    fence.resolve(); await persisted.promise;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await attempt.settle(); await attempt.settle();
    assert.ok(failures.some((failure) => failure instanceof LiveTranscriptionAcceptanceUnknown));
    send.resolve(); await rejected;
    assert.equal((await f.ingress.pendingLivePackets("r")).length, 1);
    assert.equal((await f.storage.recoverRecording("r")).fences[0]?.reason, "acceptance-unknown");
  } finally { send.resolve(); fence.resolve(); await f.cleanup(); }
});

it("rejects callbacks from finalized, replaced, terminated and opening-cancelled generations", async () => {
  const f = await fixture();
  const callbacks: Parameters<LiveTranscriptionPort["openSession"]>[0]["onTranscript"][] = [];
  const mutations: string[] = [];
  const opening = deferred();
  const entered = deferred();
  const { attempt } = controller(f.storage, { openSession: async (input) => {
    callbacks.push(input.onTranscript);
    if (callbacks.length === 3) { entered.resolve(); await opening.promise; }
    return { sendPacket: async () => "accepted", finalize: async () => {}, terminate: () => { emit(callbacks.length - 1); } };
  } });
  function emit(index: number) { callbacks[index]!({ meetingId: "r", speakerId, startMs: 0, endMs: 20, isFinal: true, text: "late" }); }
  try {
    const first = await attempt.openSession(request((value) => { mutations.push(value.text); }));
    await first.finalize(); emit(0);
    const second = await attempt.openSession(request((value) => { mutations.push(value.text); }));
    emit(0); await second.finalize(); emit(1);
    const signal = new AbortController();
    const third = attempt.openSession({ ...request((value) => { mutations.push(value.text); }), signal: signal.signal });
    const rejected = assert.rejects(third, LiveTranscriptionAcceptanceUnknown);
    await entered.promise; signal.abort(); emit(2); opening.resolve(); await rejected;
    first.terminate(); second.terminate(); emit(0); emit(1); emit(2);
    assert.deepEqual(mutations, []);
  } finally { opening.resolve(); await f.cleanup(); }
});

it("publication reuses persisted close time after active cleanup and restart, and rejects conflicting lifecycle", async () => {
  const f = await fixture();
  const meetings = new MemoryLiveMeetingRepository();
  const times: number[] = [];
  const finishMeeting = new FinishLiveMeeting(meetings);
  const executeFinish = finishMeeting.execute.bind(finishMeeting);
  finishMeeting.execute = (id, time) => { times.push(time); return executeFinish(id, time); };
  const makeRuntime = (storage: ReturnType<typeof mapLiveSttDurability>, now: number) => new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings), startMeeting: new StartLiveMeeting({ meetings }),
    finishMeeting,
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector: new ProjectionStub(), summarizer: new SummaryStub() }),
    clock: { nowMilliseconds: () => now, monotonicMilliseconds: () => performance.now() },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, liveSttDurability: storage,
    transcriber: { openSession: () => { throw new Error("closed recording must not open"); } },
  });
  let refuseClose = true;
  const runtime = makeRuntime({ ...f.storage, closeRecording: async (owner, time) => {
    if (refuseClose) { refuseClose = false; throw new Error("synthetic close failure before append"); }
    await f.storage.closeRecording(owner, time);
  } }, 2000);
  let restarted: PlatformLiveMeetingRuntime | undefined;
  let next: ReturnType<typeof f.makeIngress> | undefined;
  try {
    await runtime.acceptLifecycle({ ...started("r", [speakerId]), occurredAt: new Date(0).toISOString() });
    await assert.rejects(runtime.settleBeforeFinalPublication("r"));
    await runtime.acceptLifecycle({ type: "meeting.ended", recordingId: "r", occurredAt: new Date(1000).toISOString() });
    let publications = 0;
    const publish = (barrier: PlatformLiveMeetingRuntime) => new LiveFencedSummaryPublicationPort({ publish: async () => {
      publications += 1; return { ok: true, value: { externalPublicationId: "synthetic" } };
    } }, barrier, meetings).publish(publicationRequest);
    await publish(runtime);
    await f.ingress.close(); next = f.makeIngress();
    restarted = makeRuntime(mapLiveSttDurability(next.liveSttDurability), 3000);
    await publish(restarted);
    assert.equal(publications, 2); assert.deepEqual(times, [1000, 1000, 1000]);
    await assert.rejects(restarted.acceptLifecycle({ type: "meeting.ended", recordingId: "r", occurredAt: new Date(1001).toISOString() }));
  } finally { await runtime.releaseForRestart(); await restarted?.releaseForRestart(); await next?.close(); await f.cleanup(); }
});

it("runtime isolates a stalled speaker, publishes after durable abandonment, and suppresses late transcript mutations", async () => {
  const f = await fixture();
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new ProjectionStub();
  const summarizer = new SummaryStub();
  const sending = deferred();
  const healthy = deferred();
  const late = deferred();
  let callback!: Parameters<LiveTranscriptionPort["openSession"]>[0]["onTranscript"];
  const warnings: unknown[] = [];
  const transcriber: LiveTranscriptionPort = { openSession: async (input) => {
    if (input.speakerId === speakerId) { callback = input.onTranscript; }
    return { terminate: () => {}, finalize: async () => {}, sendPacket: async () => {
      if (input.speakerId === speakerId) { sending.resolve(); await late.promise; }
      else { input.onTranscript({ meetingId: "r", speakerId: input.speakerId, startMs: 0, endMs: 20, isFinal: true, text: "healthy speaker" }); healthy.resolve(); }
      return "accepted";
    } };
  } };
  const runtime = new PlatformLiveMeetingRuntime({ appendTurn: new AppendLiveTranscriptTurn(meetings),
    startMeeting: new StartLiveMeeting({ meetings }), finishMeeting: new FinishLiveMeeting(meetings),
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
    transcriber: mapLiveAdmission(transcriber), liveSttDurability: f.storage,
    pendingLivePackets: (id, after) => f.ingress.pendingLivePackets(id, after),
    packetFlowControl: { packetBackpressureTimeoutMs: 100 }, speakerIdleFinalizeMs: 100,
    logger: { debug: () => {}, info: () => {}, warn: (...args) => { warnings.push(args); }, error: () => {} },
  });
  try {
    await f.ingress.ingestPacketBatch({ schemaVersion: 1, packets: [{ ...event, speakerId: "44444444444444444", opusBase64: "+P/+", receivedAtMs: 0, relativeTimeMs: 0, rtpTimestamp: 0, rtpSequence: 0 }] });
    const start = runtime.acceptLifecycle(started("r", [speakerId, "44444444444444444"]));
    await sending.promise; await healthy.promise;
    await runtime.acceptLifecycle({ type: "meeting.connection_lost", recordingId: "r", occurredAt: "2026-08-02T10:00:01.000Z" });
    await start;
    // The first finish may observe the fence write still in flight; retry only the ownership barrier.
    let publications = 0;
    const publisher = new LiveFencedSummaryPublicationPort({ publish: async () => {
      publications += 1; return { ok: true, value: { externalPublicationId: "synthetic-final" } };
    } }, runtime, meetings);
    let finished = false;
    for (let tries = 0; tries < 20 && !finished; tries += 1) {
      try { await publisher.publish(publicationRequest); finished = true; }
      catch { await new Promise<void>((resolve) => { setTimeout(resolve, 10); }); }
    }
    assert.equal(finished, true); assert.equal(publications, 1);
    assert.deepEqual(meetings.finalizedTurns.map((turn) => turn.text), ["healthy speaker"]);
    assert.equal(meetings.snapshot?.status, "ended");
    assert.ok(warnings.length > 0);
    const before = JSON.stringify({ turns: meetings.finalizedTurns, captions: projector.requests, summaries: summarizer.requests });
    callback({ meetingId: "r", speakerId, startMs: 0, endMs: 20, isFinal: true, text: "must not mutate" });
    late.resolve(); await new Promise<void>((resolve) => { setTimeout(resolve, 30); });
    assert.equal(JSON.stringify({ turns: meetings.finalizedTurns, captions: projector.requests, summaries: summarizer.requests }), before);
    assert.ok((await f.ingress.pendingLivePackets("r")).some((row) => row.speakerId === speakerId));
  } finally { late.resolve(); await runtime.releaseForRestart(); await f.cleanup(); }
});

it("healthy connection loss/recovery and same-process idle finalization admit new segments without old callbacks", async () => {
  const f = await fixture();
  const meetings = new MemoryLiveMeetingRepository();
  const callbacks: Parameters<LiveTranscriptionPort["openSession"]>[0]["onTranscript"][] = [];
  let effects = 0;
  let finalizations = 0;
  const projector = new ProjectionStub();
  const summarizer = new SummaryStub();
  const runtime = new PlatformLiveMeetingRuntime({ appendTurn: new AppendLiveTranscriptTurn(meetings),
    startMeeting: new StartLiveMeeting({ meetings }), finishMeeting: new FinishLiveMeeting(meetings),
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
    transcriber: { openSession: async (input) => {
      callbacks.push(input.onTranscript);
      return { terminate: () => {}, finalize: async () => {}, sendPacket: async (packet) => {
        effects += 1;
        input.onTranscript({ meetingId: "r", speakerId, startMs: packet.relativeTimeMs, endMs: packet.relativeTimeMs + 20, isFinal: true, text: `segment ${effects}` });
        return "accepted";
      } };
    } }, liveSttDurability: { ...f.storage, complete: async (completion) => {
      await f.storage.complete(completion);
      if (completion.outcome === "finalized") { finalizations += 1; }
    } }, pendingLivePackets: (id, after) => f.ingress.pendingLivePackets(id, after),
    speakerIdleFinalizeMs: 100, logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  try {
    await runtime.acceptLifecycle(started("r", [speakerId]));
    for (let segment = 1; segment <= 3; segment += 1) {
      for (let tries = 0; tries < 50; tries += 1) {
        if (finalizations >= segment) { break; }
        await new Promise<void>((resolve) => { setTimeout(resolve, 10); });
      }
      assert.equal(finalizations, segment);
      // The counter advances only after the real completion journal sync.
      const before = JSON.stringify({ turns: meetings.finalizedTurns, captions: projector.requests, summaries: summarizer.requests });
      callbacks[segment - 1]!({ meetingId: "r", speakerId, startMs: 999, endMs: 1000, isFinal: true, text: "obsolete" });
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      assert.equal(JSON.stringify({ turns: meetings.finalizedTurns, captions: projector.requests, summaries: summarizer.requests }), before);
      if (segment === 3) { break; }
      await runtime.acceptLifecycle({ type: "meeting.connection_lost", recordingId: "r", occurredAt: "2026-08-02T10:00:01.000Z" });
      await f.ingress.ingestPacketBatch({ schemaVersion: 1, packets: [{ ...event, speakerId, opusBase64: "+P/+", receivedAtMs: segment * 20, relativeTimeMs: segment * 20, rtpTimestamp: segment * 960, rtpSequence: segment }] });
      await runtime.acceptLifecycle({ type: "meeting.connection_recovered", recordingId: "r", occurredAt: "2026-08-02T10:00:02.000Z" });
    }
    assert.equal(effects, 3); assert.equal(callbacks.length, 3);
    assert.deepEqual(meetings.finalizedTurns.map((turn) => turn.text), ["segment 1", "segment 2", "segment 3"]);
    assert.deepEqual(await f.ingress.pendingLivePackets("r"), []);
    assert.deepEqual((await f.storage.recoverRecording("r")).fences, []);
  } finally { await runtime.close(); await f.cleanup(); }
});

it("one proven opening rejection permits a healthy bounded retry and subsequent new segment", async () => {
  const f = await fixture();
  let openings = 0;
  let effects = 0;
  const { attempt } = controller(f.storage, { openSession: async () => {
    openings += 1;
    if (openings === 1) { throw unavailable(); }
    return { terminate: () => {}, finalize: async () => {}, sendPacket: async () => { effects += 1; return "accepted"; } };
  } });
  try {
    await assert.rejects(attempt.openSession(request(() => {})), LiveTranscriptionNotAccepted);
    const session = await attempt.openSession(request(() => {}));
    await session.sendPacket(f.packet); await session.finalize();
    const next = await attempt.openSession(request(() => {}));
    await next.finalize(); await attempt.settle();
    assert.equal(openings, 3); assert.equal(effects, 1);
    assert.deepEqual((await f.storage.recoverRecording("r")).fences, []);
  } finally { await f.cleanup(); }
});

it("durable lifecycle recovery rejects a terminal timestamp that conflicts with an earlier close", async () => {
  const f = await fixture();
  try {
    const recovery = await f.storage.recoverRecording("r");
    await f.storage.closeRecording(recovery.owner, Date.parse("2026-08-02T10:00:01.000Z"));
    await f.ingress.ingestLifecycleEvent({ ...event, type: "meeting.ended", eventId: "end",
      occurredAt: "2026-08-02T10:00:02.000Z", reason: null });
    await assert.rejects(f.storage.recoverRecording("r"));
    assert.equal((await f.ingress.pendingLivePackets("r")).length, 1);
  } finally { await f.cleanup(); }
});

it("terminal before idle drains the owned generation and persists finalize-only speech before publication", async () => {
  const f = await fixture();
  const meetings = new MemoryLiveMeetingRepository();
  const projector = new ProjectionStub();
  const summarizer = new SummaryStub();
  let callback!: Parameters<LiveTranscriptionPort["openSession"]>[0]["onTranscript"];
  let sends = 0;
  let finalizes = 0;
  let publications = 0;
  const runtime = new PlatformLiveMeetingRuntime({ appendTurn: new AppendLiveTranscriptTurn(meetings),
    startMeeting: new StartLiveMeeting({ meetings }), finishMeeting: new FinishLiveMeeting(meetings),
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector, summarizer }),
    transcriber: mapLiveAdmission({ openSession: async (input) => {
      callback = input.onTranscript;
      return { terminate: () => {}, sendPacket: async () => { sends += 1; return "accepted"; },
        finalize: async () => {
          const recovery = await f.storage.recoverRecording("r");
          assert.equal(recovery.closed, true, "admission closes before provider finalization");
          assert.equal((await f.storage.beginOpen(recovery.owner, "new-speaker")).status, "recording-closed");
          finalizes += 1;
          input.onTranscript({ meetingId: "r", speakerId, startMs: 0, endMs: 20, isFinal: true, text: "finalize-only tail" });
        } };
    } }), liveSttDurability: f.storage,
    pendingLivePackets: (id, after) => f.ingress.pendingLivePackets(id, after),
    speakerIdleFinalizeMs: 10_000,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  let next: ReturnType<typeof f.makeIngress> | undefined;
  try {
    await runtime.acceptLifecycle(started("r", [speakerId]));
    assert.equal(sends, 1); assert.equal(finalizes, 0);
    assert.deepEqual(meetings.finalizedTurns, []);
    await runtime.acceptLifecycle({ type: "meeting.ended", recordingId: "r", occurredAt: "2026-08-02T10:00:01.000Z" });
    const publisher = new LiveFencedSummaryPublicationPort({ publish: async () => {
      assert.equal(finalizes, 1);
      assert.deepEqual(meetings.finalizedTurns.map((turn) => turn.text), ["finalize-only tail"]);
      publications += 1; return { ok: true, value: { externalPublicationId: "synthetic-final" } };
    } }, runtime, meetings);
    await publisher.publish(publicationRequest);
    assert.equal(publications, 1); assert.equal(finalizes, 1);
    assert.equal(meetings.snapshot?.status, "ended");
    const before = JSON.stringify({ turns: meetings.finalizedTurns, captions: projector.requests, summaries: summarizer.requests });
    callback({ meetingId: "r", speakerId, startMs: 20, endMs: 40, isFinal: true, text: "late callback" });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    assert.equal(JSON.stringify({ turns: meetings.finalizedTurns, captions: projector.requests, summaries: summarizer.requests }), before);
    assert.deepEqual(await f.ingress.pendingLivePackets("r"), []);
    const warm = await f.storage.recoverRecording("r");
    assert.equal(warm.closed, true); assert.deepEqual(warm.fences, []);
    assert.equal((await f.storage.beginOpen(warm.owner, speakerId)).status, "recording-closed");
    await runtime.releaseForRestart(); await f.ingress.close(); next = f.makeIngress();
    const coldStorage = mapLiveSttDurability(next.liveSttDurability);
    const cold = await coldStorage.recoverRecording("r");
    assert.equal(cold.closed, true); assert.equal(cold.endedAtMs, warm.endedAtMs);
    assert.deepEqual(cold.fences, [], "clean terminal drain survives journal replay");
    assert.equal((await coldStorage.beginOpen(cold.owner, speakerId)).status, "recording-closed");
  } finally {
    await Promise.allSettled([runtime.releaseForRestart()]);
    await next?.close(); await f.cleanup();
  }
});

it("terminal ingress during held ACK drains every pending page before settlement", async () => {
  const f = await fixture();
  const meetings = new MemoryLiveMeetingRepository();
  const sent: string[] = [];
  const pageSizes: number[] = [];
  const sending = deferred();
  const ack = deferred();
  let finalizes = 0;
  const runtime = new PlatformLiveMeetingRuntime({
    appendTurn: new AppendLiveTranscriptTurn(meetings), startMeeting: new StartLiveMeeting({ meetings }),
    finishMeeting: new FinishLiveMeeting(meetings),
    refreshMeeting: new RefreshLiveMeeting({ meetings, projector: new ProjectionStub(), summarizer: new SummaryStub() }),
    liveSttDurability: f.storage,
    pendingLivePackets: async (id, after) => {
      const page = await f.ingress.pendingLivePackets(id, after);
      pageSizes.push(page.length);
      return page;
    },
    packetFlowControl: { maximumQueuedPacketsPerSpeaker: 1, maximumQueuedPacketsGlobally: 1 },
    transcriber: { openSession: async (input) => ({
      terminate: () => {},
      sendPacket: async (packet) => {
        sent.push(packet.packetId);
        if (sent.length === 2) { sending.resolve(); await ack.promise; }
        return "accepted";
      },
      finalize: async () => {
        assert.equal((await f.storage.recoverRecording("r")).closed, true);
        finalizes += 1;
        input.onTranscript({ meetingId: "r", speakerId, startMs: 0, endMs: 10300,
          isFinal: true, text: `Complete durable speech: ${sent.length} packets` });
      },
    }) },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  try {
    await runtime.acceptLifecycle(started("r", [speakerId]));
    const tail = Array.from({ length: 514 }, (_, index) => ({ ...event, speakerId,
      opusBase64: "+P/+", receivedAtMs: 0, relativeTimeMs: (index + 1) * 20,
      rtpTimestamp: (index + 1) * 960, rtpSequence: index + 1 }));
    for (let index = 0; index < tail.length; index += 256) {
      await f.ingress.ingestPacketBatch({ schemaVersion: 1, packets: tail.slice(index, index + 256) });
    }
    const pending = await f.ingress.pendingLivePackets("r", "");
    assert.equal(pending.length, 256);
    const draining = runtime.acceptVoiceBatch({ format: { channelCount: 1, codec: "opus", sampleRateHz: 48_000 }, packets: pending });
    await sending.promise;
    await f.ingress.ingestLifecycleEvent({ ...event, type: "meeting.ended", eventId: "end",
      occurredAt: "2026-08-02T10:00:16.000Z", reason: null });
    const ending = runtime.acceptLifecycle({ type: "meeting.ended", recordingId: "r", occurredAt: "2026-08-02T10:00:16.000Z" });
    assert.equal(finalizes, 0);
    ack.resolve();
    await draining;
    await ending;
    await runtime.settleBeforeFinalPublication("r");
    assert.equal(finalizes, 1);
    assert.equal(sent.length, 515, "the loaded page and all subsequent pages must reach the provider");
    assert.deepEqual(sent, [f.packet.packetId, ...tail.map((p) => `r:${speakerId}:${p.rtpTimestamp}:${p.rtpSequence}:${p.relativeTimeMs}`)]);
    assert.ok(pageSizes.includes(256));
    assert.ok(pageSizes.every((size) => size <= 256));
    assert.deepEqual(meetings.finalizedTurns.map((turn) => turn.text), ["Complete durable speech: 515 packets"]);
    const recovered = await f.storage.recoverRecording("r");
    assert.equal(recovered.closed, true);
    assert.deepEqual(recovered.fences, []);
    assert.equal(meetings.snapshot?.status, "ended");
  } finally { ack.resolve(); await runtime.close(); await f.cleanup(); }
}, 30_000);
