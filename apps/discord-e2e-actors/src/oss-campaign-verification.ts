import { verifyNativeCampaignSources } from "./oss-native-campaign-sources.js";
import { verifyOssRecording } from "./oss-recording-evidence.js";
import { normalizeDatabase, assertExactDatabaseCounts } from "./e2e-retained-evidence-snapshot.js";
import { inspectOggOpus } from "./fixture-integrity.js";
import { z } from "zod";
import { fixtureManifestV1Schema } from "./e2e-fixture-manifest-schema.js";
import { requireEvidence as check, same, sha256, canonical, type Archive } from "./oss-campaign-artifacts.js";
import { manifestDigest, runSchema, targetSchema, time, id, wireSchema, type OssRun } from "./oss-campaign-profile.js";
import { verifyOssQuality } from "./oss-campaign-quality.js";

const deploymentSchema = z.object({
  target: targetSchema,
  beforeMs: time, afterMs: time,
  platformImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  craigImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  gatewayImageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  operatorCaPath: id,
  // Full isolated-project inventory, not counts computed from a chosen recording alone.
  recordingIdsBefore: z.array(id).length(0),
  recordingIdsAfter: z.array(id).length(3),
  targetAfter: targetSchema,
}).strict();

const databaseSchema = z.object({
  matchingMeetingCount: z.literal(1), matchingRecordingCount: z.literal(1),
  matchingSummaryCount: z.literal(1), matchingTranscriptCount: z.literal(1),
  snapshot: z.unknown(),
}).strict();

export const ossMissingSourceCapabilities = [
  "Complete correlated Craig/Platform/gateway packet and per-session wire collection",
  "Pinned Craig original-source checksum recomputation from retained original files",
  "Native post-call stage start timestamps and independently retained settlement observations",
] as const;

export async function verifyOssCampaign(archive: Archive, fixtureManifestBytes: Buffer) {
  check(sha256(fixtureManifestBytes) === manifestDigest, "Unpinned fixture manifest");
  const manifest = fixtureManifestV1Schema.parse(JSON.parse(fixtureManifestBytes.toString("utf8")));
  const { plan, index } = archive;
  const deployment = deploymentSchema.parse(archive.json(index.deploymentPath, "deployment"));
  check(same(deployment.target, plan.target) && same(deployment.targetAfter, plan.target),
    "Deployment/current source identity mismatch");
  check(sha256(archive.bytes(deployment.operatorCaPath, "deployment")) === plan.target.operatorCaSha256,
    "Operator CA mismatch");
  check(same(index.runs.map(({ runId }) => runId), plan.runs.map(({ runId }) => runId)), "Run index mismatch");
  const runs = await Promise.all(index.runs.map(async (entry, position) => {
    const run = runSchema.parse(archive.json(entry.evidencePath, "postgres"));
    const expected = plan.runs[position]!;
    check(run.runId === expected.runId && run.scenario === expected.scenario &&
      run.campaignId === plan.campaignId, "Run identity mismatch");
    check(run.startedAtMs >= deployment.beforeMs && run.settled[1]!.observedAtMs <= deployment.afterMs &&
      deployment.afterMs <= index.capturedAtMs, "Deployment observation window mismatch");
    await verifyRun(archive, run);
    verifyOssQuality(run, manifest, archive.json(run.actorPath, "actor"));
    return run;
  }));
  for (const select of [
    (run: OssRun) => run.meetingId, (run: OssRun) => run.recordingId,
    (run: OssRun) => run.transcript.transcriptId, (run: OssRun) => run.summary.summaryId,
    (run: OssRun) => run.publication.messageId, (run: OssRun) => run.actorPath,
  ]) check(new Set(runs.map(select)).size === 3, "Duplicate campaign business effect/identity");
  const originalPaths = runs.flatMap((run) => run.originals);
  check(new Set(originalPaths).size === originalPaths.length, "Original recording reused between runs");
  const sessionIds = runs.flatMap((run) => run.sessions.map((session) => session.sessionId));
  check(new Set(sessionIds).size === sessionIds.length, "Provider session reused between runs");
  check(same([...deployment.recordingIdsAfter].sort(), runs.map((run) => run.recordingId).sort()),
    "Extra/missing recording effect in isolated project");
  for (let position = 1; position < runs.length; position++) {
    check(runs[position]!.startedAtMs > runs[position - 1]!.settled[1]!.observedAtMs,
      "Next scenario began before previous terminal collection");
  }
  const native = index.nativeSources === undefined ? undefined : verifyNativeCampaignSources(archive, runs);
  const missingSourceCapabilities: readonly string[] = native?.missingSourceCapabilities ?? ossMissingSourceCapabilities;
  return {
    // These checks establish consistency of retained inputs, not their collection provenance.
    // The current sources cannot supply the complete live archive or original checksum proof.
    kind: "oss-discord-stt-evidence-check-v1" as const,
    status: missingSourceCapabilities.length === 0 ? "passed" as const : "sources-unverified" as const,
    missingSourceCapabilities,
    campaignId: plan.campaignId,
    planSha256: archive.planSha256,
    collectionSha256: archive.indexSha256,
    fixtureManifestSha256: manifestDigest,
    collectorRevision: plan.collectorRevision,
    runs: runs.map(({ runId, scenario, recordingId, meetingId, transcript, summary, publication }) => ({
      runId, scenario, recordingId, meetingId, transcriptId: transcript.transcriptId,
      summaryId: summary.summaryId, messageId: publication.messageId,
    })),
    artifacts: index.artifacts,
  };
}

