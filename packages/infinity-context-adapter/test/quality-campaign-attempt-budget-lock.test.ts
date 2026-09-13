import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rename, stat, writeFile, type FileHandle } from
  "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { claimDurableAttemptBudget, loadAdmittedAttemptBudgetClaims } from
  "../src/quality-campaign/attempt-budget-ledger.js";
import type { AttemptIdentity, SpendReservation } from
  "../src/quality-campaign/execution.js";

const ledgerName = "budget.jsonl", identityName = "budget.identity.jsonl";
const sourceUrl = new URL("../src/quality-campaign/attempt-budget-ledger.ts", import.meta.url).href;
const tsxLoaderPath = import.meta.resolve("tsx/esm");
const digest = (value: string) => value.repeat(64);
const spend = Object.freeze({ allowedCallKinds: ["answer"] as const, campaignRootSha256: digest("a"),
  expiresAtEpochMs: 10_000, maxCalls: 20, maxCallsByKind: { adjudicator_1: 0,
    adjudicator_2: 0, answer: 20, capability: 0, resolver: 0, retrieval: 0 },
  maxEncryptedBytes: 20, maximumEffectDurationMs: 1_000, maxTokens: 20,
  model: "gpt-5.6-sol", provider: "test", reasoning: "medium",
  releaseRootSha256: digest("b"), repetition: 1, serviceTier: "default" }) satisfies
  SpendReservation;

function attempt(ordinal: number): AttemptIdentity {
  return { attemptId: `attempt-${ordinal}`, callKind: "answer", callOrdinal: ordinal,
    campaignRootSha256: spend.campaignRootSha256, questionDigestSha256: digest("c"),
    questionId: `question-${ordinal}`, releaseRootSha256: spend.releaseRootSha256, repetition: 1,
    spendReservationSha256: digest("d") };
}

async function claim(directory: FileHandle, ordinal: number, budget: SpendReservation = spend) {
  return await claimDurableAttemptBudget({ admissionId: `admission-${ordinal}`, directory,
    identity: attempt(ordinal), identityDirectory: directory, identityName, ledgerName,
    requestDigestSha256: digest("e"), requestedEncryptedBytes: 1, requestedTokens: 1,
    spend: budget });
}

async function root() {
  const path = await mkdtemp(join(tmpdir(), "quality-budget-lock-"));
  return { directory: await open(path, constants.O_RDONLY | constants.O_DIRECTORY |
    constants.O_NOFOLLOW), path };
}

interface ChildMessage { readonly error?: string; readonly state: "locked" |
  "lock_identity_temporary_synced" | "ready" | "result" }

function messages(child: ChildProcess) {
  const queued: ChildMessage[] = []; const waiters: ((value: ChildMessage) => void)[] = [];
  child.on("message", (value) => {
    const message = value as ChildMessage; const waiter = waiters.shift();
    if (waiter === undefined) {queued.push(message);} else {waiter(message);}
  });
  return () => queued.length > 0 ? Promise.resolve(queued.shift()!) :
    new Promise<ChildMessage>((resolve) => {waiters.push(resolve);});
}

async function writeHolder(path: string) {
  const childPath = join(path, "holder.mjs");
  await writeFile(childPath, `import {spawn} from "node:child_process";
import {constants} from "node:fs";import {open} from "node:fs/promises";
const handle=await open(process.argv[2],constants.O_RDWR|constants.O_NOFOLLOW);
const flock=spawn("/usr/bin/flock",["--exclusive","3"],
  {shell:false,stdio:["ignore","ignore","ignore",handle.fd]});
const code=await new Promise((resolve,reject)=>{flock.once("error",reject);flock.once("close",resolve)});
if(code!==0)throw new Error("holder flock failed");process.send({state:"locked"});
await new Promise(resolve=>process.once("message",resolve));await handle.close();process.disconnect();\n`);
  return childPath;
}

