import { collectionFailureDiagnostic, OssCollectionDiagnosticError } from "./oss-native-live-collection.js";
import { runOssTrustedCollection } from "./oss-trusted-collection.js";
import { collectOssDeployment } from "./oss-deployment-collection.js";
import { assembleOssNativeArchive } from "./oss-native-archive-assembly.js";
import { collectCraigOriginals } from "./oss-craig-original-collection.js";
import { z } from "zod";
import { normalizeOssDatabase } from "./oss-database.js";
import { collectOssPublicationFromDiscord } from "./oss-publication-collection.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReceipt, readRegular, requireEvidence } from "./oss-campaign-artifacts.js";
import { planSchema } from "./oss-campaign-profile.js";
import { collectOssReadonlySnapshot, type OssReadCommand } from "./oss-readonly-collection.js";

/** Explicit effect boundary: unlike collect:e2e this only obtains read-only native
 * evidence. It never invokes actors, providers, BullMQ, or process/replay handlers. */
export async function runOssCollectCommand(args: readonly string[], command?: OssReadCommand) {
  if (args[0] === "trusted-collect") {
    requireEvidence(command === undefined, "Trusted collection does not accept runtime adapter injection");
    return runOssTrustedCollection(args.slice(1));
  }
  if (args[0] === "deployment") { return collectDeployment(args, command); }
  if (args[0] === "assemble") {
    const [, planPath, sourceRoot, assemblyPath, outputRoot, ...extra] = args;
    requireEvidence(nonempty(planPath) && nonempty(sourceRoot) && nonempty(assemblyPath) && nonempty(outputRoot) && extra.length === 0,
      "Usage: oss-collect-main.js assemble PLAN SOURCE_ROOT ASSEMBLY OUTPUT_ROOT");
    return assembleOssNativeArchive({ planPath, sourceRoot, assemblyPath, outputRoot });
  }
  if (args[0] === "originals") { return collectOriginals(args); }
  const [mode, planPath, recordingId, output, ...extra] = args;
  requireEvidence((mode === "snapshot" || mode === "publication") && nonempty(planPath) && nonempty(recordingId) && nonempty(output) && extra.length === 0,
    "Usage: oss-collect-main.js snapshot|publication PLAN RECORDING_ID|SNAPSHOT OUTPUT");
  const plan = planSchema.parse(JSON.parse((await readRegular(planPath)).toString("utf8")));
  if (mode === "publication") {
    const native = z.object({
      database: z.object({
        snapshot: z.unknown(), matchingMeetingCount: z.literal(1),
        matchingRecordingCount: z.literal(1), matchingTranscriptCount: z.literal(1), matchingSummaryCount: z.literal(1)
      }),
      completion: z.object({ events: z.array(z.object({ type: z.string(), occurredAt: z.iso.datetime() })) }),
    }).parse(JSON.parse((await readRegular(recordingId, 64 * 1024 * 1024)).toString("utf8")));
    const database = normalizeOssDatabase(native.database).snapshot;
    const starts = native.completion.events.filter((event) => event.type === "meeting.started");
    const secrets = process.env.OSS_STT_PUBLICATION_SECRET_DIRECTORY;
    requireEvidence(starts.length === 1 && nonempty(secrets), "Native recording start and publication credential directory required");
    const publication = await collectOssPublicationFromDiscord({
      plan, meetingId: database.meetingId,
      messageId: database.publication.externalPublicationId, startedAtMs: Date.parse(starts[0]!.occurredAt)
    }, secrets);
    await createReceipt(output, publication);
    return { kind: publication.kind, recordingId: database.recording.recordingId, status: "collected" as const };
  }
  const snapshot = await collectOssReadonlySnapshot({
    plan, recordingId,
    ...(command === undefined ? {} : { command })
  });
  await createReceipt(output, snapshot);
  return { kind: snapshot.kind, recordingId, status: "collected" as const };
}
if (nonempty(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runOssCollectCommand(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }).catch((error: unknown) => {
    if (error instanceof OssCollectionDiagnosticError) {
      try { process.stderr.write(`${JSON.stringify(collectionFailureDiagnostic(error, "assembly"))}\n`); }
      catch { /* The generic external fallback remains safe. */ }
    }
    process.stderr.write("OSS native read-only collection failed; retain source artifacts\n");
    process.exitCode = 1;
  });
}

function nonempty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

async function collectDeployment(args: readonly string[], command?: OssReadCommand) {
  const [, planPath, phase, output, ...extra] = args;
  requireEvidence(nonempty(planPath) && (phase === "before" || phase === "after") && nonempty(output) && extra.length === 0,
    "Usage: oss-collect-main.js deployment PLAN before|after OUTPUT");
  const plan = planSchema.parse(JSON.parse((await readRegular(planPath)).toString("utf8")));
  const result = await collectOssDeployment({ plan, phase, ...(command === undefined ? {} : { command }) });
  await createReceipt(output, result);
  return { kind: result.kind, status: "collected" as const };
}

async function collectOriginals(args: readonly string[]) {
  const [, planPath, manifestPath, originalDirectory, output, ...extra] = args;
  requireEvidence(nonempty(planPath) && nonempty(manifestPath) && nonempty(originalDirectory) && nonempty(output) && extra.length === 0,
    "Usage: oss-collect-main.js originals PLAN MANIFEST ORIGINAL_DIRECTORY OUTPUT");
  const plan = planSchema.parse(JSON.parse((await readRegular(planPath)).toString("utf8")));
  const result = await collectCraigOriginals({
    originalDirectory, manifestBytes: await readRegular(manifestPath),
    craigRevision: plan.target.craigRevision
  });
  await createReceipt(output, result);
  return { kind: result.kind, recordingId: result.recordingId, status: "recomputed" as const };
}
