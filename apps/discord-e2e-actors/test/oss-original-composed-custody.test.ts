import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { originalCustodyFixture } from "./oss-original-custody-fixture.js";
import { assembleOssNativeArchive } from "../src/oss-native-archive-assembly.js";
import { loadArchive } from "../src/oss-campaign-artifacts.js";
import { verifyOssCampaign } from "../src/oss-campaign-verification.js";
import { runOssCampaignCommand } from "../src/oss-campaign-main.js";

const boundary = vi.hoisted(() => ({ deployment: vi.fn(), snapshot: vi.fn(), docker: vi.fn(), publication: vi.fn() }));
vi.mock("../src/oss-deployment-collection.js", async original => ({
  ...await original<object>(), collectOssDeployment: boundary.deployment,
}));
vi.mock("../src/oss-readonly-collection.js", () => ({ collectOssReadonlySnapshot: boundary.snapshot, runOssReadCommand: boundary.docker }));
vi.mock("../src/oss-publication-collection.js", () => ({ collectOssPublicationFromDiscord: boundary.publication }));
import { runOssTrustedCollection } from "../src/oss-trusted-collection.js";

const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
afterEach(() => {
  Object.defineProperty(process, "stdin", stdinDescriptor);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetAllMocks();
});

it("composes real original proof, assembly and final verification after producer job deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "original-composed-"));
  try {
    const sourceRoot = join(root, "sources");
    await mkdir(sourceRoot);
    const f = await originalCustodyFixture(sourceRoot);
    const journals = join(root, "runtime-journals"), craig = join(root, "runtime-craig");
    await mkdir(journals); await mkdir(craig);
    const journalFiles = [["live-native.jsonl", "live.jsonl"], ["post-call-native.jsonl", "post-call.jsonl"]] as const;
    for (const [name, retained] of journalFiles) {
      const bytes = await readFile(join(sourceRoot, retained));
      await writeFile(join(journals, name), bytes.subarray(0, bytes.indexOf(10) + 1));
    }
    for (const source of f.sources) {
      const proof = await f.read(source.originalsPath) as { files: Array<{ path: string }> };
      for (const file of proof.files) {
        await writeFile(join(craig, file.path), await readFile(join(sourceRoot, source.originalDirectory, file.path)));
      }
      const job = join(craig, `${source.runId}.job.json`);
      await writeFile(job, "acknowledged; producer immediately deletes"); await rm(job);
    }
    boundary.deployment.mockImplementation(async ({ phase }: { phase: string }) => {
      if (phase === "after") {
        for (const [name, retained] of journalFiles) { await writeFile(join(journals, name), await readFile(join(sourceRoot, retained))); }
      }
      return f.read(`deployment-${phase}.json`);
    });
    boundary.docker.mockImplementation(async (args: string[]) => args[0] === "inspect"
      ? JSON.stringify([{ Type: "bind", Source: args.at(-1) === "1".repeat(12) ? journals : craig,
        Destination: args.at(-1) === "1".repeat(12) ? "/evidence/oss-stt" : "/app/rec" }])
      : JSON.stringify(["/evidence/oss-stt", f.plan.target.project, f.plan.target.platformRevision, "true"]));
    const observed = new Map<string, number>();
    boundary.snapshot.mockImplementation(async ({ recordingId }: { recordingId: string }) => {
      const position = f.runs.findIndex(run => run.recordingId === recordingId);
      const observation = observed.get(recordingId) ?? 0; observed.set(recordingId, observation + 1);
      return f.read(f.sources[position]!.snapshots[observation]!);
    });
    const publications = new Map<string, number>();
    boundary.publication.mockImplementation(async ({ meetingId }: { meetingId: string }) => {
      const position = f.runs.findIndex(run => run.meetingId === meetingId);
      const observation = publications.get(meetingId) ?? 0; publications.set(meetingId, observation + 1);
      return f.read(f.sources[position]!.publications[observation]!);
    });
    const control = f.runs.map(run => JSON.stringify({ runId: run.runId, recordingId: run.recordingId,
      actorPath: join(sourceRoot, run.actorPath) }));
    Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([control.join("\n") + "\nsealed\n"]) });
    vi.stubEnv("OSS_STT_PUBLICATION_SECRET_DIRECTORY", "/synthetic-official-test-boundary");
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const manifestPath = new URL("./fixtures/manifest.v1.json", import.meta.url).pathname;
    const receipt = join(root, "pass.json");
    expect(await runOssTrustedCollection([f.planPath, manifestPath, join(root, "retained"), join(root, "archive"), receipt]))
      .toMatchObject({ status: "passed" });
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ origin: "root-runtime-collection" });
    expect(boundary.snapshot).toHaveBeenCalledTimes(6);
    const archive = await loadArchive(f.planPath, join(root, "archive"));
    expect(await verifyOssCampaign(archive, f.manifestBytes)).toMatchObject({ status: "sources-unverified", consistency: "complete" });
    const proof = archive.json(archive.index.nativeSources!.runs[0]!.originalsPath);
    expect(proof).toMatchObject({ kind: "oss-native-craig-originals-v2" });
    await expect(runOssCampaignCommand(["qualify", f.planPath, join(root, "archive"), manifestPath, join(root, "offline-pass.json")]))
      .rejects.toThrow("PASS unavailable");
    await expect(readFile(join(root, "offline-pass.json"))).rejects.toThrow();
    await assembleOssNativeArchive({ planPath: f.planPath, sourceRoot,
      assemblyPath: join(sourceRoot, "assembly.json"), outputRoot: join(root, "offline") });
    expect(await verifyOssCampaign(await loadArchive(f.planPath, join(root, "offline")), f.manifestBytes))
      .toMatchObject({ status: "sources-unverified", consistency: "complete" });
    const tampered = { ...archive, bytes: (path: string, system?: Parameters<typeof archive.bytes>[1]) => {
      const bytes = archive.bytes(path, system);
      return path.endsWith(".ogg.data") ? Buffer.alloc(bytes.length, 1) : bytes;
    } };
    await expect(verifyOssCampaign(tampered, f.manifestBytes)).rejects.toThrow("aggregate disagrees");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);

