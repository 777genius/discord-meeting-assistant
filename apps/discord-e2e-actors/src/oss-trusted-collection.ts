import { mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { collectOssDeployment } from "./oss-deployment-collection.js";
import { collectOssReadonlySnapshot, runOssReadCommand } from "./oss-readonly-collection.js";
import { collectOssPublicationFromDiscord } from "./oss-publication-collection.js";
import { collectCraigOriginals } from "./oss-craig-original-collection.js";
import { assembleOssNativeArchive } from "./oss-native-archive-assembly.js";
import { normalizeOssDatabase } from "./oss-database.js";
import { verifyOssCampaign } from "./oss-campaign-verification.js";
import { canonical, createReceipt, loadArchive, readRegular, requireEvidence as check, same, sha256 } from "./oss-campaign-artifacts.js";
import { artifactSchema, manifestDigest, planSchema } from "./oss-campaign-profile.js";

// This composition entrypoint has NO injectable runtime adapters or admission claim
// parameter. Tests replace module imports, never a production CLI option. Trusted
// root owns this process, Docker and the actor orchestrator; malicious root is out
// of scope. Files, hashes, declarations and offline assembly alone grant no custody.
export async function runOssTrustedCollection(args: readonly string[]) {
  const [planPath, manifestPath, sourceRootInput, outputRoot, receiptPath, ...extra] = args;
  check(planPath && manifestPath && sourceRootInput && outputRoot && receiptPath && extra.length === 0,
    "Usage: trusted-collect PLAN FIXTURE_MANIFEST NEW_SOURCES NEW_ARCHIVE PASS_RECEIPT (root control on stdin)");
  const planBytes = await readRegular(planPath), fixtureBytes = await readRegular(manifestPath);
  const plan = planSchema.parse(JSON.parse(planBytes.toString("utf8")));
  check(sha256(fixtureBytes) === manifestDigest, "Unpinned fixture manifest");
  const secrets = process.env.OSS_STT_PUBLICATION_SECRET_DIRECTORY;
  check(secrets, "Official publication credential directory required");
  const before = await collectOssDeployment({ plan, phase: "before" });
  const platform = before.services[0]!.containerId, craig = before.services[1]!.containerId;
  const mounts = async (container: string) => z.array(z.object({
    Type: z.enum(["bind", "volume", "tmpfs"]), Source: z.string(), Destination: z.string(),
  })).parse(JSON.parse(await runOssReadCommand(["inspect", "--format", "{{json .Mounts}}", container])));
  const platformMounts = await mounts(platform), craigMounts = await mounts(craig);
  const mountRoot = async (entries: Awaited<ReturnType<typeof mounts>>, destination: string) => {
    const matches = entries.filter((entry) => entry.Destination === destination && entry.Type === "bind");
    check(matches.length === 1, "Exact runtime source bind mount required");
    const path = resolve(matches[0]!.Source);
    check(await realpath(path) === path, "Runtime source mount symlink");
    return path;
  };
  const journalRoot = await mountRoot(platformMounts, "/evidence/oss-stt");
  const craigRoot = await mountRoot(craigMounts, "/app/rec");
  const captureConfig = JSON.parse(await runOssReadCommand(["exec", platform, "node", "-e",
    'console.log(JSON.stringify([process.env.OSS_STT_NATIVE_EVIDENCE_DIRECTORY,process.env.OSS_STT_NATIVE_EVIDENCE_PROJECT,process.env.OSS_STT_NATIVE_EVIDENCE_REVISION,process.env.E2E_TEST_ONLY_LABEL]))',
  ])) as unknown;
  check(same(captureConfig, ["/evidence/oss-stt", plan.target.project, plan.target.platformRevision, "true"]),
    "Current runtime journal configuration mismatch");
  const readSource = async (root: string, path: string, max = 512 * 1024 * 1024, empty = false) => {
    artifactSchema.shape.path.parse(path);
    const full = resolve(root, path);
    check(full.startsWith(root + sep) && await realpath(full) === full, "Runtime source path escape/symlink");
    return readRegular(full, max, empty);
  };
  const journalNames = ["live-native.jsonl", "post-call-native.jsonl"];
  const initial = [];
  for (const name of journalNames) {
    const bytes = await readSource(journalRoot, name, 1024 * 1024);
    const rows = bytes.toString("utf8").trimEnd().split("\n");
    check(rows.length === 1 && (JSON.parse(rows[0]!) as { type: string }).type === "capture_start",
      "Trusted collection must start before any native campaign events");
    initial.push(bytes);
  }
  const sourceRoot = resolve(sourceRootInput);
  check(![journalRoot, craigRoot].some((root) => sourceRoot === root || sourceRoot.startsWith(root + sep)),
    "Collector retention must be separate from runtime sources");
  await mkdir(sourceRoot, { mode: 0o700 });
  check(await realpath(sourceRoot) === sourceRoot, "Collector retention symlink");
  const retained = new Map<string, Buffer>();
  let retainedSize = 0;
  const put = async (path: string, value: unknown) => {
    check(!retained.has(path), "Duplicate collector source");
    const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
    retainedSize += bytes.length;
    check(retainedSize <= 1024 * 1024 * 1024, "Collector retention exceeds 1 GiB");
    retained.set(path, bytes);
    await writeFile(resolve(sourceRoot, path), bytes, { flag: "wx", mode: 0o600 });
    return path;
  };
  await put("plan.json", planBytes);
  await put("deployment-before.json", before);
  const runs = [];
  const control = controlLines();
  const timeout = setTimeout(() => process.stdin.destroy(new Error("Trusted collection control deadline")), 60 * 60 * 1000);
  try {
    process.stdout.write(`${JSON.stringify({ status: "armed", campaignId: plan.campaignId })}\n`);
    for (const [position, run] of plan.runs.entries()) {
      const next = await control.next();
      check(!next.done, "Missing root run control");
      const request = z.object({ runId: z.literal(run.runId), recordingId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        actorPath: z.string().min(1), preparedJobPath: artifactSchema.shape.path,
      }).strict().parse(JSON.parse(next.value));
      const snapshots = [], publications = [];
      for (let observation = 0; observation < 2; observation++) {
        const snapshot = await collectOssReadonlySnapshot({ plan, recordingId: request.recordingId });
        const db = normalizeOssDatabase(snapshot.database).snapshot;
        const events = z.object({ events: z.array(z.object({ type: z.string(), occurredAt: z.iso.datetime() })) })
          .parse(snapshot.completion).events.filter((event) => event.type === "meeting.started");
        check(events.length === 1, "Native recording start missing/duplicate");
        const publication = await collectOssPublicationFromDiscord({ plan, meetingId: db.meetingId,
          messageId: db.publication.externalPublicationId, startedAtMs: Date.parse(events[0]!.occurredAt) }, secrets);
        snapshots.push(await put(`snapshot-${position}-${observation}.json`, snapshot));
        publications.push(await put(`publication-${position}-${observation}.json`, publication));
      }
      const snapshot = JSON.parse(retained.get(snapshots[0]!)!.toString("utf8")) as Awaited<ReturnType<typeof collectOssReadonlySnapshot>>;
      const originalDirectory = `originals-${position}`;
      await mkdir(resolve(sourceRoot, originalDirectory), { mode: 0o700 });
      for (const kind of ["data", "header1", "header2", "users", "info", "log"]) {
        const name = `${request.recordingId}.ogg.${kind}`;
        await put(`${originalDirectory}/${name}`, await readSource(craigRoot, name, 512 * 1024 * 1024, true));
      }
      const original = await collectCraigOriginals({ originalDirectory: resolve(sourceRoot, originalDirectory),
        manifestBytes: Buffer.from(snapshot.objects[0]!.base64, "base64"), craigRevision: plan.target.craigRevision,
        jobBytes: await readSource(craigRoot, request.preparedJobPath, 16 * 1024 * 1024) });
      check(original.files.every((file) => sha256(retained.get(`${originalDirectory}/${file.path}`)!) === file.sha256),
        "Original retention changed during collection");
      runs.push({ runId: run.runId, snapshots, publications, originalDirectory,
        originalsPath: await put(`originals-${position}.json`, original),
        // Actor output is supplied by the trusted root orchestrator, and is only
        // supplemental fixture/timing evidence. It cannot substitute for any read.
        actorPath: await put(`actor-${position}.json`, await readRegular(request.actorPath)) });
      process.stdout.write(`${JSON.stringify({ status: "settled", runId: run.runId })}\n`);
    }
    const after = await collectOssDeployment({ plan, phase: "after" });
    check(same(before.services, after.services) && same(before.config, after.config), "Deployment changed during custody");
    check(same(platformMounts, await mounts(platform)) && same(craigMounts, await mounts(craig)), "Runtime source mounts changed");
    await put("deployment-after.json", after);
    process.stdout.write(`${JSON.stringify({ status: "awaiting-seal", campaignId: plan.campaignId })}\n`);
    const seal = await control.next();
    check(!seal.done && seal.value === "sealed", "Root must finish graceful journal sealing");
    // Root may gracefully stop Platform after the final healthy observation. Read
    // from the mount discovered from that exact running container, never a sidecar
    // filename supplied as authority. No restart, shutdown or replay is performed.
    for (const [position, name] of journalNames.entries()) {
      const bytes = await readSource(journalRoot, name, name.startsWith("live") ? 256 * 1024 * 1024 : 1024 * 1024);
      check(bytes.subarray(0, initial[position]!.length).equals(initial[position]!), "Runtime journal replaced");
      await put(name, bytes);
    }
    const assembly = { kind: "oss-native-assembly-v1", deploymentPaths: ["deployment-before.json", "deployment-after.json"],
      livePath: journalNames[0], postCallPath: journalNames[1], runs };
    const assemblyPath = await put("assembly.json", assembly);
    const assembled = await assembleOssNativeArchive({ planPath: resolve(sourceRoot, "plan.json"), sourceRoot,
      assemblyPath: resolve(sourceRoot, assemblyPath), outputRoot,
      retained: { planBytes, assemblyBytes: retained.get(assemblyPath)!, sources: retained } });
    const archive = await loadArchive(resolve(sourceRoot, "plan.json"), outputRoot);
    check(archive.planSha256 === sha256(planBytes) && archive.indexSha256 === assembled.collectionSha256,
      "Collector-owned complete inventory changed before admission");
    const evidence = await verifyOssCampaign(archive, fixtureBytes);
    check(evidence.consistency === "complete", `Campaign PASS unavailable: ${evidence.missingSourceCapabilities.join("; ")}`);
    const receipt = { kind: "oss-discord-stt-trusted-pass-v1", status: "passed", origin: "root-runtime-collection",
      evidence, inventorySha256: sha256(canonical(evidence.artifacts)) };
    await createReceipt(receiptPath, receipt);
    return { kind: receipt.kind, status: receipt.status, campaignId: plan.campaignId, collectionSha256: archive.indexSha256 };
  } finally {
    clearTimeout(timeout);
    await control.return(undefined);
  }
}

async function* controlLines() {
  let pending = "", count = 0;
  for await (const chunk of process.stdin) {
    pending += String(chunk);
    check(pending.length <= 16384, "Root control exceeds bound");
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      check(++count <= 4, "Unexpected root control");
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      yield line;
    }
  }
  check(pending.length === 0, "Truncated root control");
}