async function writeClaimant(path: string, pauseAfterFirstSync = false) {
  const childPath = join(path, "claimant.mjs"), configPath = join(path, "claimant.json");
  await writeFile(configPath, JSON.stringify({ identityName, ledgerName, sourceUrl, spend }));
  await writeFile(childPath, `import {constants} from "node:fs";import {open,readFile} from "node:fs/promises";
const c=JSON.parse(await readFile(process.argv[2],"utf8"));
${pauseAfterFirstSync ? `const probe=await open(process.argv[1],constants.O_RDONLY);
const handles=Object.getPrototypeOf(probe);await probe.close();const originalSync=handles.sync;
let paused=false;handles.sync=async function(){await originalSync.call(this);if(!paused){paused=true;
process.send({state:"lock_identity_temporary_synced"});await new Promise(resolve=>process.once("message",resolve));}};` : ""}
const api=await import(c.sourceUrl);
const directory=await open(process.argv[3],constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
process.send({state:"ready"});try{const value=await api.claimDurableAttemptBudget({
admissionId:"admission-2",directory,identity:{attemptId:"attempt-2",callKind:"answer",callOrdinal:2,
campaignRootSha256:c.spend.campaignRootSha256,questionDigestSha256:"${digest("c")}",
questionId:"question-2",releaseRootSha256:c.spend.releaseRootSha256,repetition:1,
spendReservationSha256:"${digest("d")}"},identityDirectory:directory,identityName:c.identityName,
ledgerName:c.ledgerName,requestDigestSha256:"${digest("e")}",requestedEncryptedBytes:1,
requestedTokens:1,spend:c.spend});process.send({state:"result",value});}
catch(error){process.send({error:String(error),state:"result"});}finally{await directory.close();process.disconnect();}\n`);
  return { childPath, configPath };
}

