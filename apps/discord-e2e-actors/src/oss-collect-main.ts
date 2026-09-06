import { collectOssDeployment } from "./oss-deployment-collection.js";
import { assembleOssNativeArchive } from "./oss-native-archive-assembly.js";
import { collectCraigOriginals } from "./oss-craig-original-collection.js";
import { z } from "zod";
import { normalizeDatabase } from "./e2e-retained-evidence-snapshot.js";
import { collectOssPublicationFromDiscord } from "./oss-publication-collection.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReceipt, readRegular, requireEvidence } from "./oss-campaign-artifacts.js";
import { planSchema } from "./oss-campaign-profile.js";
import { collectOssReadonlySnapshot, type OssReadCommand } from "./oss-readonly-collection.js";

/** Explicit effect boundary: unlike collect:e2e this only obtains read-only native
 * evidence. It never invokes actors, providers, BullMQ, or process/replay handlers. */
export async function runOssCollectCommand(args: readonly string[], command?: OssReadCommand) {
  if (args[0] === "deployment") {
    const [, planPath, phase, output, ...extra] = args;
    requireEvidence(planPath && (phase === "before" || phase === "after") && output && extra.length === 0,
      "Usage: oss-collect-main.js deployment PLAN before|after OUTPUT");
    const plan = planSchema.parse(JSON.parse((await readRegular(planPath)).toString("utf8")));
    const result = await collectOssDeployment({ plan, phase, ...(command === undefined ? {} : { command }) });
    await createReceipt(output, result);
    return { kind: result.kind, status: "collected" as const };
  }
  if (args[0] === "assemble") {
    const [, planPath, sourceRoot, assemblyPath, outputRoot, ...extra] = args;
    requireEvidence(planPath && sourceRoot && assemblyPath && outputRoot && extra.length === 0,
      "Usage: oss-collect-main.js assemble PLAN SOURCE_ROOT ASSEMBLY OUTPUT_ROOT");
    return assembleOssNativeArchive({ planPath, sourceRoot, assemblyPath, outputRoot });
  }
  if (args[0] === "originals") {
    const [, planPath, manifestPath, originalDirectory, output, ...extra] = args;
    requireEvidence(planPath && manifestPath && originalDirectory && output && extra.length === 0,
      "Usage: oss-collect-main.js originals PLAN MANIFEST ORIGINAL_DIRECTORY OUTPUT");
    const plan = planSchema.parse(JSON.parse((await readRegular(planPath)).toString("utf8")));
    const result = await collectCraigOriginals({ originalDirectory, manifestBytes: await readRegular(manifestPath),
      craigRevision: plan.target.craigRevision });
    await createReceipt(output, result);
    return { kind: result.kind, recordingId: result.recordingId, status: "source-unavailable" as const };
  }
  const [mode, planPath, recordingId, output, ...extra] = args;
  requireEvidence((mode === "snapshot" || mode === "publication") && planPath && recordingId && output && extra.length === 0,
    "Usage: oss-collect-main.js snapshot|publication PLAN RECORDING_ID|SNAPSHOT OUTPUT");
  const plan = planSchema.parse(JSON.parse((await readRegular(planPath)).toString("utf8")));
  if (mode === "publication") {
    const native = z.object({ database: z.object({ snapshot: z.unknown(), matchingMeetingCount: z.literal(1),
      matchingRecordingCount: z.literal(1), matchingTranscriptCount: z.literal(1), matchingSummaryCount: z.literal(1) }),
      completion: z.object({ events: z.array(z.object({ type: z.string(), occurredAt: z.iso.datetime() })) }),
    }).parse(JSON.parse((await readRegular(recordingId, 64 * 1024 * 1024)).toString("utf8")));
    const database = normalizeDatabase(native.database).snapshot;
    const starts = native.completion.events.filter((event) => event.type === "meeting.started");
    const secrets = process.env.OSS_STT_PUBLICATION_SECRET_DIRECTORY;
    requireEvidence(starts.length === 1 && secrets, "Native recording start and publication credential directory required");
    const publication = await collectOssPublicationFromDiscord({ plan, meetingId: database.meetingId,
      messageId: database.publication.externalPublicationId, startedAtMs: Date.parse(starts[0]!.occurredAt) }, secrets);
    await createReceipt(output, publication);
    return { kind: publication.kind, recordingId: database.recording.recordingId, status: "collected" as const };
  }
  const snapshot = await collectOssReadonlySnapshot({ plan, recordingId,
    ...(command === undefined ? {} : { command }) });
  await createReceipt(output, snapshot);
  return { kind: snapshot.kind, recordingId, status: "collected" as const };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runOssCollectCommand(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(() => {
    process.stderr.write("OSS native read-only collection failed; retain source artifacts\n");
    process.exitCode = 1;
  });
}
