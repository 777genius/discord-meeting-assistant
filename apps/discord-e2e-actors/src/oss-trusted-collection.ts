import { constants } from "node:fs";
import { lstat, open, mkdir, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { z } from "zod";
import { collectOssDeployment } from "./oss-deployment-collection.js";
import { collectOssReadonlySnapshot, runOssReadCommand } from "./oss-readonly-collection.js";
import { collectOssPublicationFromDiscord } from "./oss-publication-collection.js";
import { collectCraigOriginals, readCraigSource, verifyCraigManifestAuthority } from "./oss-craig-original-collection.js";
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
  check(nonempty(planPath) && nonempty(manifestPath) && nonempty(sourceRootInput) && nonempty(outputRoot) && nonempty(receiptPath) && extra.length === 0,
    "Usage: trusted-collect PLAN FIXTURE_MANIFEST NEW_SOURCES NEW_ARCHIVE PASS_RECEIPT (root control on stdin)");
  const planBytes = await readRegular(planPath), fixtureBytes = await readRegular(manifestPath);
  const plan = planSchema.parse(JSON.parse(planBytes.toString("utf8")));
  check(sha256(fixtureBytes) === manifestDigest, "Unpinned fixture manifest");
  const secrets = process.env.OSS_STT_PUBLICATION_SECRET_DIRECTORY;
  check(nonempty(secrets), "Official publication credential directory required");
  const before = await collectOssDeployment({ plan, phase: "before" });
  const platform = before.services[0]!.containerId, craig = before.services[1]!.containerId;

  const initialMounts = await observeMounts(platform, craig, "before");
  const platformMounts = initialMounts[0].entries!, craigMounts = initialMounts[1].entries!;

  const journalRoot = await mountRoot(platformMounts, "/evidence/oss-stt"), craigRoot = await mountRoot(craigMounts, "/app/rec");
  const captureConfig = JSON.parse(await runOssReadCommand(["exec", platform, "node", "-e",
    'console.log(JSON.stringify([process.env.OSS_STT_NATIVE_EVIDENCE_DIRECTORY,process.env.OSS_STT_NATIVE_EVIDENCE_PROJECT,process.env.OSS_STT_NATIVE_EVIDENCE_REVISION,process.env.E2E_TEST_ONLY_LABEL]))',
  ])) as unknown;
  check(same(captureConfig, ["/evidence/oss-stt", plan.target.project, plan.target.platformRevision, "true"]),
    "Current runtime journal configuration mismatch");

  const journalNames = ["live-native.jsonl", "post-call-native.jsonl"];
  // Keep the admitted inode open until collection ends, preventing inode reuse.
  await using liveHandle = await open(resolve(journalRoot, "live-native.staging.jsonl"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const initial = [];
  // Live capture is readable during staging; only its published name is final evidence.
  for (const name of ["live-native.staging.jsonl", journalNames[1]!]) {
    const bytes = name === "live-native.staging.jsonl"
      ? await readInitialLiveJournal(journalRoot, liveHandle)
      : await readSource(journalRoot, name, 1024 * 1024);
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
  await put("plan.json", planBytes); await put("deployment-before.json", before);
  await put("mounts-before.json", initialMounts.map(item => item.observation));
  const runs = [];
  const control = controlLines();
  const timeout = setTimeout(() => process.stdin.destroy(new Error("Trusted collection control deadline")), 60 * 60 * 1000);
  try {
    process.stdout.write(`${JSON.stringify({ status: "armed", campaignId: plan.campaignId })}\n`);
    for (const [position, run] of plan.runs.entries()) {
      const next = await control.next();
      check(next.done !== true, "Missing root run control");
      const request = z.object({
        runId: z.literal(run.runId), recordingId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
        actorPath: z.string().min(1),
      }).strict().parse(JSON.parse(next.value));
      const snapshots = [], publications = [];
      for (let observation = 0; observation < 2; observation++) {
        const snapshot = await collectOssReadonlySnapshot({ plan, recordingId: request.recordingId });
        const db = normalizeOssDatabase(snapshot.database).snapshot;
        const events = z.object({ events: z.array(z.object({ type: z.string(), occurredAt: z.iso.datetime() })) })
          .parse(snapshot.completion).events.filter((event) => event.type === "meeting.started");
        check(events.length === 1, "Native recording start missing/duplicate");
        const publication = await collectOssPublicationFromDiscord({
          plan, meetingId: db.meetingId,
          messageId: db.publication.externalPublicationId, startedAtMs: Date.parse(events[0]!.occurredAt)
        }, secrets);
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
      verifyCraigManifestAuthority(Buffer.from(snapshot.objects[0]!.base64, "base64"),
        snapshot.completion, snapshot.database, snapshot.objects[0]!);
      const original = await collectCraigOriginals({
        originalDirectory: resolve(sourceRoot, originalDirectory),
        manifestBytes: Buffer.from(snapshot.objects[0]!.base64, "base64"), craigRevision: plan.target.craigRevision
      });
      check(original.files.every((file) => sha256(retained.get(`${originalDirectory}/${file.path}`)!) === file.sha256),
        "Original retention changed during collection");
      runs.push({
        runId: run.runId, snapshots, publications, originalDirectory,
        originalsPath: await put(`originals-${position}.json`, original),
        // Actor output is supplied by the trusted root orchestrator, and is only
        // supplemental fixture/timing evidence. It cannot substitute for any read.
        actorPath: await put(`actor-${position}.json`, await readRegular(request.actorPath))
      });
      process.stdout.write(`${JSON.stringify({ status: "settled", runId: run.runId })}\n`);
    }
    let afterCheck: "deployment" | "custody" | "mount" | "retention" = "deployment";
    try {
      const after = await collectOssDeployment({ plan, phase: "after" });
      afterCheck = "custody";
      check(same(before.services, after.services) && same(before.config, after.config), "Deployment changed during custody");
      afterCheck = "mount";
      const afterMounts = await observeMounts(platform, craig, "after", [platformMounts, craigMounts]);
      await put("mounts-after.json", afterMounts.map(item => item.observation));
      requireMounts(afterMounts);
      afterCheck = "retention";
      await put("deployment-after.json", after);
    } catch {
      // Closed identifiers only: command errors may contain credentials or paths.
      try {
        process.stderr.write(`${JSON.stringify({ event: "oss-trusted-collection-failed",
          stage: "post-third-settled", check: afterCheck })}\n`);
      } catch { /* Preserve the generic failure even if diagnostics are unavailable. */ }
      throw new Error("OSS native read-only collection failed; retain source artifacts");
    }
    process.stdout.write(`${JSON.stringify({ status: "awaiting-seal", campaignId: plan.campaignId })}\n`);
    const seal = await control.next();
    check(seal.done !== true && seal.value === "sealed", "Root must finish graceful journal sealing");
    // Root may gracefully stop Platform after the final healthy observation. Read
    // from the mount discovered from that exact running container, never a sidecar
    // filename supplied as authority. No restart, shutdown or replay is performed.
    for (const [position, name] of journalNames.entries()) {
      const bytes = name === "live-native.jsonl"
        ? await readPublishedLiveJournal(journalRoot, liveHandle)
        : await readSource(journalRoot, name, 1024 * 1024);
      check(bytes.subarray(0, initial[position]!.length).equals(initial[position]!), "Runtime journal replaced");
      await put(name, bytes);
    }
    const assembly = {
      kind: "oss-native-assembly-v1", deploymentPaths: ["deployment-before.json", "deployment-after.json"],
      livePath: journalNames[0], postCallPath: journalNames[1], runs };
    const assemblyPath = await put("assembly.json", assembly);
    const assembled = await assembleOssNativeArchive({
      planPath: resolve(sourceRoot, "plan.json"), sourceRoot,
      assemblyPath: resolve(sourceRoot, assemblyPath), outputRoot,
      retained: { planBytes, assemblyBytes: retained.get(assemblyPath)!, sources: retained }
    });
    const archive = await loadArchive(resolve(sourceRoot, "plan.json"), outputRoot);
    check(archive.planSha256 === sha256(planBytes) && archive.indexSha256 === assembled.collectionSha256,
      "Collector-owned complete inventory changed before admission");
    const evidence = await verifyOssCampaign(archive, fixtureBytes);
    check(evidence.consistency === "complete", `Campaign PASS unavailable: ${evidence.missingSourceCapabilities.join("; ")}`);
    const receipt = {
      kind: "oss-discord-stt-trusted-pass-v1", status: "passed", origin: "root-runtime-collection",
      evidence, inventorySha256: sha256(canonical(evidence.artifacts)) };
    await createReceipt(receiptPath, receipt);
    return { kind: receipt.kind, status: receipt.status, campaignId: plan.campaignId, collectionSha256: archive.indexSha256 };
  } finally {
    clearTimeout(timeout);
    await control.return();
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

// Bound the inspect response before parsing; retain only closed labels and hashes.
// Paths and Docker errors can contain secrets, even when the tuple is well formed.
const mountSchema = z.array(z.object({
  Type: z.enum(["bind", "volume", "tmpfs"]),
  Source: z.string().max(4096), Destination: z.string().min(1).max(4096).startsWith("/"),
}).refine(entry => entry.Type === "tmpfs" || entry.Source.length > 0)).max(256);
type MountInventory = z.infer<typeof mountSchema>;
type MountStatus = "ok" | "command" | "parse" | "duplicate-destination" | "tuple-mismatch";
async function observeMount(container: string, service: "platform" | "craig", expected?: MountInventory) {
  let status: MountStatus = "command";
  let entries: MountInventory | undefined;
  try {
    const raw = await runOssReadCommand(["inspect", "--format", "{{json .Mounts}}", container]);
    status = "parse";
    check(Buffer.byteLength(raw) <= 1024 * 1024, "Mount response bound");
    entries = mountSchema.parse(JSON.parse(raw));
    // Destination uniqueness makes this a total ordering without losing entries.
    entries.sort((a, b) => a.Destination < b.Destination ? -1 : a.Destination > b.Destination ? 1 : 0);
    status = new Set(entries.map(entry => entry.Destination)).size !== entries.length
      ? "duplicate-destination" : expected && !same(expected, entries) ? "tuple-mismatch" : "ok";
  } catch { /* Never retain raw output, rejected tuples, or exception messages. */ }
  return { entries, observation: { service, status, inventory: entries?.map(entry => ({
    type: entry.Type, sourceSha256: sha256(Buffer.from(entry.Source)),
    destinationSha256: sha256(Buffer.from(entry.Destination)),
  })) ?? null } };
}
async function observeMounts(platform: string, craig: string, phase: "before" | "after",
  expected?: readonly [MountInventory, MountInventory]) {
  // Observe both services even when the first command, parse, or comparison fails.
  const observations = [await observeMount(platform, "platform", expected?.[0]),
    await observeMount(craig, "craig", expected?.[1])] as const;
  process.stderr.write(`${JSON.stringify({ event: "oss-trusted-mount-observations", phase,
    services: observations.map(item => item.observation) })}\n`);
  if (phase === "before") { requireMounts(observations); }
  return observations;
}
function requireMounts(observations: Awaited<ReturnType<typeof observeMounts>>) {
  check(observations.every(item => item.observation.status === "ok"), "Runtime mount inventory rejected; retain mount observations");
}
const mountRoot = async (entries: MountInventory, destination: string) => {
  const matches = entries.filter((entry) => entry.Destination === destination && entry.Type === "bind");
  check(matches.length === 1, "Exact runtime source bind mount required");
  const path = resolve(matches[0]!.Source);
  check(await realpath(path) === path, "Runtime source mount symlink");
  return path;
};
const readSource = async (root: string, path: string, max = 512 * 1024 * 1024, empty = false) => {
  artifactSchema.shape.path.parse(path);
  const full = resolve(root, path);
  check(full.startsWith(root + sep) && await realpath(full) === full, "Runtime source path escape/symlink");
  return readCraigSource(root, path, max, empty);
};

function nonempty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** Only the exact writer publication pair may alias the admitted live inode. */
async function readPublishedLiveJournal(root: string, handle: Awaited<ReturnType<typeof open>>) {
  const before = await handle.stat();
  const validatePair = async () => {
    check(before.isFile() && before.nlink === 2 && before.size > 0 &&
      before.size <= 256 * 1024 * 1024, "Unsafe live journal type/hardlink/size");
    for (const name of ["live-native.staging.jsonl", "live-native.jsonl"]) {
      const path = resolve(root, name), named = await lstat(path);
      check(named.isFile() && !named.isSymbolicLink() && await realpath(path) === path &&
        named.nlink === 2 && named.dev === before.dev && named.ino === before.ino,
        "Live journal publication pair replaced/hardlink/symlink");
    }
  };
  await validatePair();
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
    check(read.bytesRead > 0, "Live journal truncated");
    offset += read.bytesRead;
  }
  await validatePair();
  const after = await handle.stat();
  check(after.nlink === 2 && after.size === before.size &&
    after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
    "Live journal changed while reading");
  return bytes;
}

/** Admission bytes must come from the descriptor retained through publication. */
async function readInitialLiveJournal(root: string, handle: Awaited<ReturnType<typeof open>>) {
  const path = resolve(root, "live-native.staging.jsonl"), before = await handle.stat();
  check(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= 1024 * 1024,
    "Unsafe live journal admission type/hardlink/size");
  const validate = async () => {
    const named = await lstat(path), current = await handle.stat();
    check(named.isFile() && !named.isSymbolicLink() && named.nlink === 1 &&
      named.dev === before.dev && named.ino === before.ino && await realpath(path) === path &&
      current.nlink === 1 && current.size === before.size && named.size === before.size &&
      current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs &&
      named.mtimeMs === before.mtimeMs && named.ctimeMs === before.ctimeMs,
      "Runtime journal changed at admission");
  };
  await validate();
  const bytes = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
    check(read.bytesRead > 0, "Live journal truncated at admission");
    offset += read.bytesRead;
  }
  await validate();
  return bytes;
}
