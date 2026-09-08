import { DurableCraigRecordingIngress } from "@discord-meeting/recording-ingress-adapter";
import { AppendLiveTranscriptTurn, FinishLiveMeeting, RefreshLiveMeeting, StartLiveMeeting } from "@discord-meeting/meeting-core/live-meeting";
import { PlatformLiveMeetingRuntime } from "../../../src/live-runtime/platform-live-meeting-runtime.js";
import { mapLiveSttDurability } from "../../../src/composition/live-stt-durability-mapper.js";
import {
  LiveTranscriptionNotAccepted, LiveTranscriptionTerminalFailure,
  type LiveSttDurabilityPort, type LiveTranscriptionPort,
} from "../../../src/live-runtime/contracts.js";
import { MemoryLiveMeetingRepository, ProjectionStub, SummaryStub, started } from "../live-runtime-fixtures.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { Meeting, type MeetingRepository, type MeetingSnapshot } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { ProcessMeetingSummary, type ProcessMeetingSummaryDependencies } from "@discord-meeting/meeting-core/post-call-workflow";
import { join } from "node:path";
import { LiveFencedSummaryPublicationPort } from "../../../src/application/live-fenced-summary-publication.js";

const [root, phase, scenario] = process.argv.slice(2);
if (root === undefined || root === "" || phase === undefined || phase === "" ||
    scenario === undefined || scenario === "" || process.send === undefined) { throw new Error("synthetic IPC worker arguments missing"); }
