import { appendFile, truncate, link, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { campaignFixture } from "./oss-campaign-fixture.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";

const mocks = vi.hoisted(() => ({
  deployment: vi.fn<(input: { phase: string }) => Promise<{ config: object }>>(), snapshot: vi.fn(), docker: vi.fn(), publication: vi.fn(),
  open: vi.fn(), originals: vi.fn(), assemble: vi.fn(), load: vi.fn(), verify: vi.fn()
}));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const implementation = mocks.open.getMockImplementation();
    return implementation ? implementation(fs.open, ...args) as ReturnType<typeof fs.open> : fs.open(...args);
  } };
});
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
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const receipt = join(root, "pass.json");
  const args = [f.planPath, new URL("./fixtures/manifest.v1.json", import.meta.url).pathname,
  join(root, "retained"), join(root, "archive"), receipt];
  return { args, receipt, journals, craig, writer, stdout };
}
it("independently collects all runtime sources before binding retained bytes and creating a distinct PASS", async () => {
  const { args, receipt } = await setup();
  expect(await runOssTrustedCollection(args)).toMatchObject({ kind: "oss-discord-stt-trusted-pass-v1", status: "passed" });
  expect(mocks.deployment.mock.calls.map(([input]) => input.phase)).toEqual(["before", "after"]);
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
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const publish = mocks.deployment.getMockImplementation()!;
    mocks.deployment.mockImplementation(async (input: { phase: string }) => {
      const result = await publish(input);
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
    expect(stderr.mock.calls.some(([value]) => String(value) === JSON.stringify({
      kind: "oss-collection-diagnostic-v1", stage: "publication", reason: "PUBLICATION_FAILED"
    }) + "\n")).toBe(true);
    await expect(readFile(receipt)).rejects.toThrow();
  });

it("rejects header substitution restored during admission and closes every reader", async () => {
  const { args, receipt, journals, writer } = await setup();
  const staging = join(journals, "live-native.staging.jsonl"), saved = join(root, "pinned-live");
  const header = await readFile(staging);
  writer.open().record({ type: "success" });
  await writer.settle();
  const original = await readFile(staging);
  expect(original.length).toBeGreaterThan(header.length);
  const handles: Awaited<ReturnType<typeof import("node:fs/promises").open>>[] = [];
  let swapped = false, restored = false;
  const substitute = async () => {
    await rename(staging, saved); await writeFile(staging, header); swapped = true;
  };
  mocks.open.mockImplementation(async (open: typeof import("node:fs/promises").open,
    ...input: Parameters<typeof open>) => {
    if (input[0] !== staging) { return open(...input); }
    // Old code reopens staging here and reads the attacker's header-only inode.
    if (handles.length === 1) { await substitute(); }
    const handle = await open(...input); handles.push(handle);
    const restore = async () => {
      await rm(staging); await rename(saved, staging); restored = true;
    };
    if (handles.length === 2) {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => { await close(); await restore(); });
    }
    const read = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
      // Fixed code reads its pinned descriptor while the pathname is substituted.
      if (!swapped) { await substitute(); }
      const result = await read(...readArgs);
      if (handles.length === 1) { await restore(); }
      return result;
    });
    return handle;
  });
  await expect(runOssTrustedCollection(args)).rejects.toThrow(/admission|before any native/u);
  expect(swapped).toBe(true); expect(restored).toBe(true);
  expect(await readFile(staging)).toEqual(original);
  expect(handles.every(handle => handle.fd === -1)).toBe(true);
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.assemble).not.toHaveBeenCalled();
  await expect(readFile(receipt)).rejects.toThrow();
});

it.each(["success", "failure"])("closes the pinned descriptor on %s", async outcome => {
  const { args, journals } = await setup();
  let pinned: Awaited<ReturnType<typeof import("node:fs/promises").open>> | undefined;
  mocks.open.mockImplementation(async (open: typeof import("node:fs/promises").open,
    ...input: Parameters<typeof open>) => {
    const handle = await open(...input);
    if (input[0] === join(journals, "live-native.staging.jsonl")) { pinned ??= handle; }
    return handle;
  });
  if (outcome === "failure") { mocks.snapshot.mockRejectedValue(new Error("source unavailable")); }
  if (outcome === "success") { await runOssTrustedCollection(args); }
  else { await expect(runOssTrustedCollection(args)).rejects.toThrow("source unavailable"); }
  expect(pinned).toBeDefined();
  expect(pinned!.fd).toBe(-1);
});

