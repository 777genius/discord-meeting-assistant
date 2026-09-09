import { nativeDeploymentSchema } from "./oss-deployment-collection.js";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { canonical, createReceipt, readRegular, requireEvidence as check, sha256, type Artifact } from "./oss-campaign-artifacts.js";
import { artifactSchema, id, indexSchema, planSchema, runSchema } from "./oss-campaign-profile.js";
import { normalizeOssDatabase } from "./oss-database.js";
import { collectNativeLive, qualifyNativeSessions, collectionFailureDiagnostic, OssCollectionDiagnosticError } from "./oss-native-live-collection.js";
import { collectNativePostCall, qualifyNativePostCall } from "./oss-native-post-call-collection.js";
import { snapshotSchema, publicationSchema, originalSchema } from "./oss-native-campaign-sources.js";

const relativePath = artifactSchema.shape.path;
const assemblySchema = z.object({ kind: z.literal("oss-native-assembly-v1"), deploymentPaths: z.array(relativePath).length(2),
  livePath: relativePath, postCallPath: relativePath,
  runs: z.array(z.object({ runId: id, actorPath: relativePath, snapshots: z.array(relativePath).length(2),
    publications: z.array(relativePath).length(2), originalsPath: relativePath, originalDirectory: relativePath,
  }).strict()).length(3),
}).strict();

/** Assemble retained native inputs. File/byte consistency does not establish
 * origin; this function never grants custody or writes campaign PASS. */