async function verifyRun(archive: Archive, run: OssRun): Promise<void> {
  verifyOssRecording(archive, run);
  const database = normalizeDatabase(databaseSchema.parse(archive.json(run.databasePath, "postgres")));
  assertExactDatabaseCounts(database, "OSS terminal collection");
  const snapshot = database.snapshot;
  check(snapshot.meetingId === run.meetingId && snapshot.recording.recordingId === run.recordingId &&
    run.transcript.version === String(snapshot.revision) &&
    snapshot.transcript.transcriptId === run.transcript.transcriptId &&
    same(snapshot.transcript.turns, run.transcript.turns) && same(snapshot.summary, run.summary) &&
    snapshot.publication.externalPublicationId === run.publication.messageId &&
    snapshot.publicationTargetId === archive.plan.target.resultsChannelId &&
    snapshot.recording.speakerAudio.length === run.tracks.length,
  "Retained database snapshot disagrees with OSS evidence");
  const retainedManifest = archive.artifact(run.manifestPath);
  archive.bytes(run.manifestPath, "object-storage");
  check(retainedManifest.sha256 === snapshot.recording.manifestChecksumSha256 &&
    retainedManifest.size === snapshot.recording.manifestSizeBytes &&
    retainedManifest.source.locator === snapshot.recording.manifestLocator &&
    retainedManifest.source.version === snapshot.recording.manifestRevision,
  "Immutable authoritative manifest identity mismatch");
  check(run.startedAtMs < run.endedAtMs && run.endedAtMs <= run.terminalAtMs, "Invalid terminal timeline");
  check(same(run.lifecycle.map((event) => event.type),
    ["meeting.started", "meeting.ended", "recording.authoritative_ready"]) &&
    run.lifecycle.every((event) => event.recordingId === run.recordingId) &&
    run.lifecycle[0]!.atMs === run.startedAtMs && run.lifecycle[1]!.atMs === run.endedAtMs &&
    run.lifecycle[2]!.atMs >= run.endedAtMs && run.lifecycle[2]!.atMs <= run.terminalAtMs,
  "Lifecycle/finalize ordering mismatch");
  check(new Set(run.originals).size === run.originals.length, "Duplicate original recording artifact");
  for (const path of run.originals) archive.bytes(path, "craig");
  const speakers = ["1533227577286852649", "1533228054724346087"];
  check(same(run.tracks.map((track) => track.speakerId).sort(), speakers), "Authoritative track speakers mismatch");
  for (const track of run.tracks) {
    const bytes = archive.bytes(track.path, "object-storage");
    const retained = archive.artifact(track.path);
    const dbTrack = snapshot.recording.speakerAudio.filter((entry) => entry.speakerId === track.speakerId);
    check(dbTrack.length === 1 && dbTrack[0]!.checksumSha256 === retained.sha256 &&
      dbTrack[0]!.sizeBytes === retained.size && dbTrack[0]!.audioLocator === retained.source.locator &&
      dbTrack[0]!.artifactRevision === retained.source.version &&
      dbTrack[0]!.timelineOffsetMs === track.timelineOffsetMs, "Immutable batch track identity mismatch");
    const inspected = await inspectOggOpus(bytes);
    const speakerTurns = run.transcript.turns.filter((turn) => turn.speakerId === track.speakerId);
    check(inspected.durationMs + track.timelineOffsetMs + 3500 >=
      Math.max(...speakerTurns.map((turn) => turn.endMs)), "Truncated authoritative track");
    check(track.originalPaths.length === new Set(track.originalPaths).size &&
      track.originalPaths.every((path) => run.originals.includes(path)), "Track original/source binding mismatch");
  }
  check(run.originals.every((path) => run.tracks.some((track) => track.originalPaths.includes(path))),
    "Unmapped original recording");
  check(run.summary.transcriptId === run.transcript.transcriptId, "Summary transcript mismatch");
  const summaryKey = ["evidence-summary:v3", run.meetingId, run.transcript.transcriptId]
    .map((part, index) => index === 0 ? part : `${part.length}:${part}`).join("|");
  check(run.summary.summaryId === `outline-${sha256(`${run.meetingId}\0${summaryKey}\0${run.transcript.transcriptId}`).slice(0, 32)}`,
    "Outline summary operation identity mismatch");
  const n = run.transcript.turns.length;
  const presentations = [
    ["Meeting transcript", `Authoritative transcript finalized with ${n} turn${n === 1 ? "" : "s"}. See the attached transcript for complete evidence.`],
    ["Транскрипт встречи", `Финальный транскрипт составлен по записи встречи. Реплик: ${n}. Полная версия приложена для проверки.`],
    ["Транскрипт зустрічі", `Фінальний транскрипт складено за записом зустрічі. Реплік: ${n}. Повну версію додано для перевірки.`],
  ];
  check(presentations.some(([title, overview]) => run.summary.title === title && run.summary.overview === overview),
    "Outline presentation differs from transcript-outline output");
  check(same(run.stages.map((stage) => stage.stage), ["transcription", "summary", "publication"]),
    "Duplicate/missing post-call stage");
  let completed = run.lifecycle[2]!.atMs;
  for (const stage of run.stages) {
    check(stage.startedAtMs >= completed && stage.completedAtMs >= stage.startedAtMs,
      "Post-call publication ordering violated");
    completed = stage.completedAtMs;
  }
  check(run.publication.channelId === archive.plan.target.resultsChannelId &&
    run.publication.authorId === archive.plan.target.publicationApplicationId &&
    run.publication.createdAtMs >= run.stages[2]!.startedAtMs &&
    run.publication.createdAtMs <= completed && completed <= run.terminalAtMs,
  "Publication identity/timestamp mismatch");
  const attachment = archive.bytes(run.publication.transcriptAttachmentPath, "discord").toString("utf8");
  let cursor = 0;
  for (const turn of run.transcript.turns) {
    const position = attachment.indexOf(turn.text, cursor);
    check(position >= cursor, "Full authoritative transcript absent from publication");
    cursor = position + turn.text.length;
  }
  const outline = archive.bytes(run.publication.summaryAttachmentPath, "discord").toString("utf8");
  check(outline.includes(run.summary.title) && outline.includes(run.summary.overview), "Outline attachment mismatch");
  for (const settled of run.settled) {
    check(same(settled.meetingIds, [run.meetingId]) && same(settled.recordingIds, [run.recordingId]) &&
      same(settled.transcriptIds, [run.transcript.transcriptId]) && same(settled.summaryIds, [run.summary.summaryId]) &&
      same(settled.finalMessageIds, [run.publication.messageId]) &&
      settled.transcriptSha256 === sha256(canonical(run.transcript)) &&
      settled.terminalAtMs === run.terminalAtMs && settled.observedAtMs >= run.terminalAtMs &&
      settled.observedAtMs <= archive.index.capturedAtMs, "Unstable/duplicate terminal business evidence");
  }
  check(run.settled[1]!.observedAtMs > run.settled[0]!.observedAtMs, "Independent terminal reads required");
  check(same([...new Set(run.sessions.map((session) => session.speakerId))].sort(), speakers),
    "Missing live speaker session");
  if (archive.index.nativeSources !== undefined) return; // Complete native journal is checked campaign-wide.
  const finals = run.sessions.flatMap((session) => verifySession(archive, run, session));
  check(new Set(finals.map((turn) => turn.turnId)).size === finals.length, "Duplicate live final effect");
  check(same([...finals].sort((a, b) => a.turnId.localeCompare(b.turnId)),
    [...run.liveTurns].sort((a, b) => a.turnId.localeCompare(b.turnId))), "Live ledger/wire mismatch");
}

