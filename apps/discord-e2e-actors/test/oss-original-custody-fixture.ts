import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { campaignFixture } from "./oss-campaign-fixture.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";
import { collectCraigOriginals } from "../src/oss-craig-original-collection.js";
import { collectNativeLive } from "../src/oss-native-live-collection.js";

// Synthetic offline native boundaries; original proof, assembly and verification stay real.
export async function originalCustodyFixture(root: string) {
    const f = await campaignFixture(root);
    for (const run of f.runs) {
      const database = f.files.get(run.databasePath)!.value as { snapshot: { transcript: object } };
      Object.assign(database.snapshot.transcript, { version: 1, recordingId: run.recordingId });
    }
    f.plan.target.craigRevision = "37b86a958b567cb7fcff75946e94fe5e7ee38f42";
    f.deployment.targetAfter.craigRevision = f.plan.target.craigRevision;
    await f.save();
    const write = async (path: string, value: unknown) => {
      await writeFile(join(root, path), Buffer.isBuffer(value) ? value : JSON.stringify(value)); return path;
    };
    const liveRows: Array<Record<string, unknown>> = [];
    const stageRows: Array<Record<string, unknown>> = [];
    const sources = [];
    let attempt = 0;
    for (const [position, run] of f.runs.entries()) {
      const liveTurns = run.liveTurns.map((turn) => ({
        ...turn,
        turnId: `live-turn:v1:${sha256([run.meetingId, turn.speakerId, turn.startMs, turn.endMs, turn.text].join("\0")).slice(0, 24)}`
      }));
      for (const [speaker, turn] of liveTurns.entries()) {
        const session = `00000000-0000-4000-8000-${String(position * 2 + speaker + 1).padStart(12, "0")}`;
        const event = (value: object, atMs = run.startedAtMs) => liveRows.push({ atMs, session, event: value });
        event({ type: "opening", meetingId: run.meetingId, speakerId: turn.speakerId, clientSessionId: session });
        event({ type: "received", message: { type: "ready", sessionId: session, provider: "deepgram", model: "nova-3" } });
        for (let packet = 0; packet < Math.ceil((turn.endMs - turn.startMs) / 20); packet++) {
          const seq = packet + 1, relativeTimeMs = turn.startMs + packet * 20, atMs = run.startedAtMs + relativeTimeMs;
          event({
            type: "audio_send", seq, packetId: `packet-${session}-${seq}`, sha256: sha256(Buffer.from([248, 255, 254])),
            size: 3, toc: 248, relativeTimeMs, durationSamples48Khz: 960
          }, atMs);
          event({ type: "audio_sent", seq }, atMs);
          event({ type: "received", message: { type: "ack", seq } }, atMs);
          event({ type: "audio_accepted", seq }, atMs);
        }
        event({ type: "received", message: { type: "partial", segment: { startMs: 0, durationMs: turn.endMs - turn.startMs, text: turn.text } } }, run.endedAtMs);
        // Provider time starts at zero for each speaker/session; the adapter
        // maps both partials and finals onto the reserved source packet timeline.
        event({ type: "transcript_emitted", startMs: turn.startMs, endMs: turn.endMs, text: turn.text, isFinal: false }, run.endedAtMs);
        event({ type: "received", message: { type: "final", startMs: 0, durationMs: turn.endMs - turn.startMs, text: turn.text } }, run.endedAtMs);
        event({ type: "transcript_emitted", startMs: turn.startMs, endMs: turn.endMs, text: turn.text, isFinal: true }, run.endedAtMs);
        event({ type: "finalize_send" }, run.endedAtMs);
        event({ type: "finalize_sent" }, run.endedAtMs);
        event({ type: "received", message: { type: "finalize_complete", status: "flushed", sawResult: true } }, run.endedAtMs);
        event({ type: "close", code: 1000 }, run.endedAtMs);
        event({ type: "success" }, run.endedAtMs);
      }
      for (const stage of run.stages) {
        attempt++;
        stageRows.push({ atMs: stage.startedAtMs, type: "started", stage: stage.stage, meetingId: run.meetingId, attempt },
          { atMs: stage.completedAtMs, type: "succeeded", stage: stage.stage, meetingId: run.meetingId, attempt });
      }
      const originalDirectory = `originals-${position}`;
      await mkdir(join(root, originalDirectory));
      const sourceFiles = [];
      for (const kind of ["data", "header1", "header2", "users", "info", "log"]) {
        const bytes = Buffer.from(kind === "log" ? "" : `synthetic-${position}-${kind}`);
        const relativePath = `${run.recordingId}.ogg.${kind}`;
        await write(`${originalDirectory}/${relativePath}`, bytes);
        sourceFiles.push({ kind, relativePath, checksumSha256: sha256(bytes), sizeBytes: bytes.length });
      }
      const aggregate = sha256(JSON.stringify(sourceFiles));
      {
        const manifest = f.files.get(run.manifestPath)!.value as { source: { checksumSha256: string } };
        manifest.source.checksumSha256 = aggregate;
        const actors = run.tracks.map(track => ({ actorId: track.speakerId, kind: "human" }));
        const identityProvenance = { actorObservationState: "consistent", actorSemanticsVersion: 1,
          producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
          producerRevision: f.plan.target.craigRevision, rosterState: "sealed" };
        Object.assign(manifest, { schemaVersion: 3, actors, identityProvenance });
        Object.assign(f.files.get(run.completionPath)!.value!, { lifecycleSchemaVersion: 3, actors, identityProvenance });
        const bytes = Buffer.from(JSON.stringify(manifest));
        const completion = f.files.get(run.completionPath)!.value as { recording: { manifestChecksumSha256: string; manifestSizeBytes: number } };
        const db = f.files.get(run.databasePath)!.value as { snapshot: { recording: typeof completion.recording } };
        for (const recording of [completion.recording, db.snapshot.recording]) {
          recording.manifestChecksumSha256 = sha256(bytes); recording.manifestSizeBytes = bytes.length;
        }
      }
      const snapshots = [], publications = [];
      for (let observation = 0; observation < 2; observation++) {
        snapshots.push(await write(`native-snapshot-${position}-${observation}.json`, {
          kind: "oss-native-readonly-snapshot-v1", project: f.plan.target.project, platformRevision: f.plan.target.platformRevision,
          platformImageId: f.deployment.platformImageDigest, startedAtMs: run.endedAtMs + 100 + observation * 100,
          completedAtMs: run.endedAtMs + 150 + observation * 100, observedAtMs: run.endedAtMs + 110 + observation * 100,
          recordingIds: f.runs.slice(0, position + 1).map((item) => item.recordingId),
          database: f.files.get(run.databasePath)!.value, completion: f.files.get(run.completionPath)!.value, liveTurns,
          objects: [run.manifestPath, ...run.tracks.map((track) => track.path)].map((path) => {
            const value = f.files.get(path)!.value;
            const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
            return { locator: path, revision: "offline-version-1", checksumSha256: sha256(bytes), sizeBytes: bytes.length, base64: bytes.toString("base64") };
          }),
        }));
        publications.push(await write(`native-publication-${position}-${observation}.json`, {
          kind: "oss-native-publication-v1", meetingId: run.meetingId, observedAtMs: run.endedAtMs + 200 + observation * 100,
          messageId: run.publication.messageId, channelId: run.publication.channelId, authorId: run.publication.authorId,
          createdAtMs: run.publication.createdAtMs, editedAt: null, matchingFinalMessageIds: [run.publication.messageId],
          attachments: [["meeting-summary.md", run.publication.summaryAttachmentPath], ["meeting-transcript.md", run.publication.transcriptAttachmentPath]].map(([filename, path]) => {
            const bytes = f.files.get(path!)!.value as Buffer;
            return { id: filename, filename, sizeBytes: bytes.length, sha256: sha256(bytes), text: bytes.toString() };
          }),
        }));
      }
      const manifestBytes = Buffer.from(JSON.stringify(f.files.get(run.manifestPath)!.value));
      const originalsPath = await write(`native-originals-${position}.json`, await collectCraigOriginals({
        originalDirectory: join(root, originalDirectory), manifestBytes, craigRevision: f.plan.target.craigRevision,

      }));
      sources.push({ runId: run.runId, actorPath: run.actorPath, snapshots, publications, originalsPath, originalDirectory });
    }
    const journal = (kind: string, rows: Array<Record<string, unknown>>, extra = {}) => {
      const all = [{ atMs: 0, type: "capture_start", kind, revision: f.plan.target.platformRevision, ...extra },
      ...rows.toSorted((a, b) => Number(a.atMs) - Number(b.atMs))];
      const prefix = all.map((row, index) => JSON.stringify({ index: index + 1, ...row }) + "\n").join("");
      return Buffer.from(prefix + JSON.stringify({ index: all.length + 1, atMs: 1000000, type: "capture_seal", priorSha256: sha256(prefix) }) + "\n");
    };
    const liveJournal = journal("oss-native-live-v1", liveRows, { project: f.plan.target.project });
    const nativeSessions = collectNativeLive(liveJournal, f.plan.target.platformRevision).sessions;
    expect(nativeSessions.size).toBe(6);

    await write("live.jsonl", liveJournal);
    await write("post-call.jsonl", journal("oss-native-post-call-v1", stageRows));
    const services = [[f.plan.target.platformService, f.plan.target.platformRevision, f.deployment.platformImageDigest],
    [f.plan.target.craigService, f.plan.target.craigRevision, f.deployment.craigImageDigest],
    ["voicetext-gateway", f.plan.target.gatewayRevision, f.deployment.gatewayImageDigest]].map(([service, sourceRevision, imageId], index) =>
      ({ service, sourceRevision, imageId, containerId: String(index + 1).repeat(12) }));
    const config = {
      gatewayEndpointSha256: sha256(f.plan.target.gatewayEndpoint), operatorCaSha256: f.plan.target.operatorCaSha256,
      operatorCaBase64: Buffer.from("offline-public-ca").toString("base64"), guildId: f.plan.target.guildId,
      voiceChannelId: f.plan.target.voiceChannelId, resultsChannelId: f.plan.target.resultsChannelId,
      applicationId: f.plan.target.publicationApplicationId, summaryProvider: "transcript-outline", conversationEnabled: "false", liveEnabled: "true"
    };
    await write("deployment-before.json", {
      kind: "oss-native-deployment-v1", phase: "before", project: f.plan.target.project,
      startedAtMs: 0, completedAtMs: 1, recordingIds: [], services, config
    });
    await write("deployment-after.json", {
      kind: "oss-native-deployment-v1", phase: "after", project: f.plan.target.project,
      startedAtMs: 999999, completedAtMs: 1000000, recordingIds: f.runs.map((run) => run.recordingId), services, config
    });
    const assembly = {
      kind: "oss-native-assembly-v1", deploymentPaths: ["deployment-before.json", "deployment-after.json"],
      livePath: "live.jsonl", postCallPath: "post-call.jsonl", runs: sources
    };
    await write("assembly.json", assembly);

    return { ...f, assembly, sources, read: async (path: string) => JSON.parse(await readFile(join(root, path), "utf8")) as unknown };
}
