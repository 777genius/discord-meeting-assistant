import { verifyCraigOriginalBytes } from "./oss-craig-original-collection.js";
import { nativeDeploymentSchema } from "./oss-deployment-collection.js";
import { z } from "zod";
import { collectNativeLive, qualifyNativeSession } from "./oss-native-live-collection.js";
import { collectNativePostCall, qualifyNativePostCall } from "./oss-native-post-call-collection.js";
import { sha256, same, canonical, requireEvidence as check, type Archive } from "./oss-campaign-artifacts.js";
import { digest, id, revision, time, turnSchema, type OssRun } from "./oss-campaign-profile.js";

export const snapshotSchema = z.object({ kind: z.literal("oss-native-readonly-snapshot-v1"),
  project: z.literal("vtoss-test-oss-8f49a06-r1"), platformRevision: revision,
  platformImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/u), startedAtMs: time, completedAtMs: time,
  observedAtMs: time, recordingIds: z.array(id).max(3), database: z.unknown(), liveTurns: z.array(turnSchema),
  completion: z.unknown(), objects: z.array(z.object({ locator: id, revision: id, sizeBytes: time,
    checksumSha256: digest, base64: z.string() }).strict()).length(3),
}).strict();
export const publicationSchema = z.object({ kind: z.literal("oss-native-publication-v1"), meetingId: id,
  observedAtMs: time, messageId: id, channelId: id, authorId: id, createdAtMs: time,
  editedAt: z.string().nullable(), matchingFinalMessageIds: z.array(id),
  attachments: z.array(z.object({ id, filename: id, sizeBytes: time, sha256: digest, text: z.string() }).strict()).length(2),
}).strict();
export const originalSchema = z.object({ kind: z.literal("oss-native-craig-originals-v1"), recordingId: id,
  craigRevision: revision, manifestSha256: digest, files: z.array(z.object({ path: id, size: time, sha256: digest }).strict()),
  declaredSourceFilesChecksumSha256: digest,
  aggregateRecomputation: z.union([z.object({ status: z.literal("source-unavailable"), requiredSourceRoot: id,
    requiredRevision: revision, requiredCapability: id }).strict(),
    z.object({ status: z.literal("recomputed"), checksumSha256: digest, jobBase64: z.string().max(24 * 1024 * 1024) }).strict()]),
}).strict();

/** Binds every normalized field to the complete discovered native capture. No
 * caller pass flag or signature can substitute for these source comparisons. */
