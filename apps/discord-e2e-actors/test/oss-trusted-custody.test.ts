import { link, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { campaignFixture } from "./oss-campaign-fixture.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";

const mocks = vi.hoisted(() => ({
  deployment: vi.fn(), snapshot: vi.fn(), docker: vi.fn(), publication: vi.fn(),
  originals: vi.fn(), assemble: vi.fn(), load: vi.fn(), verify: vi.fn()
}));
vi.mock("../src/oss-deployment-collection.js", () => ({ collectOssDeployment: mocks.deployment }));
vi.mock("../src/oss-readonly-collection.js", () => ({ collectOssReadonlySnapshot: mocks.snapshot, runOssReadCommand: mocks.docker }));
vi.mock("../src/oss-publication-collection.js", () => ({ collectOssPublicationFromDiscord: mocks.publication }));
vi.mock("../src/oss-craig-original-collection.js", async (original) => ({
  ...await original<object>(), collectCraigOriginals: mocks.originals, verifyCraigManifestAuthority: vi.fn()
}));
vi.mock("../src/oss-native-archive-assembly.js", () => ({ assembleOssNativeArchive: mocks.assemble }));
vi.mock("../src/oss-campaign-verification.js", () => ({ verifyOssCampaign: mocks.verify }));
vi.mock("../src/oss-campaign-artifacts.js", async (original) => ({
  ...await original<object>(), loadArchive: mocks.load,
}));
import { runOssTrustedCollection } from "../src/oss-trusted-collection.js";
import { runOssCollectCommand } from "../src/oss-collect-main.js";

// Load the actual writer source at runtime without extending this package's TS root.
interface TestWriter {
  settle(): Promise<void>; close(): Promise<void>; abort(): void;
  open(): { record(event: { type: "success" }): void };
}
const writerModule = await import(new URL("../../../packages/voicetext-adapter/src/oss-native-evidence.ts", import.meta.url).href) as {
  OssNativeEvidenceJournal: new (input: { directory: string; project: string; testOnly: boolean; revision: string }) => TestWriter;
};
const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin")!;
let root: string;
let activeWriter: TestWriter | undefined;
beforeEach(async () => { vi.resetAllMocks(); root = await mkdtemp(join(tmpdir(), "oss-custody-")); });
afterEach(async () => {
  if (activeWriter) { activeWriter.abort(); await activeWriter.close().catch(() => {}); activeWriter = undefined; }
  Object.defineProperty(process, "stdin", stdinDescriptor);
  vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
});
async function setup() {
  const f = await campaignFixture(root); await f.save();
  const journals = join(root, "runtime-journals"), craig = join(root, "runtime-craig");
  await mkdir(journals); await mkdir(craig);
  const header = Buffer.from('{"type":"capture_start"}\n');
  const writer = new writerModule.OssNativeEvidenceJournal({ directory: journals,
    project: "vtoss-test-oss-8f49a06-r1", testOnly: true, revision: f.plan.target.platformRevision });
  activeWriter = writer;
  await writer.settle();
  await writeFile(join(journals, "post-call-native.jsonl"), header);
  const services = [{ containerId: "a".repeat(12) }, { containerId: "b".repeat(12) }];

  mocks.docker.mockImplementation(async (args: string[]) => {
    if (args[0] === "inspect") {
return JSON.stringify(args.at(-1) === services[0]!.containerId
        ? mounts(journals, "/evidence/oss-stt") : mounts(craig, "/app/rec"));
}
    return JSON.stringify(["/evidence/oss-stt", f.plan.target.project, f.plan.target.platformRevision, "true"]);
  });
  mocks.deployment.mockImplementation(async ({ phase }: { phase: string }) => {
    if (phase === "after") {
const session = writer.open();
      session.record({ type: "success" });
      await writer.close();
      expect((await lstat(join(journals, "live-native.jsonl"))).nlink).toBe(2);
      await writeFile(join(journals, "post-call-native.jsonl"), Buffer.concat([header, Buffer.from('{"type":"capture_seal"}\n')]));
}
    return { services, config: {}, phase };
  });
  const control = [];
  for (const run of f.runs) {
    const jobPath = `${run.recordingId}.job.json`;
    await writeFile(join(craig, jobPath), JSON.stringify({ recordingId: run.recordingId }));
    for (const kind of ["data", "header1", "header2", "users", "info", "log"]) { await writeFile(join(craig, `${run.recordingId}.ogg.${kind}`), Buffer.from(kind)); }
    control.push(JSON.stringify({
      runId: run.runId, recordingId: run.recordingId,
      actorPath: join(root, run.actorPath)
    }));
  }
  mocks.snapshot.mockImplementation(async ({ recordingId }: { recordingId: string }) => {
    const run = f.runs.find((item) => item.recordingId === recordingId)!;
    const db = structuredClone(f.files.get(run.databasePath)!.value) as { snapshot: { transcript: object } };
    Object.assign(db.snapshot.transcript, { version: 3, recordingId });
    return {
      database: db, completion: { events: [{ type: "meeting.started", occurredAt: new Date(run.startedAtMs).toISOString() }] },
      objects: [{ base64: Buffer.from("manifest-runtime-bytes").toString("base64") }]
    };
  });
  mocks.publication.mockResolvedValue({ runtime: "discord-read" });
  mocks.originals.mockImplementation(async ({ originalDirectory }: { originalDirectory: string }) => {
    const recordingId = `recording-${originalDirectory.split("-").at(-1)}`;
    return {
      files: ["data", "header1", "header2", "users", "info", "log"].map((kind) => ({
        path: `${recordingId}.ogg.${kind}`, sha256: sha256(Buffer.from(kind)),
      }))
    };
  });
  mocks.assemble.mockResolvedValue({ collectionSha256: "collected-inventory" });
  mocks.load.mockResolvedValue({ planSha256: sha256(await readFile(f.planPath)), indexSha256: "collected-inventory" });
  mocks.verify.mockResolvedValue({ consistency: "complete", artifacts: [{ path: "complete-inventory" }], missingSourceCapabilities: [] });
  vi.stubEnv("OSS_STT_PUBLICATION_SECRET_DIRECTORY", "/test-only-official-identity");
  Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([control.join("\n") + "\nsealed\n"]) });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const receipt = join(root, "pass.json");
  const args = [f.planPath, new URL("./fixtures/manifest.v1.json", import.meta.url).pathname,
  join(root, "retained"), join(root, "archive"), receipt];
  return { args, receipt, journals, craig, writer };
}
it("independently collects all runtime sources before binding retained bytes and creating a distinct PASS", async () => {
  const { args, receipt } = await setup();
  expect(await runOssTrustedCollection(args)).toMatchObject({ kind: "oss-discord-stt-trusted-pass-v1", status: "passed" });
  expect(mocks.deployment.mock.calls.map(([input]) => (input as { phase: string }).phase)).toEqual(["before", "after"]);
  expect(mocks.snapshot).toHaveBeenCalledTimes(6);
  expect(mocks.publication).toHaveBeenCalledTimes(6);
  expect(mocks.originals).toHaveBeenCalledTimes(3);
  const assembly = mocks.assemble.mock.calls[0]![0] as Parameters<typeof import("../src/oss-native-archive-assembly.js").assembleOssNativeArchive>[0];
  expect(assembly.retained!.sources.get("live-native.jsonl")!.toString()).toContain("capture_seal");
  expect(assembly.retained!.sources.get("originals-0/recording-0.ogg.data")!.toString()).toBe("data");
  expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({ origin: "root-runtime-collection", status: "passed" });
  expect(mocks.verify.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.assemble.mock.invocationCallOrder[0]!);
});
it.each(["deployment", "snapshot", "publication", "originals", "assemble", "verify"] as const)(
  "cannot write PASS if independent %s fails", async (source) => {
    const { args, receipt } = await setup(); mocks[source].mockRejectedValue(new Error("source unavailable"));
    await expect(runOssTrustedCollection(args)).rejects.toThrow("source unavailable");
    await expect(readFile(receipt)).rejects.toThrow();
  });