it.each(["growth", "truncation", "oversize", "hardlink", "symlink"])(
  "rejects live admission %s before granting custody", async attack => {
    const { args, journals, receipt } = await setup();
    const staging = join(journals, "live-native.staging.jsonl");
    if (attack === "oversize") { await truncate(staging, 1024 * 1024 + 1); }
    if (attack === "hardlink") { await link(staging, join(root, "extra-alias")); }
    if (attack === "symlink") {
      const saved = join(root, "saved-live"); await rename(staging, saved); await symlink(saved, staging);
    }
    mocks.open.mockImplementation(async (open: typeof import("node:fs/promises").open,
      ...input: Parameters<typeof open>) => {
      const handle = await open(...input);
      if (input[0] === staging && (attack === "growth" || attack === "truncation")) {
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementationOnce(async (...readArgs: Parameters<typeof handle.read>) => {
          if (attack === "truncation") { await truncate(staging, 0); }
          const result = await read(...readArgs);
          if (attack === "growth") { await appendFile(staging, '{"type":"opening"}\n'); }
          return result;
        });
      }
      return handle;
    });
    await expect(runOssTrustedCollection(args)).rejects.toThrow();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.assemble).not.toHaveBeenCalled();
    await expect(readFile(receipt)).rejects.toThrow();
  });

it.each(["deployment", "custody", "mount", "retention"] as const)(
  "classifies post-third-settled %s failure without secrets or PASS", async (check) => {
    const { args, receipt, stdout: stdoutSpy } = await setup();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const deployment = mocks.deployment.getMockImplementation()!;
    mocks.deployment.mockImplementation(async (input: { phase: string }) => {
      if (input.phase !== "after") { return deployment(input); }
      if (check === "deployment") { throw new Error("Bearer synthetic-secret"); }
      const after = await deployment(input);
      if (check === "custody") { after.config = { injected: "synthetic-secret" }; }
      if (check === "mount") { mocks.docker.mockRejectedValue(new Error("mount synthetic-secret")); }
      if (check === "retention") {
        await writeFile(join(args[2]!, "deployment-after.json"), "synthetic-secret", { flag: "wx" });
      }
      return after;
    });
    await expect(runOssTrustedCollection(args)).rejects.toThrow(
      "OSS native read-only collection failed; retain source artifacts");
    expect(stderr.mock.calls.filter(([value]) => String(value).includes("oss-trusted-collection-failed"))).toEqual([[JSON.stringify({ event: "oss-trusted-collection-failed",
      stage: "post-third-settled", check }) + "\n"]]);
    const stdout = stdoutSpy.mock.calls.map(([value]) => String(value)).join("");
    expect(stdout.match(/"status":"settled"/gu)).toHaveLength(3);
    expect(stdout).not.toContain("awaiting-seal");
    expect(JSON.stringify(stderr.mock.calls) + stdout).not.toContain("synthetic-secret");
    expect(mocks.assemble).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    await expect(readFile(receipt)).rejects.toThrow();
  });

function interceptMounts(change: (entries: ReturnType<typeof mounts>, service: string, phase: string) => unknown) {
  const docker = mocks.docker.getMockImplementation()!;
  const counts = new Map<string, number>();
  mocks.docker.mockImplementation(async (args: string[]) => {
    const raw = await docker(args) as string;
    if (args[0] !== "inspect") { return raw; }
    const service = args.at(-1)!.startsWith("a") ? "platform" : "craig";
    const count = counts.get(service) ?? 0; counts.set(service, count + 1);
    const entries = JSON.parse(raw) as ReturnType<typeof mounts>;
    entries.push({ Type: "volume", Source: "/synthetic-secret/volume", Destination: "/extra" },
      { Type: "tmpfs", Source: "", Destination: "/scratch" });
    const result = change(entries, service, count === 0 ? "before" : "after");
    return typeof result === "string" ? result : JSON.stringify(result);
  });
}

it.each([[2, 1, 0], [1, 2, 0], [0, 2, 1], [2, 0, 1], [1, 0, 2], [0, 1, 2]])(
  "accepts complete multi-mount permutation %s %s %s", async (a, b, c) => {
    const { args, receipt } = await setup();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    interceptMounts((entries, service, phase) => phase === "after"
      ? (service === "platform" ? [a, b, c] : [c, a, b]).map(index => entries[index]) : entries);
    await expect(runOssTrustedCollection(args)).resolves.toMatchObject({ status: "passed" });
    const before = await readFile(join(args[2]!, "mounts-before.json"), "utf8");
    expect(await readFile(join(args[2]!, "mounts-after.json"), "utf8")).toBe(before);
    expect(JSON.parse(before)).toEqual(["platform", "craig"].map(service => ({ service, status: "ok",
      inventory: expect.arrayContaining([expect.objectContaining({ type: "bind" }),
        expect.objectContaining({ type: "volume" }), expect.objectContaining({ type: "tmpfs" })]) as unknown })));
    expect(before).not.toContain("synthetic-secret");
    expect(before).not.toContain(root);
    expect(mocks.assemble).toHaveBeenCalledOnce();
    await expect(readFile(receipt)).resolves.toBeDefined();
  });

const mountFailures = ["source", "type", "destination", "add", "remove", "duplicate", "conflicting-duplicate",
  "json", "shape", "missing", "invalid-type", "empty-destination", "empty-source", "field-bound", "count-bound", "byte-bound", "command"] as const;