export async function assembleOssNativeArchive(input: {
  planPath: string; sourceRoot: string; assemblyPath: string; outputRoot: string;
  retained?: { planBytes: Buffer; assemblyBytes: Buffer; sources: ReadonlyMap<string, Buffer> };
}) {
  const planBytes = input.retained?.planBytes ?? await readRegular(input.planPath);
  const plan = planSchema.parse(JSON.parse(planBytes.toString("utf8")));
  const assembly = assemblySchema.parse(JSON.parse((input.retained?.assemblyBytes ?? await readRegular(input.assemblyPath)).toString("utf8")));
  check(assembly.runs.map((run) => run.runId).join() === plan.runs.map((run) => run.runId).join(), "Assembly run order mismatch");
  const sourceRoot = await realpath(input.sourceRoot);
  const read = async (path: string, maxBytes = 64 * 1024 * 1024, allowEmpty = false) => {
    relativePath.parse(path);
    if (input.retained) {
      const bytes = input.retained.sources.get(path);
      check(bytes && bytes.length <= maxBytes && (allowEmpty || bytes.length > 0), "Missing collector-owned source bytes");
      return Buffer.from(bytes);
    }
    const full = resolve(sourceRoot, path);
    check(full.startsWith(sourceRoot + sep) && await realpath(full) === full, "Native source escape or symlink");
    return readRegular(full, maxBytes, allowEmpty);
  };
  const liveBytes = await read(assembly.livePath, 256 * 1024 * 1024);
  const postCallBytes = await read(assembly.postCallPath, 1024 * 1024);
  let live: ReturnType<typeof collectNativeLive>;
  try { live = collectNativeLive(liveBytes, plan.target.platformRevision); }
  catch (error) { throw new OssCollectionDiagnosticError("Native live parsing failed", collectionFailureDiagnostic(error, "native-parse")); }
  const sessions = qualifyNativeSessions(live.sessions);
  const postCall = collectNativePostCall(postCallBytes, plan.target.platformRevision);
  const files = new Map<string, Buffer>();
  const artifacts: Artifact[] = [];
  let total = 0;
  const put = (path: string, system: Artifact["source"]["system"], bytes: Buffer,
    locator = path, version = sha256(bytes)) => {
    check(!files.has(path), "Duplicate assembled artifact");
    total += bytes.length; check(total <= 1024 * 1024 * 1024, "Native archive exceeds bound");
    artifacts.push(artifactSchema.parse({ path, size: bytes.length, sha256: sha256(bytes), source: { system, locator, version } }));
    files.set(path, bytes); return path;
  };
  const json = (path: string, system: Artifact["source"]["system"], value: unknown) =>
    put(path, system, Buffer.from(JSON.stringify(value)));
  const livePath = put("native/live.jsonl", "gateway", liveBytes);
  const postCallPath = put("native/post-call.jsonl", "postgres", postCallBytes);
  const deployments = [];
  for (const [index, path] of assembly.deploymentPaths.entries()) {
    const bytes = await read(path);
    deployments.push({ path: put(`native/deployment-${index}.json`, "deployment", bytes),
      value: nativeDeploymentSchema.parse(JSON.parse(bytes.toString("utf8"))) });
  }
  const before = deployments[0]!.value, after = deployments[1]!.value;
  const operatorCaPath = put("native/operator-ca.pem", "deployment", Buffer.from(before.config.operatorCaBase64, "base64"));
  const deploymentPath = json("deployment.json", "deployment", { target: plan.target, targetAfter: plan.target,
    beforeMs: before.startedAtMs, afterMs: after.completedAtMs, operatorCaPath,
    platformImageDigest: before.services[0]!.imageId, craigImageDigest: before.services[1]!.imageId,
    gatewayImageDigest: before.services[2]!.imageId, recordingIdsBefore: before.recordingIds, recordingIdsAfter: after.recordingIds });
  const nativeRuns = [];
  const runs = [];
  for (const [position, source] of assembly.runs.entries()) {
    const prefix = `run-${position}`;
    const snapshots = [], publications = [];
    for (let index = 0; index < 2; index++) {
      const snapshotBytes = await read(source.snapshots[index]!);
      const publicationBytes = await read(source.publications[index]!);
      snapshots.push({ path: put(`${prefix}/snapshot-${index}.json`, "postgres", snapshotBytes),
        value: snapshotSchema.parse(JSON.parse(snapshotBytes.toString("utf8"))) });
      publications.push({ path: put(`${prefix}/publication-${index}.json`, "discord", publicationBytes),
        value: publicationSchema.parse(JSON.parse(publicationBytes.toString("utf8"))) });
    }
    const snapshot = snapshots[0]!.value;
    const db = normalizeOssDatabase(snapshot.database as Parameters<typeof normalizeOssDatabase>[0]).snapshot;
    const publication = publications[0]!.value;
    const originalBytes = await read(source.originalsPath);
    const original = originalSchema.parse(JSON.parse(originalBytes.toString("utf8")));
    const originalsPath = put(`${prefix}/native-originals.json`, "craig", originalBytes);
    const originals: string[] = [];
    for (const file of original.files) {
      const bytes = await read(`${source.originalDirectory}/${file.path}`, 512 * 1024 * 1024, true);
      check(bytes.length === file.size && sha256(bytes) === file.sha256, "Retained Craig original changed");
      originals.push(put(`${prefix}/originals/${file.path}`, "craig", bytes));
    }
    const originalInventoryPath = json(`${prefix}/original-inventory.json`, "craig", {
      recordingId: original.recordingId, craigRevision: original.craigRevision,
      // Final verification independently recomputes from archived bytes against the versioned original proof.
      sourceFilesChecksumSha256: original.declaredSourceFilesChecksumSha256,
      files: originals.map((path) => ({ path, size: files.get(path)!.length, sha256: sha256(files.get(path)!) })),
    });
    const objectPaths = snapshot.objects.map((object, index) => put(`${prefix}/object-${index}`,
      "object-storage", Buffer.from(object.base64, "base64"), object.locator, object.revision));
    const manifestPath = objectPaths[0]!;
    const manifest = z.object({ recordingId: id, startedAt: z.iso.datetime(), endedAt: z.iso.datetime() })
      .parse(JSON.parse(files.get(manifestPath)!.toString("utf8")));
    const completion = z.object({ events: z.array(z.object({ type: id, occurredAt: z.iso.datetime() })) }).parse(snapshot.completion);
    const lifecycle = ["meeting.started", "meeting.ended", "recording.authoritative_ready"].map((type) => {
      const matching = completion.events.filter((event) => event.type === type);
      check(matching.length === 1, "Native lifecycle effect missing/duplicate");
      return { type, atMs: Date.parse(matching[0]!.occurredAt), recordingId: db.recording.recordingId };
    });
    const stages = qualifyNativePostCall(postCall, db.meetingId);
    const nativeSessions = sessions.filter((session) => session.meetingId === db.meetingId);
    const terminalAtMs = Math.max(stages.at(-1)!.completedAtMs, ...nativeSessions.map((session) => session.rows.at(-1)!.atMs));
    const transcript = { transcriptId: db.transcript.transcriptId, turns: db.transcript.turns,
      version: String(db.transcript.version) };
    const attachmentPath = (filename: string) => {
      const matching = publication.attachments.filter((item) => item.filename === filename);
      check(matching.length === 1, "Native attachment absent/duplicated");
      return put(`${prefix}/${filename}`, "discord", Buffer.from(matching[0]!.text));
    };
    const run = runSchema.parse({ kind: "oss-discord-stt-run-v1", campaignId: plan.campaignId,
      runId: source.runId, scenario: plan.runs[position]!.scenario, meetingId: db.meetingId,
      recordingId: db.recording.recordingId, startedAtMs: Date.parse(manifest.startedAt), endedAtMs: Date.parse(manifest.endedAt), terminalAtMs,
      actorPath: put(`${prefix}/actor.json`, "actor", await read(source.actorPath)),
      databasePath: json(`${prefix}/database.json`, "postgres", snapshot.database),
      completionPath: json(`${prefix}/completion.json`, "postgres", snapshot.completion),
      manifestPath, originalInventoryPath, originals, lifecycle, transcript, liveTurns: snapshot.liveTurns, summary: db.summary, stages,
      tracks: db.recording.speakerAudio.map((track, index) => ({ speakerId: track.speakerId,
        timelineOffsetMs: track.timelineOffsetMs, path: objectPaths[index + 1], originalPaths: originals })),
      sessions: nativeSessions.map((session) => ({ sessionId: session.providerSessionId, speakerId: session.speakerId,
        sourceRevision: plan.target.gatewayRevision, wirePath: livePath })),
      publication: { messageId: publication.messageId, channelId: publication.channelId, authorId: publication.authorId,
        createdAtMs: publication.createdAtMs, transcriptAttachmentPath: attachmentPath("meeting-transcript.md"),
        summaryAttachmentPath: attachmentPath("meeting-summary.md") },
      settled: publications.map(({ value }) => ({ observedAtMs: value.observedAtMs, terminalAtMs,
        meetingIds: [db.meetingId], recordingIds: [db.recording.recordingId], transcriptIds: [transcript.transcriptId],
        summaryIds: [db.summary.summaryId], finalMessageIds: value.matchingFinalMessageIds, transcriptSha256: sha256(canonical(transcript)) })),
    });
    runs.push({ runId: source.runId, evidencePath: json(`${prefix}/run.json`, "postgres", run) });
    nativeRuns.push({ runId: source.runId, snapshots: snapshots.map((item) => item.path),
      publications: publications.map((item) => item.path), originalsPath });
  }
  const index = indexSchema.parse({ kind: "oss-discord-stt-collection-v1", planSha256: sha256(planBytes),
    collectorRevision: plan.collectorRevision, capturedAtMs: Date.now(), artifacts, runs, deploymentPath,
    nativeSources: { livePath, postCallPath, deploymentPaths: deployments.map((item) => item.path), runs: nativeRuns } });
  const outputRoot = resolve(input.outputRoot);
  check(!outputRoot.startsWith(sourceRoot + sep) && outputRoot !== sourceRoot, "Archive output must be separate from sources");
  await mkdir(outputRoot); // Create-only: partial or previous archives cannot be overwritten.
  for (const [path, bytes] of files) {
    const full = resolve(outputRoot, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes, { flag: "wx", mode: 0o600 });
  }
  await createReceipt(resolve(outputRoot, "collection.json"), index); // Published last; never a pass receipt.
  return { kind: index.kind, status: "assembled" as const, artifactCount: artifacts.length,
    collectionSha256: sha256(`${JSON.stringify(index, null, 2)}\n`) };
}