export function verifyNativeCampaignSources(archive: Archive, runs: readonly OssRun[]) {
  const sources = archive.index.nativeSources;
  check(sources, "Native source index missing");
  const live = collectNativeLive(archive.bytes(sources.livePath, "gateway"), archive.plan.target.platformRevision);
  const postCall = collectNativePostCall(archive.bytes(sources.postCallPath, "postgres"), archive.plan.target.platformRevision);
  check(live.start.atMs <= runs[0]!.startedAtMs && postCall.start.atMs <= runs[0]!.startedAtMs &&
    live.end.atMs <= archive.index.capturedAtMs && postCall.seal.atMs <= archive.index.capturedAtMs,
    "Native capture does not bracket campaign");
  check(same(sources.runs.map((run) => run.runId), runs.map((run) => run.runId)), "Native run index mismatch");
  const sessions = [...live.sessions.entries()].map(([captureSessionId, rows]) => ({
    captureSessionId, ...qualifyNativeSession(rows),
  }));
  check(sessions.every((session) => runs.some((run) => run.meetingId === session.meetingId)) &&
    postCall.events.every((event) => runs.some((run) => run.meetingId === event.meetingId)), "Extra native meeting/session");
  check(sessions.length === runs.reduce((count, run) => count + run.sessions.length, 0), "Native session omission");
  const [before, after] = sources.deploymentPaths.map((path) => nativeDeploymentSchema.parse(archive.json(path, "deployment")));
  check(before && after && before.phase === "before" && after.phase === "after" && before.recordingIds.length === 0 &&
    same([...after.recordingIds].sort(), runs.map((run) => run.recordingId).sort()) &&
    before.completedAtMs <= runs[0]!.startedAtMs && after.startedAtMs >= runs.at(-1)!.settled[1]!.observedAtMs &&
    after.completedAtMs <= archive.index.capturedAtMs && same(before.services, after.services) && same(before.config, after.config),
    "Native deployment changed or did not bracket campaign");
  const expectedServices = [[archive.plan.target.platformService, archive.plan.target.platformRevision],
    [archive.plan.target.craigService, archive.plan.target.craigRevision], ["voicetext-gateway", archive.plan.target.gatewayRevision]];
  check(before.services.every((service, index) => service.service === expectedServices[index]![0] &&
    service.sourceRevision === expectedServices[index]![1]) && before.config.gatewayEndpointSha256 === sha256(archive.plan.target.gatewayEndpoint) &&
    before.config.operatorCaSha256 === archive.plan.target.operatorCaSha256 &&
    sha256(Buffer.from(before.config.operatorCaBase64, "base64")) === before.config.operatorCaSha256 &&
    before.config.guildId === archive.plan.target.guildId && before.config.voiceChannelId === archive.plan.target.voiceChannelId &&
    before.config.resultsChannelId === archive.plan.target.resultsChannelId && before.config.applicationId === archive.plan.target.publicationApplicationId,
    "Native deployment target/source mismatch");
  const declaredDeployment = archive.json(archive.index.deploymentPath) as Record<string, unknown>;
  check(declaredDeployment.beforeMs === before.startedAtMs && declaredDeployment.afterMs === after.completedAtMs &&
    declaredDeployment.platformImageDigest === before.services[0]!.imageId && declaredDeployment.craigImageDigest === before.services[1]!.imageId &&
    declaredDeployment.gatewayImageDigest === before.services[2]!.imageId, "Native deployment normalization mismatch");
  const missing = new Set<string>();
  for (const [position, run] of runs.entries()) {
    const source = sources.runs[position]!;
    const nativeSessions = sessions.filter((session) => session.meetingId === run.meetingId);
    check(same(nativeSessions.map((session) => session.providerSessionId).sort(),
      run.sessions.map((session) => session.sessionId).sort()), "Native session identity mismatch");
    const emitted = nativeSessions.flatMap((session) => {
      check(session.rows.every((row) => row.atMs >= run.startedAtMs && row.atMs <= run.terminalAtMs),
        "Native session outside recording timeline");
      const audio = session.rows.filter((row) => row.event.type === "audio_send");
      const emittedFinals = session.rows.flatMap(({ event }) => event.type === "transcript_emitted" && event.isFinal ? [event] : []);
      check(emittedFinals.length > 0 && emittedFinals.every((turn) => turn.endMs <= run.endedAtMs - run.startedAtMs) &&
        audio.length * 20 + 3500 >= Math.max(...emittedFinals.map((turn) => turn.endMs)) - Math.min(...emittedFinals.map((turn) => turn.startMs)),
        "Insufficient native Opus coverage");
      check(audio.every((row) => row.event.type === "audio_send" && row.atMs >= run.startedAtMs + row.event.relativeTimeMs - 3500),
        "Native audio source timestamp mismatch");
      const listed = run.sessions.find((entry) => entry.sessionId === session.providerSessionId)!;
      check(listed.speakerId === session.speakerId && listed.wirePath === sources.livePath,
        "Native speaker/journal binding mismatch");
      return session.rows.flatMap(({ event }) => {
        if (event.type !== "transcript_emitted" || !event.isFinal) return [];
        const turnId = `live-turn:v1:${sha256([run.meetingId, session.speakerId, event.startMs, event.endMs, event.text].join("\0")).slice(0, 24)}`;
        return [{ turnId, speakerId: session.speakerId, startMs: event.startMs, endMs: event.endMs, text: event.text }];
      });
    });
    const uniqueEmitted = [...new Map(emitted.map((turn) => [turn.turnId, turn])).values()];
    check(same(uniqueEmitted.sort((a, b) => a.turnId.localeCompare(b.turnId)),
      [...run.liveTurns].sort((a, b) => a.turnId.localeCompare(b.turnId))), "Native emitted/live ledger mismatch");
    check(same(qualifyNativePostCall(postCall, run.meetingId), run.stages), "Native post-call timestamp mismatch");
    let previousObservation = run.terminalAtMs;
    let firstSnapshot: ReturnType<typeof snapshotSchema.parse> | undefined;
    let firstPublication: ReturnType<typeof publicationSchema.parse> | undefined;
    for (let observation = 0; observation < 2; observation++) {
      const snapshot = snapshotSchema.parse(archive.json(source.snapshots[observation]!, "postgres"));
      const publication = publicationSchema.parse(archive.json(source.publications[observation]!, "discord"));
      check(snapshot.platformRevision === archive.plan.target.platformRevision && snapshot.platformImageId === before.services[0]!.imageId &&
        snapshot.startedAtMs >= previousObservation && snapshot.completedAtMs >= snapshot.startedAtMs &&
        publication.observedAtMs >= snapshot.completedAtMs && publication.observedAtMs <= archive.index.capturedAtMs,
        "Native settlement observation ordering mismatch");
      previousObservation = publication.observedAtMs;
      check(same(snapshot.database, archive.json(run.databasePath)) && same(snapshot.liveTurns, run.liveTurns) &&
        same(snapshot.completion, archive.json(run.completionPath)), "Native database/completion source mismatch");
      check(snapshot.recordingIds.includes(run.recordingId) && new Set(snapshot.recordingIds).size === position + 1,
        "Native whole-project recording inventory mismatch");
      check(same([...snapshot.recordingIds].sort(), runs.slice(0, position + 1).map((item) => item.recordingId).sort()),
        "Unexpected native recording effect");
      for (const object of snapshot.objects) {
        const artifact = archive.index.artifacts.find((item) => item.source.system === "object-storage" &&
          item.source.locator === object.locator && item.source.version === object.revision);
        check(artifact && artifact.sha256 === object.checksumSha256 && artifact.size === object.sizeBytes &&
          archive.bytes(artifact.path).equals(Buffer.from(object.base64, "base64")), "Native immutable object source mismatch");
      }
      check(publication.meetingId === run.meetingId && publication.messageId === run.publication.messageId &&
        publication.channelId === archive.plan.target.resultsChannelId && publication.authorId === archive.plan.target.publicationApplicationId &&
        publication.createdAtMs === run.publication.createdAtMs && same(publication.matchingFinalMessageIds, [run.publication.messageId]),
        "Native publication identity mismatch");
      for (const [filename, path] of [["meeting-summary.md", run.publication.summaryAttachmentPath],
        ["meeting-transcript.md", run.publication.transcriptAttachmentPath]]) {
        const attachments = publication.attachments.filter((item) => item.filename === filename);
        check(attachments.length === 1 && archive.bytes(path!, "discord").toString("utf8") === attachments[0]!.text,
          "Native publication attachment source mismatch");
      }
      const settled = run.settled[observation]!;
      check(settled.observedAtMs === publication.observedAtMs && settled.transcriptSha256 === sha256(canonical(run.transcript)),
        "Native settled timestamp mismatch");
      if (firstSnapshot && firstPublication) check(same(firstSnapshot.database, snapshot.database) &&
        same(firstPublication.attachments, publication.attachments) && firstPublication.editedAt === publication.editedAt,
        "Native settlement changed between reads");
      firstSnapshot = snapshot; firstPublication = publication;
    }
    const originals = originalSchema.parse(archive.json(source.originalsPath, "craig"));
    check(originals.recordingId === run.recordingId && originals.craigRevision === archive.plan.target.craigRevision &&
      originals.manifestSha256 === archive.artifact(run.manifestPath).sha256, "Native original manifest binding mismatch");
    const inventory = archive.json(run.originalInventoryPath) as { files: Array<{ path: string; size: number; sha256: string }> };
    check(originals.files.length === inventory.files.length && originals.files.every((file) =>
      inventory.files.some((item) => item.path.endsWith("/" + file.path) && item.size === file.size && item.sha256 === file.sha256)),
      "Native original file inventory mismatch");
    const proof = originals.aggregateRecomputation;
    if (proof.status === "source-unavailable") {
      missing.add("Prepared Craig job and recomputed aggregate evidence missing");
    } else {
      const jobBytes = Buffer.from(proof.jobBase64, "base64");
      check(jobBytes.toString("base64") === proof.jobBase64, "Invalid Craig job encoding");
      const result = verifyCraigOriginalBytes({ craigRevision: originals.craigRevision,
        manifestBytes: archive.bytes(run.manifestPath, "object-storage"),
        job: JSON.parse(jobBytes.toString("utf8")), files: originals.files.map(file => {
          const matches = inventory.files.filter(item => item.path.endsWith("/" + file.path));
          check(matches.length === 1, "Ambiguous Craig original mapping");
          return { path: file.path, bytes: archive.bytes(matches[0]!.path, "craig") };
        }) });
      check(result.checksumSha256 === proof.checksumSha256 &&
        result.checksumSha256 === originals.declaredSourceFilesChecksumSha256, "Craig collected aggregate mismatch");
    }
  }
  return { missingSourceCapabilities: [...missing], sessions: sessions.length };
}