it("rejects substituted native authority even after assembly recomputes archive hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "original-authority-substitution-"));
  try {
    const sourceRoot = join(root, "sources"); await mkdir(sourceRoot);
    const f = await originalCustodyFixture(sourceRoot);
    const paths = f.sources[0]!.snapshots;
    const originals = await Promise.all(paths.map(path => readFile(join(sourceRoot, path))));
    for (const mutation of ["manifest-version", "manifest-bytes", "completion-recording", "completion-track", "database-recording", "transcript-version", "transcript-recording", "extra-recording"] as const) {
      for (const [index, path] of paths.entries()) {
        const snapshot = JSON.parse(originals[index]!.toString()) as {
          objects: Array<{ revision: string; base64: string }>; recordingIds: string[];
          completion: { recordingId: string; recording: { speakerAudio: Array<{ artifactRevision: string }> } };
          database: { snapshot: { recording: { recordingId: string }; transcript: { version: number; recordingId: string } } };
        };
        if (mutation === "manifest-version") { snapshot.objects[0]!.revision = "substituted"; }
        if (mutation === "manifest-bytes") {
          snapshot.objects[0]!.base64 = Buffer.from(Buffer.from(snapshot.objects[0]!.base64, "base64").toString() + " ").toString("base64");
        }
        if (mutation === "completion-recording") { snapshot.completion.recordingId = "substituted"; }
        if (mutation === "completion-track") { snapshot.completion.recording.speakerAudio[0]!.artifactRevision = "substituted"; }
        if (mutation === "database-recording") { snapshot.database.snapshot.recording.recordingId = "substituted"; }
        if (mutation === "transcript-version") { snapshot.database.snapshot.transcript.version = 0; }
        if (mutation === "transcript-recording") { snapshot.database.snapshot.transcript.recordingId = "substituted"; }
        if (mutation === "extra-recording") { snapshot.recordingIds.push("substituted"); }
        await writeFile(join(sourceRoot, path), JSON.stringify(snapshot));
      }
      const outputRoot = join(root, mutation);
      await expect((async () => {
        await assembleOssNativeArchive({ planPath: f.planPath, sourceRoot, assemblyPath: join(sourceRoot, "assembly.json"), outputRoot });
        return verifyOssCampaign(await loadArchive(f.planPath, outputRoot), f.manifestBytes);
      })()).rejects.toThrow();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60000);
