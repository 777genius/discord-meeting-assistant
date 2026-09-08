import { compileOggOpus } from "@discord-meeting/recording-ingress-adapter";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

interface Message { id?: number; type: string; detail?: unknown }
interface Effects { messages: Message[]; accepted: number; openings: number; finalizations: number }
const worker = fileURLToPath(new URL("./fixtures/live-runtime-crash-worker.ts", import.meta.url));
// Native TypeScript subprocesses need only local .js -> .ts source resolution.
const sourceRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const loader = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try { return next(specifier, context); } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return next(specifier.slice(0,-3)+'.ts', context);
    }
  }
  if (specifier.startsWith('@discord-meeting/meeting-core/')) {
    return next(${JSON.stringify(sourceRoot)} + 'packages/meeting-core/src/features/' + specifier.split('/').at(-1) + '/index.ts', context);
  }
  if (specifier === '@discord-meeting/recording-ingress-adapter') {
    return next(${JSON.stringify(sourceRoot)} + 'packages/recording-ingress-adapter/src/index.ts', context);
  }
  return next(specifier, context);
}});`;

async function child(root: string, phase: string, scenario: string, killAt: string | undefined, effects: Effects): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const process: ChildProcess = fork(worker, [root, phase, scenario], {
      execArgv: ["--experimental-transform-types", "--import", join(root, "resolve.mjs")],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: globalThis.process.env.PATH, NODE_NO_WARNINGS: "1" },
    });
    let killed = false;
    let failure = "";
    let stderr = "";
    const timer = setTimeout(() => { failure = "synthetic worker deadline"; process.kill("SIGKILL"); }, 15_000);
    process.stderr?.on("data", (bytes: Buffer) => { stderr += bytes.toString(); });
    process.on("error", reject);
    process.on("message", (message: Message) => {
      effects.messages.push(message);
      if (message.type === "accepted-effect") { effects.accepted += 1; }
      if (message.type === "open-effect") { effects.openings += 1; }
      if (message.type === "finalize-effect") { effects.finalizations += 1; }
      if (message.type === "failed") { failure = String(message.detail); }
      if (message.type === killAt) { killed = true; process.kill("SIGKILL"); }
      else if (message.id !== undefined) { process.send({ ack: message.id }); }
    });
    process.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (failure || (killAt === undefined ? code !== 0 : !killed || signal !== "SIGKILL")) {
        reject(new Error(failure || `worker exit ${code}/${signal}: ${stderr}`));
      } else { resolve(); }
    });
  });
}
const cases = [
  { scenario: "authoritative", barrier: "before-accepted", accepted: 1, opens: 1 },
  { scenario: "pending", barrier: "pending", accepted: 1, opens: 1 },
  { scenario: "open-before", barrier: "open-intent", accepted: 0, opens: 0 },
  { scenario: "open-after", barrier: "before-opened", accepted: 0, opens: 1 },
  { scenario: "before-send", barrier: "send-intent", accepted: 0, opens: 1 },
  { scenario: "after-accept", barrier: "before-accepted", accepted: 1, opens: 1 },
  { scenario: "terminal", barrier: "before-provider-terminal", accepted: 1, opens: 1 },
  { scenario: "accepted-unfinalized", barrier: "durable-accepted", accepted: 1, opens: 1 },
  { scenario: "finalize-before", barrier: "finalize-intent", accepted: 1, opens: 1 },
  { scenario: "finalize-after", barrier: "before-finalized", accepted: 1, opens: 1 },
  { scenario: "finalized", barrier: "durable-finalized", accepted: 2, opens: 2 },
  { scenario: "not-accepted", barrier: "durable-not-accepted", accepted: 1, opens: 2 },
  { scenario: "legacy", barrier: "pending", accepted: 0, opens: 0 },
];
for (const row of cases) {
  it(`Platform rebuilds durable STT after process death at ${row.scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "platform-stt-crash-"));
    const effects: Effects = { messages: [], accepted: 0, openings: 0, finalizations: 0 };
    const original = compileOggOpus("r", "33333333333333333", [{ opus: Uint8Array.of(0xf8, 0xff, 0xfe),
      receivedAtMs: 0, relativeTimeMs: 0, rtpSequence: 0, rtpTimestamp: 0 }]).bytes;
    const checksum = createHash("sha256").update(original).digest("hex");
    try {
      await writeFile(join(root, "resolve.mjs"), loader);
      await writeFile(join(root, "original.ogg"), original);
      await child(root, "first", row.scenario, row.barrier, effects);
      await rm(join(root, "owner-v1.lock"));
      await rm(join(root, "live-delivery-cache-v1"), { recursive: true, force: true });
      const before = effects.messages.length;
      const finalizes = effects.finalizations;
      await child(root, "restart", row.scenario, undefined, effects);
      assert.equal(effects.accepted, row.accepted);
      assert.equal(effects.openings, row.opens);
      const recovered = effects.messages.slice(before);
      const recovery = recovered.find((message) => message.type === "recovery")!.detail as {
        fences: { reason: string }[]; legacy: boolean;
      };
      const eligible = ["pending", "not-accepted", "finalized"].includes(row.scenario);
      if (!eligible && row.scenario !== "legacy") {
        assert.deepEqual(recovery.fences, [{ speakerId: "33333333333333333", reason: "acceptance-unknown" }]);
        assert.ok(recovered.some((message) => message.type === "degraded"));
        assert.equal(effects.finalizations, finalizes);
        assert.ok(recovered.some((message) => message.type === "release-degraded"));
      }
      if (row.scenario === "legacy") { assert.equal(recovery.legacy, true); }
      if (row.scenario === "authoritative") {
        const snapshot = JSON.parse(await readFile(join(root, "meeting.json"), "utf8")) as { actors: unknown };
        assert.deepEqual(snapshot.actors, [{ actorId: "33333333333333333", kind: "unknown" }]);
        assert.equal(effects.messages.filter((message) => message.type === "batch-effect").length, 1);
        assert.equal(effects.messages.filter((message) => message.type === "publication-effect").length, 1);
        assert.equal((recovered.find((message) => message.type === "authoritative-recovered")!.detail as { checksum: string }).checksum, checksum);
      }
      if (row.scenario === "finalized") {
        const keys = effects.messages.filter((message) => message.type === "open-effect").map((message) => message.detail);
        assert.deepEqual(keys, [JSON.stringify(["live-transcription:v4", "r", "33333333333333333", 1]), JSON.stringify(["live-transcription:v4", "r", "33333333333333333", 2])]);
      }
      if (row.scenario === "after-accept" || row.scenario === "terminal") {
        assert.deepEqual(recovered.find((message) => message.type === "pending-after")!.detail, ["r:33333333333333333:0:0:0"]);
      }
      assert.equal(createHash("sha256").update(await readFile(join(root, "original.ogg"))).digest("hex"), checksum);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