const deadline = setTimeout(() => { throw new Error("synthetic runtime worker deadline"); }, 14_000);
let messageId = 0;
let finalized!: () => void;
const cleanFinalization = new Promise<void>((resolve) => { finalized = resolve; });
async function parent(type: string, detail: unknown = null): Promise<void> {
  const id = ++messageId;
  await new Promise<void>((resolve) => {
    const listener = (message: { ack?: number }): void => {
      if (message.ack === id) { process.off("message", listener); resolve(); }
    };
    process.on("message", listener);
    process.send!({ id, type, detail });
  });
}
const ingress = new DurableCraigRecordingIngress({ spoolRoot: root, artifactLocatorPrefix: "synthetic",
  writer: { write: async (request) => {
    const chunks: Uint8Array[] = [];
    if (request.body instanceof Uint8Array) { chunks.push(request.body); }
    else { for await (const chunk of request.body) { chunks.push(chunk); } }
    const bytes = Buffer.concat(chunks);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    assert.equal(checksum, request.checksumSha256);
    assert.equal(bytes.length, request.sizeBytes);
    await mkdir(join(root, "artifacts"), { recursive: true });
    const path = artifactPath(request.locator);
    try { await writeFile(path, bytes, { flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") { throw error; }
      assert.deepEqual(await readFile(path), bytes);
    }
    return { checksumSha256: checksum, locator: request.locator, sizeBytes: bytes.length, versionId: checksum };
  } } });
const storage = mapLiveSttDurability(ingress.liveSttDurability);
const durability: LiveSttDurabilityPort = {
  ...storage,
  closeRecording: async (owner, endedAtMs) => {
    await storage.closeRecording(owner, endedAtMs);
    await parent("durable-close");
  },
  beginOpen: async (owner, speaker) => {
    const result = await storage.beginOpen(owner, speaker);
    if (result.status === "granted") { await parent("open-intent", result.operation.session); }
    return result;
  },
  beginSend: async (owner, packet) => {
    const result = await storage.beginSend(owner, packet);
    if (result.status === "granted") { await parent("send-intent"); }
    return result;
  },
  beginFinalize: async (owner) => {
    const result = await storage.beginFinalize(owner);
    if (result.status === "granted") { await parent("finalize-intent"); }
    return result;
  },
  complete: async (completion) => {
    await parent("before-" + completion.outcome);
    await storage.complete(completion);
    await parent("durable-" + completion.outcome);
    if (completion.outcome === "finalized") { finalized(); }
  },
};
const transcriber: LiveTranscriptionPort = {
  openSession: async (request) => {
    await parent("open-effect", request.idempotencyKey);
    return {
      sendPacket: async (packet) => {
        if (scenario === "not-accepted" && phase === "first") { throw new LiveTranscriptionNotAccepted(); }
        await parent("accepted-effect", packet.packetId);
        if (scenario === "terminal" && phase === "first") { throw new LiveTranscriptionTerminalFailure(); }
        request.onTranscript({ meetingId: "r", speakerId: "33333333333333333", startMs: packet.relativeTimeMs,
          endMs: packet.relativeTimeMs + 20, text: "Synthetic speech", isFinal: true });
        return "accepted";
      },
      finalize: async () => { await parent("finalize-effect"); },
      terminate: () => {},
    };
  },
};
async function append(sequence: number): Promise<void> {
  await ingress.ingestPacketBatch({ schemaVersion: 1, packets: [{
    channelId: "22222222222222222", guildId: "11111111111111111", recordingId: "r", speakerId: "33333333333333333", schemaVersion: 1,
    opusBase64: "+P/+", receivedAtMs: sequence * 20, relativeTimeMs: sequence * 20,
    rtpTimestamp: sequence * 960, rtpSequence: sequence,
  }] });
}
const meetings = new MemoryLiveMeetingRepository();
const runtime = new PlatformLiveMeetingRuntime({
  appendTurn: new AppendLiveTranscriptTurn(meetings), finishMeeting: new FinishLiveMeeting(meetings),
  startMeeting: new StartLiveMeeting({ meetings }),
  refreshMeeting: new RefreshLiveMeeting({ meetings, projector: new ProjectionStub(), summarizer: new SummaryStub() }),
  clock: {
    nowMilliseconds: () => Date.parse("2026-08-02T10:00:01.000Z"),
    monotonicMilliseconds: () => performance.now(),
  },
  speakerIdleFinalizeMs: 100, transcriber, liveSttDurability: durability,
  pendingLivePackets: (id, after) => ingress.pendingLivePackets(id, after),
  logger: { debug: () => {}, info: () => {}, error: () => {}, warn: (message, fields) => { process.send!({ type: "degraded", detail: { message, fields } }); } },
});
try {
  if (phase === "first") {
    await ingress.ingestLifecycleEvent({ schemaVersion: 1, type: "meeting.started", recordingId: "r",
      channelId: "22222222222222222", guildId: "11111111111111111", eventId: "start", occurredAt: "2026-08-02T10:00:00.000Z", participantIds: ["33333333333333333"] });
    await append(0);
    if (scenario === "legacy") { await rm(join(root, "live-delivery-v1"), { recursive: true }); }
    await parent("pending");
  } else if (scenario === "finalized") {
    await append(0);
    await append(1);
  }
  await runtime.acceptLifecycle(started("r", ["33333333333333333"]));
  if (phase === "first" && scenario === "closed-before-finish") {
    await cleanFinalization;
    await runtime.acceptLifecycle({ type: "meeting.ended", recordingId: "r", occurredAt: "2026-08-02T10:00:02.000Z" });
  }
  if (phase === "first") {
    // The parent kills at the selected exact intent/effect/receipt barrier.
    await new Promise<void>(() => {});
  } else {
    // An ordinary reconnect in the fresh runtime cannot rotate a healthy epoch.
    await runtime.acceptLifecycle({ type: "meeting.connection_recovered", recordingId: "r", occurredAt: "2026-08-02T10:00:01.000Z" });
    if (["pending", "not-accepted", "finalized"].includes(scenario)) { await cleanFinalization; }
    try { await runtime.releaseForRestart(); }
    catch { await parent("release-degraded"); }
    await parent("recovery", await storage.recoverRecording("r"));
    await parent("pending-after", (await ingress.pendingLivePackets("r")).map((packet) => packet.packetId));
    if (scenario === "authoritative" || scenario === "closed-before-finish") { await recoverAuthoritative(); }
    await ingress.close();
  }
  process.send({ type: "done" });
} catch (error) {
  process.send({ type: "failed", detail: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
} finally { clearTimeout(deadline); process.disconnect(); }

function artifactPath(locator: string): string {
  return join(root!, "artifacts", createHash("sha256").update(locator).digest("hex"));
}

async function recoverAuthoritative(): Promise<void> {
  const original = await readFile(join(root!, "original.ogg"));
  const checksum = createHash("sha256").update(original).digest("hex");
  const envelope = { recordingId: "r", channelId: "22222222222222222", guildId: "11111111111111111", schemaVersion: 1 } as const;
  await ingress.ingestLifecycleEvent({ ...envelope, type: "meeting.ended", eventId: "ended",
    occurredAt: "2026-08-02T10:00:02.000Z", reason: null });
  await ingress.ingestAuthoritativeTrack({ ...envelope, uploadId: "original-track", speakerId: "33333333333333333",
    trackNumber: 1, timelineOffsetMs: 0, checksumSha256: checksum, sizeBytes: original.length },
  (async function* () { yield original; })());
  const result = await ingress.ingestLifecycleEvent({ ...envelope, type: "recording.authoritative_ready", eventId: "ready",
    occurredAt: "2026-08-02T10:00:03.000Z", endedAt: "2026-08-02T10:00:02.000Z", trackCount: 1,
    sourceFilesChecksumSha256: checksum });
  assert.equal(result.kind, "finalized");
  assert.equal(result.recording.speakerAudio[0]?.checksumSha256, checksum);
  const path = join(root!, "meeting.json");
  await writeFile(path, JSON.stringify(Meeting.record({
    actors: [{ actorId: "33333333333333333", kind: "unknown" }],
    identityProvenance: null, lifecycleGeneration: 1,
    meetingId: "r", publicationTargetId: "synthetic-results", recording: result.recording,
    source: { scopeId: envelope.guildId, roomId: envelope.channelId } }).toSnapshot()));
  const repository: MeetingRepository = {
    findById: async () => JSON.parse(await readFile(path, "utf8")) as MeetingSnapshot,
    save: async (snapshot, expectedRevision) => {
      const previous = JSON.parse(await readFile(path, "utf8")) as MeetingSnapshot;
      assert.equal(previous.revision, expectedRevision);
      await writeFile(path, JSON.stringify(snapshot));
    },
  };
  let refusePublication = true;
  const dependencies: ProcessMeetingSummaryDependencies = {
    meetings: repository,
    transcriber: { transcribe: async (request) => {
      const reference = request.recording.speakerAudio[0]!;
      const bytes = await readFile(artifactPath(reference.audioLocator));
      assert.equal(createHash("sha256").update(bytes).digest("hex"), checksum);
      assert.equal(reference.checksumSha256, checksum);
      await parent("batch-effect", reference);
      return { ok: true, value: { transcriptId: "authoritative-transcript", version: 1,
        turns: [{ turnId: "turn-1", speakerId: "33333333333333333", startMs: 0, endMs: 20, text: "Keep the original." }] } };
    } },
    summarizer: { generate: async () => ({ ok: true, value: {
      summaryId: "summary-1", version: 1, title: "Synthetic meeting", overview: "Keep the original.",
      topics: [{ title: "Recording", points: ["Keep the original."], evidenceTurnIds: ["turn-1"] }],
      decisions: [{ decisionId: "decision-1", text: "Keep the original.", evidenceTurnIds: ["turn-1"] }],
      actionItems: [], openQuestions: [],
    } }) },
    publisher: new LiveFencedSummaryPublicationPort({ publish: async (request) => {
      if (refusePublication) { refusePublication = false; throw new Error("synthetic publication unavailable before acceptance"); }
      assert.equal(request.transcript.transcriptId, "authoritative-transcript");
      await parent("publication-effect", request);
      return { ok: true, value: { externalPublicationId: "synthetic-publication" } };
    } }, runtime, meetings),
  };
  const failed = await new ProcessMeetingSummary(dependencies).execute("r");
  assert.equal(failed.status, "failed");
  const recovered = await new ProcessMeetingSummary(dependencies).execute("r");
  assert.equal(recovered.status, "published");
  assert.equal((await new ProcessMeetingSummary(dependencies).execute("r")).status, "published");
  assert.deepEqual(await readFile(join(root!, "original.ogg")), original);
  await parent("authoritative-recovered", { checksum, recording: await ingress.completedRecording("r") });
}