it.each(["platform", "craig"].flatMap(service => ["before", "after"].flatMap(phase =>
  mountFailures.filter(attack => phase === "after" || !["source", "type", "destination", "add", "remove"].includes(attack))
    .map(attack => ({ service, phase, attack }))))) (
  "rejects $service $phase mount $attack before seal, assembly or PASS", async ({ service, phase, attack }) => {
    const { args, receipt, stdout } = await setup();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    interceptMounts((entries, observedService, observedPhase) => {
      if (observedService !== service || observedPhase !== phase) { return entries; }
      switch (attack) {
        case "source": entries[1]!.Source += "/changed"; break;
        case "type": entries[1]!.Type = "bind"; break;
        case "destination": entries[1]!.Destination = "/changed"; break;
        case "add": entries.push({ Type: "tmpfs", Source: "", Destination: "/added" }); break;
        case "remove": entries.pop(); break;
        case "duplicate": entries.push({ ...entries[1]! }); break;
        case "conflicting-duplicate": entries.push({ ...entries[1]!, Source: "/changed" }); break;
        case "json": return "{synthetic-secret";
        case "shape": return { secret: "synthetic-secret" };
        case "missing": return [{ Type: "bind", Source: "synthetic-secret" }];
        case "invalid-type": entries[1]!.Type = "synthetic-secret"; break;
        case "empty-destination": entries[1]!.Destination = ""; break;
        case "empty-source": entries[1]!.Source = ""; break;
        case "field-bound": entries[1]!.Source = "s".repeat(4097); break;
        case "count-bound": return Array.from({ length: 257 }, (_, index) => ({ Type: "tmpfs", Source: "", Destination: `/mount-${index}` }));
        case "byte-bound": return " ".repeat(1024 * 1024 + 1);
        case "command": throw new Error("Bearer synthetic-secret");
      }
      return entries;
    });
    await expect(runOssTrustedCollection(args)).rejects.toThrow(/retain/u);
    const events = stderr.mock.calls.map(([value]) => JSON.parse(String(value)) as {
      event: string; phase: string; services: { service: string; status: string; inventory: unknown }[];
    });
    const observation = events.find(event => event.event === "oss-trusted-mount-observations" && event.phase === phase)!;
    const status = attack === "command" ? "command" : attack.includes("duplicate") ? "duplicate-destination"
      : ["source", "type", "destination", "add", "remove"].includes(attack) ? "tuple-mismatch" : "parse";
    expect(observation.services).toHaveLength(2);
    expect(observation.services.find(item => item.service === service)!.status).toBe(status);
    expect(observation.services.find(item => item.service !== service)!.status).toBe("ok");
    if (status === "command" || status === "parse") {
      expect(observation.services.find(item => item.service === service)!.inventory).toBeNull();
    }
    if (phase === "after") {
      expect(JSON.parse(await readFile(join(args[2]!, "mounts-after.json"), "utf8"))).toEqual(observation.services);
      expect(JSON.parse(await readFile(join(args[2]!, "mounts-before.json"), "utf8"))).toHaveLength(2);
    } else { expect(mocks.snapshot).not.toHaveBeenCalled(); }
    expect(JSON.stringify(stderr.mock.calls)).not.toContain("synthetic-secret");
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(root);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("awaiting-seal");
    expect(mocks.assemble).not.toHaveBeenCalled(); expect(mocks.verify).not.toHaveBeenCalled();
    await expect(readFile(join(args[2]!, "assembly.json"))).rejects.toThrow();
    await expect(readFile(receipt)).rejects.toThrow();
  });

it.each(["prefix", "assembly"])("exposes safe postseal %s failure and never writes PASS", async stage => {
  const { args, receipt, journals } = await setup();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  if (stage === "assembly") { mocks.assemble.mockRejectedValue(new Error("https://synthetic.invalid/SYNTHETIC_SECRET_TOKEN")); }
  else {
    const publish = mocks.deployment.getMockImplementation()!;
    mocks.deployment.mockImplementation(async input => {
      const result = await publish(input);
      if (input.phase === "after") { await writeFile(join(journals, "post-call-native.jsonl"), "SYNTHETIC_SECRET_TOKEN\n"); }
      return result;
    });
  }
  await expect(runOssTrustedCollection(args)).rejects.toThrow();
  const diagnostics = stderr.mock.calls.map(([value]) => String(value)).filter(value => value.includes("oss-collection-diagnostic-v1"));
  expect(diagnostics).toEqual([JSON.stringify({ kind: "oss-collection-diagnostic-v1", stage,
    reason: stage === "prefix" ? "PREFIX_MISMATCH" : "ASSEMBLY_FAILED" }) + "\n"]);
  expect(JSON.stringify(stderr.mock.calls)).not.toContain("SYNTHETIC_SECRET_TOKEN");
  await expect(readFile(receipt)).rejects.toThrow();
});