function verifySession(archive: Archive, run: OssRun, session: OssRun["sessions"][number]) {
  check(session.sourceRevision === archive.plan.target.gatewayRevision, "Stale gateway session source");
  const wire = wireSchema.parse(archive.json(session.wirePath, "gateway"));
  check(wire.sessionId === session.sessionId && wire.speakerId === session.speakerId &&
    wire.meetingId === run.meetingId && wire.recordingId === run.recordingId &&
    wire.gatewayEndpoint === archive.plan.target.gatewayEndpoint, "Live wire identity mismatch");
  const events = wire.events;
  check(events[0]!.type === "ready" && events.at(-1)!.type === "closed", "Missing live ready/terminal");
  let lastTime = run.startedAtMs;
  let sent = 0;
  let acknowledged = 0;
  let finalized = false;
  let complete = false;
  const finals: OssRun["liveTurns"] = [];
  let partials = 0;
  let packetOffset = 0;
  let packetPaths: string[] | undefined;
  for (const [position, event] of events.entries()) {
    check(event.atMs >= lastTime && event.atMs <= run.terminalAtMs, "Unordered live timestamps");
    lastTime = event.atMs;
    check(!complete || event.type === "closed", "Live event after finalize complete");
    switch (event.type) {
      case "ready": check(position === 0, "Duplicate live ready"); break;
      case "audio": {
        check(!finalized && event.seq === sent + 1 && event.offset === packetOffset,
          "Duplicate/out-of-order packet or audio after finalize");
        const paths = [event.craigPacketPath, event.gatewayPacketPath];
        check(packetPaths === undefined || same(packetPaths, paths), "Packet stream changed source");
        packetPaths = paths;
        const craig = archive.bytes(event.craigPacketPath, "craig").subarray(event.offset, event.offset + event.size);
        const gateway = archive.bytes(event.gatewayPacketPath, "gateway").subarray(event.offset, event.offset + event.size);
        // Discord's canonical 20 ms, single-frame mono Opus packet. Ogg containers and PCM are rejected.
        check(craig.length === event.size && craig.equals(gateway) &&
          (craig[0]! & 7) === 0 && opusFrameMs(craig[0]!) === 20,
        "Actual current-source Opus packet mismatch");
        packetOffset += event.size;
        sent = event.seq;
        break;
      }
      case "ack":
        check(!finalized && event.seq === acknowledged + 1 && event.seq <= sent, "Bad audio acknowledgement");
        acknowledged = event.seq;
        break;
      case "partial": case "final":
        check(event.turn.speakerId === session.speakerId && event.turn.endMs > event.turn.startMs &&
          event.turn.endMs <= run.endedAtMs - run.startedAtMs && sent > 0, "Bad live turn");
        if (event.type === "partial") partials++; else finals.push(event.turn);
        break;
      case "finalize":
        check(!finalized && sent > 0 && acknowledged === sent, "Missing/duplicate finalize or unacknowledged audio");
        finalized = true;
        break;
      case "finalize_complete":
        check(finalized && !complete && finals.length > 0, "Bad finalize acknowledgement");
        complete = true;
        break;
      case "closed": check(complete && position === events.length - 1, "Premature/duplicate terminal"); break;
    }
  }
  check(finalized && complete && partials > 0 && finals.length > 0, "Absent live/partial/finalize evidence");
  check(packetPaths && packetPaths.every((path) => archive.bytes(path).length === packetOffset),
    "Incomplete packet archive");
  const first = Math.min(...finals.map((turn) => turn.startMs));
  const last = Math.max(...finals.map((turn) => turn.endMs));
  check(sent * 20 + 3500 >= last - first, "Insufficient actual Opus packet coverage");
  return finals;
}
function opusFrameMs(toc: number): number {
  const config = toc >> 3;
  if (config >= 16) return 2.5 * 2 ** (config & 3);
  if (config >= 12) return 10 * 2 ** (config & 1);
  return [10, 20, 40, 60][config & 3]!;
}