function fork(script: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", tsxLoaderPath, script, ...args],
    { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  return { child, take: messages(child) };
}

async function closed(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {return;}
  await new Promise<void>((resolve) => {child.once("close", () => {resolve();});});
}

it("keeps two processes serialized behind a deliberately slow live holder", async () => {
  const state = await root();
  try {
    expect((await claim(state.directory, 1)).admitted).toBe(true);
    const lockPath = join(state.path, `.${ledgerName}.lock`);
    const holder = fork(await writeHolder(state.path), [lockPath]);
    expect((await holder.take()).state).toBe("locked");
    const claimantFiles = await writeClaimant(state.path);
    const claimant = fork(claimantFiles.childPath, [claimantFiles.configPath, state.path]);
    expect((await claimant.take()).state).toBe("ready");
    const result = claimant.take();
    expect(await Promise.race([result.then(() => "finished"),
      new Promise<string>((resolve) => {setTimeout(() => {resolve("waiting");}, 300);})]))
      .toBe("waiting");
    holder.child.send({ release: true });
    expect((await result).error).toBeUndefined();
    await Promise.all([closed(holder.child), closed(claimant.child)]);
  } finally {await state.directory.close();}
}, 15_000);

it("releases the inherited flock when a synchronized holder is SIGKILLed", async () => {
  const state = await root();
  try {
    expect((await claim(state.directory, 1)).admitted).toBe(true);
    const holder = fork(await writeHolder(state.path), [join(state.path, `.${ledgerName}.lock`)]);
    expect((await holder.take()).state).toBe("locked");
    holder.child.kill("SIGKILL");
    await new Promise<void>((resolve) => {holder.child.once("close", () => {resolve();});});
    expect((await claim(state.directory, 2)).admitted).toBe(true);
    expect(await loadAdmittedAttemptBudgetClaims({ campaignRootSha256:
      spend.campaignRootSha256, directory: state.directory, identityDirectory: state.directory,
    identityName, ledgerName, spend, spendReservationSha256: digest("d") })).toHaveLength(2);
  } finally {await state.directory.close();}
}, 15_000);

it("publishes no partial final identity when initialization is SIGKILLed", async () => {
  const state = await root();
  try {
    const claimantFiles = await writeClaimant(state.path, true);
    const claimant = fork(claimantFiles.childPath, [claimantFiles.configPath, state.path]);
    expect((await claimant.take()).state).toBe("ready");
    expect((await claimant.take()).state).toBe("lock_identity_temporary_synced");
    const lockPath = join(state.path, `.${ledgerName}.lock`);
    const before = await stat(lockPath);
    claimant.child.kill("SIGKILL"); await closed(claimant.child);
    await expect(readFile(`${lockPath}.identity`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await claim(state.directory, 1)).admitted).toBe(true);
    const after = await stat(lockPath);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
  } finally {await state.directory.close();}
}, 15_000);

it("ignores the retired lock-identity pause environment variable while IPC is available", async () => {
  const state = await root();
  let claimant: ReturnType<typeof fork> | undefined;
  try {
    const claimantFiles = await writeClaimant(state.path);
    claimant = fork(claimantFiles.childPath, [claimantFiles.configPath, state.path],
      { DISCORD_MEETING_TEST_PAUSE_LOCK_IDENTITY_AFTER_SYNC: "1" });
    expect((await claimant.take()).state).toBe("ready");
    const result = await claimant.take();
    expect(result.state).toBe("result"); expect(result.error).toBeUndefined();
    await closed(claimant.child);
  } finally {
    claimant?.child.kill("SIGKILL"); await state.directory.close();
  }
}, 15_000);

it("fails closed if lock replacement would split cooperating writers", async () => {
  const state = await root();
  try {
    await claim(state.directory, 1); const lockPath = join(state.path, `.${ledgerName}.lock`);
    const holder = fork(await writeHolder(state.path), [lockPath]);
    expect((await holder.take()).state).toBe("locked");
    await rename(lockPath, `${lockPath}.retained`); await writeFile(lockPath, "", { mode: 0o600 });
    const claimantFiles = await writeClaimant(state.path);
    const claimant = fork(claimantFiles.childPath, [claimantFiles.configPath, state.path]);
    expect((await claimant.take()).state).toBe("ready");
    expect((await claimant.take()).error).toMatch(/budget ledger lock was replaced/u);
    holder.child.send({ release: true });
    expect(await readFile(join(state.path, ledgerName), "utf8")).toContain("attempt-1");
    expect(await readFile(join(state.path, ledgerName), "utf8")).not.toContain("attempt-2");
    await Promise.all([closed(holder.child), closed(claimant.child)]);
  } finally {await state.directory.close();}
}, 15_000);

it("retains fail-closed ledger identity and truncation checks", async () => {
  for (const poison of ["identity", "truncation"] as const) {
    const state = await root();
    try {
      await claim(state.directory, 1);
      await writeFile(join(state.path, poison === "identity" ? identityName : ledgerName),
        poison === "identity" ? "{}\n" : "");
      await expect(claim(state.directory, 2)).rejects.toThrow(/replaced or truncated/u);
      await expect(loadAdmittedAttemptBudgetClaims({ campaignRootSha256:
        spend.campaignRootSha256, directory: state.directory, identityDirectory: state.directory,
      identityName, ledgerName, spend, spendReservationSha256: digest("d") }))
        .rejects.toThrow(/replaced or truncated|disappeared/u);
    } finally {await state.directory.close();}
  }
}, 15_000);

it("rejects an oversized lock identity before appending a claim", async () => {
  const state = await root();
  try {
    await claim(state.directory, 1);
    const ledgerBefore = await readFile(join(state.path, ledgerName));
    await writeFile(join(state.path, `.${ledgerName}.lock.identity`), Buffer.alloc(64 * 1024 + 1));
    await expect(claim(state.directory, 2)).rejects.toThrow(/lock identity exceeds its byte limit/u);
    expect(await readFile(join(state.path, ledgerName))).toEqual(ledgerBefore);
  } finally {await state.directory.close();}
}, 15_000);

it("fails closed on a preexisting corrupt final lock identity", async () => {
  const state = await root();
  try {
    await claim(state.directory, 1);
    const ledgerBefore = await readFile(join(state.path, ledgerName));
    await writeFile(join(state.path, `.${ledgerName}.lock.identity`), "{}", { mode: 0o600 });
    await expect(claim(state.directory, 2)).rejects.toThrow(/lock was replaced/u);
    expect(await readFile(join(state.path, ledgerName))).toEqual(ledgerBefore);
  } finally {await state.directory.close();}
}, 15_000);

it("accepts another authorized claim after the append-chain identity exceeds 64 KiB", async () => {
  const state = await root();
  try {
    const campaignSpend = Object.freeze({ ...spend, maxCalls: 400, maxEncryptedBytes: 400,
      maxTokens: 400, maxCallsByKind: { ...spend.maxCallsByKind, answer: 400 } });
    let ordinal = 1;
    while ((await stat(join(state.path, identityName)).catch(() => ({ size: 0 }))).size <=
      64 * 1024) {
      expect((await claim(state.directory, ordinal, campaignSpend)).admitted).toBe(true);
      ordinal += 1;
    }
    expect((await claim(state.directory, ordinal, campaignSpend)).admitted).toBe(true);
    expect((await stat(join(state.path, identityName))).size).toBeGreaterThan(64 * 1024);
  } finally {await state.directory.close();}
}, 30_000);

it("rejects an append-chain identity above its 64 MiB cap before appending a claim", async () => {
  const state = await root();
  try {
    await claim(state.directory, 1);
    const ledgerBefore = await readFile(join(state.path, ledgerName));
    const identity = await open(join(state.path, identityName), constants.O_WRONLY);
    try {await identity.truncate(64 * 1024 * 1024 + 1);} finally {await identity.close();}
    await expect(claim(state.directory, 2)).rejects.toThrow(/ledger identity exceeds its byte limit/u);
    expect(await readFile(join(state.path, ledgerName))).toEqual(ledgerBefore);
  } finally {await state.directory.close();}
}, 15_000);