it.each(["inventory", "incomplete", "mount", "preexisting-journal"])("denies %s custody mismatch", async (kind) => {
  const { args, receipt, journals } = await setup();
  if (kind === "inventory") { mocks.load.mockResolvedValue({ planSha256: "forged", indexSha256: "collected-inventory" }); }
  if (kind === "incomplete") { mocks.verify.mockResolvedValue({ consistency: "incomplete", missingSourceCapabilities: ["native source"] }); }
  if (kind === "mount") { mocks.docker.mockResolvedValue("[]"); }
  if (kind === "preexisting-journal") { await writeFile(join(journals, "live-native.staging.jsonl"), '{"type":"capture_start"}\n{"type":"opening"}\n'); }
  await expect(runOssTrustedCollection(args)).rejects.toThrow();
  await expect(readFile(receipt)).rejects.toThrow();
});
it("does not expose command injection as a runtime admission bypass", async () => {
  await expect(runOssCollectCommand(["trusted-collect"], vi.fn())).rejects.toThrow("does not accept runtime adapter injection");
  expect(mocks.deployment).not.toHaveBeenCalled();
});

const mounts = (source: string, destination: string) => [{ Type: "bind", Source: source, Destination: destination }];

it.each(["hardlink", "symlink"])("rejects runtime source %s before retention or original proof", async alias => {
  const { args, receipt, craig } = await setup();
  const source = join(craig, "recording-0.ogg.data");
  if (alias === "hardlink") { await link(source, join(craig, "source-alias")); }
  else {
    await rm(source);
    await symlink(join(craig, "recording-0.ogg.header1"), source);
  }
  await expect(runOssTrustedCollection(args)).rejects.toThrow(/hardlink|symlink/u);
  expect(mocks.originals).not.toHaveBeenCalled();
  expect(mocks.assemble).not.toHaveBeenCalled();
  await expect(readFile(receipt)).rejects.toThrow();
});

it.each(["substitution", "extra-hardlink", "final-symlink", "staging-symlink", "inode-change"])(
  "rejects live publication %s before assembly", async attack => {
    const { args, receipt, journals } = await setup();
    const publish = mocks.deployment.getMockImplementation()!;
    mocks.deployment.mockImplementation(async (input: { phase: string }) => {
      const result: unknown = await publish(input);
      if (input.phase === "after") {
        const final = join(journals, "live-native.jsonl");
        const staging = join(journals, "live-native.staging.jsonl");
        const bytes = await readFile(final);
        if (attack === "extra-hardlink") { await link(final, join(root, "extra-alias")); }
        if (attack === "substitution") { await rm(final); await writeFile(final, bytes); }
        if (attack === "final-symlink") { await rm(final); await symlink(staging, final); }
        if (attack === "staging-symlink") { await rm(staging); await symlink(final, staging); }
        if (attack === "inode-change") {
          await rm(final); await rm(staging);
          await writeFile(staging, bytes); await link(staging, final);
        }
      }
      return result;
    });
    await expect(runOssTrustedCollection(args)).rejects.toThrow(/journal/u);
    expect(mocks.assemble).not.toHaveBeenCalled();
    await expect(readFile(receipt)).rejects.toThrow();
  });
