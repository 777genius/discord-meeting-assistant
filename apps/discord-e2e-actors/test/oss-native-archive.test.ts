import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { campaignFixture } from "./oss-campaign-fixture.js";
import { assembleOssNativeArchive } from "../src/oss-native-archive-assembly.js";
import { loadArchive, sha256 } from "../src/oss-campaign-artifacts.js";
import { verifyOssCampaign } from "../src/oss-campaign-verification.js";
import { runOssCampaignCommand } from "../src/oss-campaign-main.js";
import { collectCraigOriginals, requiredCraigSourceRoot } from "../src/oss-craig-original-collection.js";
import { collectNativeLive, qualifyNativeSession } from "../src/oss-native-live-collection.js";

// Deliberately synthetic source consistency fixture. Actual capture-to-parser
// regressions are in Meeting Platform. Passing synthetic validation is not live E2E evidence.
it.each([false, true])("assembles synthetic native sources with checksum proof=%s", async (withProof) => {
  const root = await mkdtemp(join(tmpdir(), "oss-native-archive-test-"));
  const output = `${root}-archive`;
  const versionOutput = `${root}-version-archive`;
  try {
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
      const liveTurns = run.liveTurns.map((turn) => ({ ...turn,
        turnId: `live-turn:v1:${sha256([run.meetingId, turn.speakerId, turn.startMs, turn.endMs, turn.text].join("\0")).slice(0, 24)}` }));
      for (const [speaker, turn] of liveTurns.entries()) {
        const session = `00000000-0000-4000-8000-${String(position * 2 + speaker + 1).padStart(12, "0")}`;
        const event = (value: object, atMs = run.startedAtMs) => liveRows.push({ atMs, session, event: value });
        event({ type: "opening", meetingId: run.meetingId, speakerId: turn.speakerId, clientSessionId: session });
        event({ type: "received", message: { type: "ready", sessionId: session, provider: "deepgram", model: "nova-3" } });
        for (let packet = 0; packet < Math.ceil((turn.endMs - turn.startMs) / 20); packet++) {
          const seq = packet + 1, relativeTimeMs = turn.startMs + packet * 20, atMs = run.startedAtMs + relativeTimeMs;
          event({ type: "audio_send", seq, packetId: `packet-${session}-${seq}`, sha256: sha256(Buffer.from([248,255,254])),
            size: 3, toc: 248, relativeTimeMs, durationSamples48Khz: 960 }, atMs);
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
      const job = { recordingId: run.recordingId, sourceFiles, lifecycleV3Snapshot: { sealedReady: {
        type: "recording.authoritative_ready", recordingId: run.recordingId, sourceFilesChecksumSha256: aggregate } } };
      if (withProof) {
        const manifest = f.files.get(run.manifestPath)!.value as { source: { checksumSha256: string } };
        manifest.source.checksumSha256 = aggregate;
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
          attachments: [["meeting-summary.md", run.publication.summaryAttachmentPath], ["meeting-transcript.md", run.publication.transcriptAttachmentPath]].map(([filename,path]) => {
            const bytes = f.files.get(path!)!.value as Buffer;
            return { id: filename, filename, sizeBytes: bytes.length, sha256: sha256(bytes), text: bytes.toString() };
          }),
        }));
      }
      const original = f.files.get(run.originals[0]!)!.value as Buffer;
      if (!withProof) {
        for (const file of sourceFiles) await rm(join(root, originalDirectory, file.relativePath));
        await write(`${originalDirectory}/recording.ogg`, original);
      }
      const manifestBytes = Buffer.from(JSON.stringify(f.files.get(run.manifestPath)!.value));
      const originalsPath = await write(`native-originals-${position}.json`, withProof ? await collectCraigOriginals({
        originalDirectory: join(root, originalDirectory), manifestBytes, craigRevision: f.plan.target.craigRevision,
        jobBytes: Buffer.from(JSON.stringify(job)),
      }) : {
        kind: "oss-native-craig-originals-v1", recordingId: run.recordingId, craigRevision: f.plan.target.craigRevision,
        manifestSha256: sha256(manifestBytes), declaredSourceFilesChecksumSha256: sha256(`offline-source-${position}`),
        files: [{ path: "recording.ogg", size: original.length, sha256: sha256(original) }],
        aggregateRecomputation: { status: "source-unavailable", requiredSourceRoot: requiredCraigSourceRoot,
          requiredRevision: f.plan.target.craigRevision, requiredCapability: "original-source checksum implementation used by authoritative_ready" },
      });
      sources.push({ runId: run.runId, actorPath: run.actorPath, snapshots, publications, originalsPath, originalDirectory });
    }
    const journal = (kind: string, rows: Array<Record<string, unknown>>, extra = {}) => {
      const all = [{ atMs: 0, type: "capture_start", kind, revision: f.plan.target.platformRevision, ...extra },
        ...rows.sort((a,b) => Number(a.atMs) - Number(b.atMs))];
      const prefix = all.map((row,index) => JSON.stringify({ index: index + 1, ...row }) + "\n").join("");
      return Buffer.from(prefix + JSON.stringify({ index: all.length + 1, atMs: 1000000, type: "capture_seal", priorSha256: sha256(prefix) }) + "\n");
    };
    const liveJournal = journal("oss-native-live-v1", liveRows, { project: f.plan.target.project });
    const nativeSessions = collectNativeLive(liveJournal, f.plan.target.platformRevision).sessions;
    expect(nativeSessions.size).toBe(6);
    for (const rows of nativeSessions.values()) {
      expect(() => qualifyNativeSession(rows)).not.toThrow();
      // These mutations preserve the successful terminal and packet ACKs. They
      // must still fail the real provider-to-source mapping for every scenario.
      const missingPartial = rows.filter(({ event }) => event.type !== "transcript_emitted" || event.isFinal);
      expect(() => qualifyNativeSession(missingPartial)).toThrow("Native provider/emitted timeline mismatch");
      const unshifted = structuredClone(rows);
      for (const { event } of unshifted) if (event.type === "transcript_emitted") {
        event.endMs -= event.startMs;
        event.startMs = 0;
      }
      expect(() => qualifyNativeSession(unshifted)).toThrow("Native provider/emitted timeline mismatch");
      const overrun = structuredClone(rows);
      for (const { event } of overrun) if (event.type === "received" && event.message.type === "partial" && event.message.segment) {
        event.message.segment.durationMs += 20;
      }
      expect(() => qualifyNativeSession(overrun)).toThrow("Native provider segment exceeds accepted audio");
    }
    await write("live.jsonl", liveJournal);
    await write("post-call.jsonl", journal("oss-native-post-call-v1", stageRows));
    const services = [[f.plan.target.platformService, f.plan.target.platformRevision, f.deployment.platformImageDigest],
      [f.plan.target.craigService, f.plan.target.craigRevision, f.deployment.craigImageDigest],
      ["voicetext-gateway", f.plan.target.gatewayRevision, f.deployment.gatewayImageDigest]].map(([service, sourceRevision, imageId], index) =>
      ({ service, sourceRevision, imageId, containerId: String(index + 1).repeat(12) }));
    const config = { gatewayEndpointSha256: sha256(f.plan.target.gatewayEndpoint), operatorCaSha256: f.plan.target.operatorCaSha256,
      operatorCaBase64: Buffer.from("offline-public-ca").toString("base64"), guildId: f.plan.target.guildId,
      voiceChannelId: f.plan.target.voiceChannelId, resultsChannelId: f.plan.target.resultsChannelId,
      applicationId: f.plan.target.publicationApplicationId, summaryProvider: "transcript-outline", conversationEnabled: "false", liveEnabled: "true" };
    await write("deployment-before.json", { kind: "oss-native-deployment-v1", phase: "before", project: f.plan.target.project,
      startedAtMs: 0, completedAtMs: 1, recordingIds: [], services, config });
    await write("deployment-after.json", { kind: "oss-native-deployment-v1", phase: "after", project: f.plan.target.project,
      startedAtMs: 999999, completedAtMs: 1000000, recordingIds: f.runs.map((run) => run.recordingId), services, config });
    await write("assembly.json", { kind: "oss-native-assembly-v1", deploymentPaths: ["deployment-before.json", "deployment-after.json"],
      livePath: "live.jsonl", postCallPath: "post-call.jsonl", runs: sources });
    const input = { planPath: f.planPath, sourceRoot: root, assemblyPath: join(root,"assembly.json"), outputRoot: output };
    expect(await assembleOssNativeArchive(input)).toMatchObject({ status: "assembled" });
    const archive = await loadArchive(f.planPath, output);
    const report = await verifyOssCampaign(archive, f.manifestBytes);
    expect(report.status).toBe("sources-unverified");
    expect(report.consistency).toBe(withProof ? "complete" : "incomplete");
    if (withProof) expect(report.missingSourceCapabilities).toEqual([]);
    else expect(report.missingSourceCapabilities.join()).toContain("Prepared Craig job");
    const firstRunPath = archive.index.runs[0]!.evidencePath;
    for (const mutation of ["stage", "session", "ledger"] as const) {
      const altered = { ...archive, json: (path: string, system?: Parameters<typeof archive.json>[1]) => {
        const value = archive.json(path, system);
        if (path === firstRunPath) {
          const run = value as typeof f.runs[number];
          if (mutation === "stage") run.stages[0]!.startedAtMs++;
          if (mutation === "session") run.sessions.pop();
          if (mutation === "ledger") run.liveTurns[0]!.text += " forged";
        }
        return value;
      } };
      await expect(verifyOssCampaign(altered, f.manifestBytes)).rejects.toThrow();
    }
    await expect(assembleOssNativeArchive(input)).rejects.toThrow();
    const qualify = () => runOssCampaignCommand(["qualify", f.planPath, output,
      new URL("./fixtures/manifest.v1.json", import.meta.url).pathname, join(root,"pass.json")]);
    if (withProof) {
      await expect(qualify()).rejects.toThrow("PASS unavailable");
      await expect(readFile(join(root,"pass.json"))).rejects.toThrow();
      await runOssCampaignCommand(["check", f.planPath, output,
        new URL("./fixtures/manifest.v1.json", import.meta.url).pathname, join(root,"report.json")]);
      await runOssCampaignCommand(["verify", f.planPath, output,
        new URL("./fixtures/manifest.v1.json", import.meta.url).pathname, join(root,"report.json")]);
      const originalPath = archive.index.nativeSources!.runs[0]!.originalsPath;
      const altered = { ...archive, json: (path: string, system?: Parameters<typeof archive.json>[1]) => {
        const value = archive.json(path, system);
        if (path === originalPath) (value as { aggregateRecomputation: { checksumSha256: string } }).aggregateRecomputation.checksumSha256 = "f".repeat(64);
        return value;
      } };
      await expect(verifyOssCampaign(altered, f.manifestBytes)).rejects.toThrow("aggregate mismatch");
      const tampered = { ...archive, bytes: (path: string, system?: Parameters<typeof archive.bytes>[1]) => {
        const bytes = archive.bytes(path, system);
        return path.endsWith(".ogg.data") ? Buffer.alloc(bytes.length, 1) : bytes;
      } };
      await expect(verifyOssCampaign(tampered, f.manifestBytes)).rejects.toThrow("changed after preparation");
    } else {
      await expect(qualify()).rejects.toThrow("PASS unavailable");
      await expect(readFile(join(root,"pass.json"))).rejects.toThrow();
    }
    if (withProof) {
      for (const source of sources) for (const path of source.snapshots) {
        const native = JSON.parse(await readFile(join(root, path), "utf8"));
        native.database.snapshot.revision = 97;
        await writeFile(join(root, path), JSON.stringify(native));
      }
      await assembleOssNativeArchive({ ...input, outputRoot: versionOutput });
      const assembled = await loadArchive(f.planPath, versionOutput);
      const run = assembled.json(assembled.index.runs[0]!.evidencePath) as { transcript: { version: string }; databasePath: string };
      expect(run.transcript.version).toBe("1");
      expect(assembled.json(run.databasePath)).toMatchObject({ snapshot: { revision: 97,
        transcript: { version: 1, recordingId: f.runs[0]!.recordingId } } });
      expect(await verifyOssCampaign(assembled, f.manifestBytes)).toMatchObject({
        status: "sources-unverified", consistency: "complete", missingSourceCapabilities: [],
      });
    }
    await writeFile(join(output,"native/live.jsonl"), Buffer.from("truncated"));
    await expect(loadArchive(f.planPath, output)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); await rm(output, { recursive: true, force: true });
    await rm(versionOutput, { recursive: true, force: true }); }
}, 60000);
