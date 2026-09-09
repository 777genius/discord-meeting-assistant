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
const worker = fileURLToPath(new URL("./fixtures/live-stt-crash-worker.ts", import.meta.url));
// Native TypeScript subprocesses need only local .js -> .ts source resolution.
const loader = `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js')) {
    try { return next(specifier, context); } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return next(specifier.slice(0,-3)+'.ts', context);
    }
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
  { scenario: "pending", barrier: "pending", accepted: 1, opens: 1, fenced: false },
  { scenario: "open-before", barrier: "open-before", accepted: 0, opens: 0, fenced: true },
  { scenario: "open-after", barrier: "open-after", accepted: 0, opens: 1, fenced: true },
  { scenario: "before-send", barrier: "before-send", accepted: 0, opens: 1, fenced: true },
  { scenario: "after-accept", barrier: "after-accept", accepted: 1, opens: 1, fenced: true },
  { scenario: "terminal", barrier: "terminal", accepted: 1, opens: 1, fenced: true },
  { scenario: "accepted-unfinalized", barrier: "accepted-unfinalized", accepted: 1, opens: 1, fenced: true },
  { scenario: "finalize-before", barrier: "finalize-before", accepted: 1, opens: 1, fenced: true },
  { scenario: "finalize-after", barrier: "finalize-after", accepted: 1, opens: 1, fenced: true },
  { scenario: "finalized", barrier: "finalized", accepted: 2, opens: 2, fenced: false },
  { scenario: "not-accepted", barrier: "not-accepted", accepted: 1, opens: 2, fenced: false },
  { scenario: "closed", barrier: "closed", accepted: 1, opens: 1, fenced: false },
  { scenario: "legacy", barrier: "pending", accepted: 0, opens: 0, fenced: false },
];
for (const row of cases) {
  it(`survives a separate process killed at ${row.scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "durable-stt-crash-"));
    const effects: Effects = { messages: [], accepted: 0, openings: 0, finalizations: 0 };
    const original = Buffer.from("synthetic original recording must survive derived STT");
    const checksum = createHash("sha256").update(original).digest("hex");
    try {
      await writeFile(join(root, "resolve.mjs"), loader);
      await writeFile(join(root, "original.ogg"), original);
      await child(root, "first", row.scenario, row.barrier, effects);
      // The owner is now authoritatively dead (exit/SIGKILL observed). Stop-first
      // recovery removes its local marker; production never guesses from a PID.
      if (row.scenario === "before-send") {
        await assert.rejects(child(root, "restart", row.scenario, undefined, effects), /already owned/);
      }
      await rm(join(root, "owner-v1.lock"));
      await rm(join(root, "live-delivery-cache-v1"), { recursive: true, force: true });
      const firstMessages = effects.messages.length;
      const firstFinalizations = effects.finalizations;
      await child(root, "restart", row.scenario, undefined, effects);
      assert.equal(effects.accepted, row.accepted);
      assert.equal(effects.openings, row.opens);
      if (row.fenced) { assert.equal(effects.finalizations, firstFinalizations); }
      const restart = effects.messages.slice(firstMessages);
      const recovery = restart.find((message) => message.type === "recovery")!.detail as {
        owner: { epoch: number }; fences: { reason: string }[]; closed: boolean; pending: string[];
      };
      assert.equal(recovery.fences.some((fence) => fence.reason === "acceptance-unknown"), row.fenced);
      const repeated = restart.find((message) => message.type === "repeat-recovery")!.detail as { owner: unknown };
      assert.deepEqual(repeated.owner, recovery.owner);
      if (row.scenario === "after-accept" || row.scenario === "terminal") { assert.equal(recovery.pending.length, 1); }
      if (row.scenario === "accepted-unfinalized" || row.scenario === "finalized") { assert.equal(recovery.pending.length, 0); }
      if (row.scenario === "closed") { assert.equal(recovery.closed, true); }
      if (row.scenario === "legacy") {
        assert.deepEqual(restart.find((message) => message.type === "denied")!.detail, { status: "fenced", reason: "legacy-unknown" });
      }
      if (row.scenario === "finalized") {
        const generations = effects.messages.filter((message) => message.type === "open-effect")
          .map((message) => (message.detail as { generation: number }).generation);
        assert.deepEqual(generations, [1, 2]);
      }
      assert.equal(createHash("sha256").update(await readFile(join(root, "original.ogg"))).digest("hex"), checksum);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
