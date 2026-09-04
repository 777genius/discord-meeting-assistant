import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { attemptIdentity, canonicalJson, DurableAttemptJournal, executeReservedExchange,
  FROZEN_ANSWER_EXECUTION, publicKeyFingerprintSha256, QUALITY_AUTHORITY_ROLES,
  QualityCampaignAuthorityPolicy, sha256,
  verifySpendReservation } from "../src/quality-campaign/index.js";
import { qualificationProviderAccountingFixture } from
  "./quality-campaign-provider-accounting-fixture.js";
import { ProductionCheckpointStore } from
  "../src/quality-campaign/production-checkpoints.js";

const digest = (value: string) => value.repeat(64);
const campaignRootSha256 = digest("1"), provider = "pinned-provider";
const tsxLoaderPath = import.meta.resolve("tsx/esm");

function fixture() {
  const signers = Object.fromEntries(QUALITY_AUTHORITY_ROLES.map((role) => {
    const keys = generateKeyPairSync("ed25519"); const keyId = `${role}-key`;
    const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    return [role, { keyId, publicKeyPem, signed: <T>(payload: T) => ({ payload,
      signatureBase64: sign(null, Buffer.from(canonicalJson(payload)), keys.privateKey)
        .toString("base64"), signerKeyId: keyId }) }];
  })) as Record<typeof QUALITY_AUTHORITY_ROLES[number], { readonly keyId: string;
    readonly publicKeyPem: string; signed(payload: unknown): unknown }>;
  const pins = Object.fromEntries(QUALITY_AUTHORITY_ROLES.map((role) => [role, {
    keyId: signers[role].keyId, publicKeyFingerprintSha256:
      publicKeyFingerprintSha256(signers[role].publicKeyPem, role),
    publicKeyPem: signers[role].publicKeyPem }]));
  const policy = new QualityCampaignAuthorityPolicy(pins as never);
  const releasePayload = { answerImageSha256: digest("1"), answerProcessIdentitySha256: digest("2"),
    answerReleaseSha256: digest("3"), artifactKeyCustodySha256:
    policy.authority("artifact_custody").publicKeyFingerprintSha256,
  authorityPolicySha256: policy.bindingSha256, discordCommitSha256: digest("4"),
  discordImageSha256: digest("5"), discordReleaseSha256: digest("6"),
  infinityCapabilitySha256: digest("7"), infinityCommitSha256: digest("8"),
  infinityImageSha256: digest("9"), infinityProfileSha256: digest("a"),
  infinityReleaseSha256: digest("b"), mapperSha256: digest("c"), ...FROZEN_ANSWER_EXECUTION,
  policySha256: digest("d"), promptSha256: digest("e"), sdkArchiveSha256: digest("f"),
  targetInventoryAuthorityKeySha256: policy.authority("inventory").publicKeyFingerprintSha256,
  tokenizerSha256: digest("0") };
  const document = signers.release.signed(releasePayload);
  const releaseRootSha256 = sha256(document); const release = { authorityKeyId:
    signers.release.keyId, document, releaseRootSha256 };
  const makeSpend = (overrides: Record<string, unknown>) => signers.spend.signed({
    allowedCallKinds: ["answer"], campaignRootSha256, expiresAtEpochMs: 10_000, maxCalls: 2,
    maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0, answer: 2, capability: 0,
      resolver: 0, retrieval: 0 }, maxEncryptedBytes: 2, maximumEffectDurationMs: 1_000,
    maxTokens: 2, ...FROZEN_ANSWER_EXECUTION, provider, releaseRootSha256, repetition: 1,
    ...overrides });
  return { makeSpend, pins, policy, release, releasePayload, releaseRootSha256, signers };
}

function identity(releaseRootSha256: string, spendReservationSha256: string, questionId: string) {
  return attemptIdentity({ callKind: "answer", callOrdinal: 0, campaignRootSha256,
    questionDigestSha256: sha256(questionId), questionId, releaseRootSha256, repetition: 1,
    spendReservationSha256 });
}

interface ChildMessage { readonly state?: string; readonly type: "effect" | "exit" | "ready" |
  "result" }

function controlledChild(child: ChildProcess) {
  const queued: ChildMessage[] = []; const waiters = new Map<ChildMessage["type"],
    ((message: ChildMessage) => void)[]>();
  const publish = (message: ChildMessage) => {
    const waiter = waiters.get(message.type)?.shift();
    if (waiter === undefined) {queued.push(message);} else {waiter(message);}
  };
  child.on("message", (message) => {publish(message as ChildMessage);});
  child.on("exit", () => {publish({ type: "exit" });});
  return { child, take(type: ChildMessage["type"]): Promise<ChildMessage> {
    const index = queued.findIndex((message) => message.type === type);
    if (index >= 0) {return Promise.resolve(queued.splice(index, 1)[0]!);}
    return new Promise((resolve) => {
      const values = waiters.get(type) ?? []; values.push(resolve); waiters.set(type, values);
    });
  } };
}

it("admits one same-attempt exchange across two process-barrier participants", async () => {
  const value = fixture(); const spendReservation = value.makeSpend({ maxCalls: 1,
    maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0, answer: 1, capability: 0,
      resolver: 0, retrieval: 0 } });
  const attempt = identity(value.releaseRootSha256, sha256(spendReservation), "same-question");
  const directory = await mkdtemp(join(tmpdir(), "quality-two-process-"));
  const callsPath = join(directory, "provider-calls.txt"), childPath = join(directory,
    "race-child.mjs"), configPath = join(directory, "config.json");
  await writeFile(configPath, canonicalJson({ attempt, authorityPins: value.pins, callsPath,
    campaignRootSha256, deadlineEpochMs: 1_500, journalRoot: join(directory, "journal"),
    provider, release: value.release,
    sourceUrl: new URL("../src/quality-campaign/index.ts", import.meta.url).href,
    spendReservation }));
  await writeFile(childPath, `import { appendFile, readFile } from "node:fs/promises";
const c=JSON.parse(await readFile(process.argv[2],"utf8")); const api=await import(c.sourceUrl);
const policy=new api.QualityCampaignAuthorityPolicy(c.authorityPins);
process.send({type:"ready"}); await new Promise(resolve=>process.once("message",resolve));
const journal=new api.DurableAttemptJournal(c.journalRoot,policy);
const state=await api.executeReservedExchange({campaignRootSha256:c.campaignRootSha256,
deadlineEpochMs:c.deadlineEpochMs,effectReservation:{requestedEncryptedBytes:1,requestedTokens:1},
identity:c.attempt,journal,nowEpochMs:1000,
port:{exchange:async()=>{await appendFile(c.callsPath,"call\\n");process.send({type:"effect"});
await new Promise(resolve=>process.once("message",resolve));return {effect:"unknown"};}},
provider:c.provider,release:c.release,request:Buffer.from(c.attempt.questionId),
signal:new AbortController().signal,spendReservation:c.spendReservation});
await journal.close();
process.send({state,type:"result"});process.disconnect();\n`);
  const participants = [0, 1].map(() => controlledChild(spawn(process.execPath,
    ["--import", tsxLoaderPath, childPath, configPath],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] })));
  await Promise.all(participants.map((participant) => participant.take("ready")));
  for (const participant of participants) {participant.child.send({ type: "start" });}
  const winner = await Promise.race(participants.map(async (participant) => {
    await participant.take("effect"); return participant;
  }));
  const loser = participants.find((participant) => participant !== winner)!;
  expect((await loser.take("result")).state).toBe("outcome_unknown");
  winner.child.send({ type: "release" });
  expect((await winner.take("result")).state).toBe("outcome_unknown");
  await Promise.all(participants.map((participant) => participant.take("exit")));
  expect((await readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(1);
}, 60_000);

it("publishes complete identical reservations across 64 same-process barrier races", async () => {
  const value = fixture();
  const spendReservation = value.makeSpend({ maxCalls: 1, maxCallsByKind: {
    adjudicator_1: 0, adjudicator_2: 0, answer: 1, capability: 0, resolver: 0, retrieval: 0 } });
  const attempt = identity(value.releaseRootSha256, sha256(spendReservation), "repeated-question");
  for (let run = 0; run < 64; run += 1) {
    const root = await mkdtemp(join(tmpdir(), "quality-same-process-"));
    let readyCount = 0; let providerCalls = 0;
    let releaseStart!: () => void; let releaseProvider!: () => void;
    let reportReady!: () => void; let reportProvider!: () => void;
    const start = new Promise<void>((resolve) => {releaseStart = resolve;});
    const ready = new Promise<void>((resolve) => {reportReady = resolve;});
    const providerEntered = new Promise<void>((resolve) => {reportProvider = resolve;});
    const providerRelease = new Promise<void>((resolve) => {releaseProvider = resolve;});
    const participate = async () => {
      readyCount += 1; if (readyCount === 2) {reportReady();} await start;
      const journal = new DurableAttemptJournal(root, value.policy);
      try {return await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
        effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: attempt,
        journal, nowEpochMs: 1_000,
        port: { exchange: async () => {providerCalls += 1; reportProvider();
          await providerRelease; return { effect: "unknown" as const };} }, provider,
        release: value.release, request: Buffer.from(attempt.questionId),
        signal: new AbortController().signal, spendReservation });}
      finally {await journal.close();}
    };
    const participants = [participate(), participate()];
    await ready; releaseStart(); await providerEntered;
    expect(await Promise.race(participants)).toBe("outcome_unknown");
    releaseProvider();
    expect(await Promise.all(participants)).toEqual(["outcome_unknown", "outcome_unknown"]);
    expect(providerCalls).toBe(1);
    const reservation = JSON.parse(await readFile(join(root,
      `${attempt.attemptId}.reserved.json`), "utf8")) as { readonly state: string };
    expect(reservation.state).toBe("provider_reserved");
  }
}, 60_000);

it("ignores a crash-left unpublished temp reservation", async () => {
  const value = fixture(); const spendReservation = value.makeSpend({ maxCalls: 1,
    maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0, answer: 1, capability: 0,
      resolver: 0, retrieval: 0 } });
  const attempt = identity(value.releaseRootSha256, sha256(spendReservation), "stale-temp-question");
  const root = await mkdtemp(join(tmpdir(), "quality-stale-temp-"));
  await writeFile(join(root, `.${attempt.attemptId}.reserved.json.` +
    "00000000-0000-4000-8000-000000000000.tmp"), "partial");
  const journal = new DurableAttemptJournal(root, value.policy);
  const state = await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
    effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: attempt,
    journal, nowEpochMs: 1_000,
    port: { exchange: async () => ({ effect: "unknown" as const }) }, provider,
    release: value.release, request: Buffer.from(attempt.questionId),
    signal: new AbortController().signal, spendReservation });
  expect(state).toBe("outcome_unknown");
  expect(await readdir(root)).toContain(`${attempt.attemptId}.reserved.json`);
  await journal.close();
}, 30_000);

it("fails closed on truncated, over-limit, and symlink-substituted journal records", async () => {
  const value = fixture();
  for (const attack of ["truncated", "over-limit", "symlink"] as const) {
    const spendReservation = value.makeSpend({ maxCalls: 1, maxCallsByKind: {
      adjudicator_1: 0, adjudicator_2: 0, answer: 1, capability: 0,
      resolver: 0, retrieval: 0 } });
    const attempt = identity(value.releaseRootSha256, sha256(spendReservation), `hostile-${attack}`);
    const root = await mkdtemp(join(tmpdir(), "quality-hostile-journal-"));
    const journal = new DurableAttemptJournal(root, value.policy);
    const request = Buffer.from(attempt.questionId);
    expect(await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
      effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: attempt,
      journal, nowEpochMs: 1_000, port: { exchange: async () => ({ effect: "unknown" as const }) },
      provider, release: value.release, request, signal: new AbortController().signal,
      spendReservation })).toBe("outcome_unknown");
    const reservationPath = join(root, `${attempt.attemptId}.reserved.json`);
    if (attack === "truncated") {await writeFile(reservationPath, "{");}
    else if (attack === "over-limit") {await writeFile(reservationPath, Buffer.alloc(8_000_001, 0x20));}
    else {
      const retained = join(root, `${attempt.attemptId}.retained-reserved.json`);
      await rename(reservationPath, retained); await symlink(retained, reservationPath);
    }
    expect(await journal.recoveredState({ identity: attempt, release: value.release,
      requestDigestSha256: sha256(request) })).toBe("blocked_evidence");
    await journal.close();
  }
}, 30_000);

it("pins the journal root descriptor across a pathname symlink swap", async () => {
  const value = fixture(); const spendReservation = value.makeSpend({ maxCalls: 1,
    maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0, answer: 1, capability: 0,
      resolver: 0, retrieval: 0 } });
  const attempt = identity(value.releaseRootSha256, sha256(spendReservation), "root-swap-question");
  const parent = await mkdtemp(join(tmpdir(), "quality-root-swap-"));
  const root = join(parent, "journal"); await mkdir(root, { mode: 0o700 });
  const journal = new DurableAttemptJournal(root, value.policy); const request = Buffer.from(attempt.questionId);
  expect(await journal.recoveredState({ identity: attempt, release: value.release,
    requestDigestSha256: sha256(request) })).toBe("never_reserved");
  const retained = join(parent, "retained-journal"), replacement = join(parent, "replacement");
  await rename(root, retained); await mkdir(replacement, { mode: 0o700 }); await symlink(replacement, root);
  expect(await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
    effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: attempt,
    journal, nowEpochMs: 1_000, port: { exchange: async () => ({ effect: "unknown" as const }) },
    provider, release: value.release, request, signal: new AbortController().signal,
    spendReservation })).toBe("outcome_unknown");
  expect(await readdir(replacement)).toEqual([]);
  expect(await readdir(retained)).toContain(`${attempt.attemptId}.reserved.json`);
  await journal.close();
}, 30_000);

it("fails closed after a fresh journal observes root replacement or ledger truncation", async () => {
  const value = fixture(); const spendReservation = value.makeSpend({ maxCalls: 2,
    maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0, answer: 2, capability: 0,
      resolver: 0, retrieval: 0 } });
  for (const attack of ["root-replacement", "ledger-truncation"] as const) {
    const parent = await mkdtemp(join(tmpdir(), `quality-restart-${attack}-`));
    const root = join(parent, "journal"); const first = identity(value.releaseRootSha256,
      sha256(spendReservation), `${attack}-first`); let providerCalls = 0;
    const initial = new DurableAttemptJournal(root, value.policy);
    expect(await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
      effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: first,
      journal: initial, nowEpochMs: 1_000, port: { exchange: async () => {providerCalls += 1;
        return { effect: "unknown" as const };} }, provider, release: value.release,
      request: Buffer.from(first.questionId), signal: new AbortController().signal,
      spendReservation })).toBe("outcome_unknown");
    await initial.close();
    if (attack === "root-replacement") {
      await rename(root, join(parent, "retained-journal")); await mkdir(root, { mode: 0o700 });
    } else {
      const ledger = (await readdir(join(root, "budgets"))).find((name) => name.endsWith(".jsonl") &&
        !name.startsWith("."));
      if (ledger === undefined) {throw new Error("test budget ledger is missing");}
      await writeFile(join(root, "budgets", ledger), "");
    }
    const resumed = new DurableAttemptJournal(root, value.policy); const second =
      attack === "root-replacement" ? first : identity(value.releaseRootSha256,
        sha256(spendReservation), `${attack}-second`);
    const run = executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
      effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: second,
      journal: resumed, nowEpochMs: 1_000, port: { exchange: async () => {providerCalls += 1;
        return { effect: "unknown" as const };} }, provider, release: value.release,
      request: Buffer.from(second.questionId), signal: new AbortController().signal,
      spendReservation });
    if (attack === "root-replacement") {expect(await run).toBe("blocked_evidence");
      await expect(resumed.close()).rejects.toThrow(/attempt journal close failed/u);}
    else {await expect(run).rejects.toThrow(/replaced or truncated/u); await resumed.close();}
    expect(providerCalls).toBe(1);
  }
}, 30_000);

it("does not repeat a provider effect when a fresh process resumes replaced durable state", async () => {
  const value = fixture(); const spendReservation = value.makeSpend({ maxCalls: 2,
    maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0, answer: 2, capability: 0,
      resolver: 0, retrieval: 0 } });
  for (const attack of ["root-replacement", "ledger-truncation"] as const) {
    const parent = await mkdtemp(join(tmpdir(), `quality-process-restart-${attack}-`));
    const root = join(parent, "journal"); const callsPath = join(parent, "calls.txt");
    const first = identity(value.releaseRootSha256, sha256(spendReservation), `${attack}-first`);
    const initial = new DurableAttemptJournal(root, value.policy);
    await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
      effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: first,
      journal: initial, nowEpochMs: 1_000, port: { exchange: async () => {
        await writeFile(callsPath, "call\n"); return { effect: "unknown" as const };} }, provider,
      release: value.release, request: Buffer.from(first.questionId),
      signal: new AbortController().signal, spendReservation });
    await initial.close();
    if (attack === "root-replacement") {
      await rename(root, join(parent, "retained-journal")); await mkdir(root, { mode: 0o700 });
    } else {
      const ledger = (await readdir(join(root, "budgets"))).find((name) => name.endsWith(".jsonl") &&
        !name.startsWith("."));
      if (ledger === undefined) {throw new Error("test budget ledger is missing");}
      await writeFile(join(root, "budgets", ledger), "");
    }
    const second = attack === "root-replacement" ? first : identity(value.releaseRootSha256,
      sha256(spendReservation), `${attack}-second`);
    const childPath = join(parent, "resume-child.mjs"), configPath = join(parent, "resume.json");
    await writeFile(configPath, canonicalJson({ authorityPins: value.pins, callsPath,
      campaignRootSha256, identity: second, journalRoot: root, provider, release: value.release,
      sourceUrl: new URL("../src/quality-campaign/index.ts", import.meta.url).href,
      spendReservation }));
    await writeFile(childPath, `import {appendFile,readFile} from "node:fs/promises";
const c=JSON.parse(await readFile(process.argv[2],"utf8"));const api=await import(c.sourceUrl);
const policy=new api.QualityCampaignAuthorityPolicy(c.authorityPins);
const journal=new api.DurableAttemptJournal(c.journalRoot,policy);let state="blocked_evidence";
try{state=await api.executeReservedExchange({campaignRootSha256:c.campaignRootSha256,
deadlineEpochMs:1500,effectReservation:{requestedEncryptedBytes:1,requestedTokens:1},
identity:c.identity,journal,nowEpochMs:1000,port:{exchange:async()=>{await appendFile(c.callsPath,
"call\\n");return {effect:"unknown"};}},provider:c.provider,release:c.release,
request:Buffer.from(c.identity.questionId),signal:new AbortController().signal,
spendReservation:c.spendReservation});}catch{}finally{await journal.close().catch(()=>{});}
process.stdout.write(state);`);
    const result = await collectChild(spawn(process.execPath,
      ["--import", tsxLoaderPath, childPath, configPath], { stdio: ["ignore", "pipe", "pipe"] }));
    expect(result).toEqual({ code: 0, stderr: "", stdout: "blocked_evidence" });
    expect((await readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(1);
  }
}, 60_000);

it("closes journal and checkpoint descriptors idempotently and rejects later operations", async () => {
  const value = fixture(); const parent = await mkdtemp(join(tmpdir(), "quality-lifecycle-"));
  const before = (await readdir("/proc/self/fd")).length;
  for (let index = 0; index < 32; index += 1) {
    const journal = new DurableAttemptJournal(join(parent, `journal-${index}`), value.policy);
    const checkpoint = new ProductionCheckpointStore(join(parent, `checkpoint-${index}`));
    const attempt = identity(value.releaseRootSha256, digest("2"), `lifecycle-${index}`);
    expect(await journal.recoveredState({ identity: attempt, release: value.release,
      requestDigestSha256: sha256(Buffer.from(attempt.questionId)) })).toBe("never_reserved");
    await checkpoint.deadline({ campaignRootSha256, nowEpochMs: 1_000 });
    await Promise.all([journal.close(), journal.close(), checkpoint.close(), checkpoint.close()]);
    await expect(journal.recoveredState({ identity: attempt, release: value.release,
      requestDigestSha256: sha256(Buffer.from(attempt.questionId)) }))
      .rejects.toThrow(/attempt journal is closed/u);
    await expect(checkpoint.requirePhase(campaignRootSha256, "missing"))
      .rejects.toThrow();
  }
  const after = (await readdir("/proc/self/fd")).length;
  expect(after).toBeLessThanOrEqual(before + 2);
}, 30_000);

it("accepts identical terminal publishers and rejects a different create-only writer", async () => {
  const value = fixture(); const spendReservation = value.makeSpend({ maxCalls: 1,
    maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0, answer: 1, capability: 0,
      resolver: 0, retrieval: 0 } });
  const attempt = identity(value.releaseRootSha256, sha256(spendReservation), "terminal-question");
  const requestDigestSha256 = sha256(Buffer.from(attempt.questionId));
  const spend = verifySpendReservation(value.policy, { campaignRootSha256,
    expectedRepetition: 1, nowEpochMs: 1_000, releaseRootSha256: value.releaseRootSha256,
    reservation: spendReservation });
  const reserve = async (root: string) => {
    const journal = new DurableAttemptJournal(root, value.policy);
    const admitted = await journal.admit({ identity: attempt, requestDigestSha256,
      requestedEncryptedBytes: 1, requestedTokens: 1, spend });
    if (admitted.reservation === undefined) {throw new Error("test reservation was not admitted");}
    return { journal, reservation: admitted.reservation };
  };
  const signedTerminal = (resultDigestSha256: string, state: "terminal_failure" |
    "terminal_success") => value.signers.provider_result.signed({ ...attempt,
    providerAccounting: qualificationProviderAccountingFixture(value.releasePayload, "answer"),
    requestDigestSha256, resultDigestSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4", state });

  const identical = await reserve(await mkdtemp(join(tmpdir(), "quality-identical-terminal-")));
  const identicalResult = sha256(Buffer.from("6")); const identicalReceipt = signedTerminal(identicalResult,
    "terminal_success");
  const identicalWriters = Array.from({ length: 8 }, () => identical.journal.terminal({
    expectedResultDigestSha256: identicalResult, identity: attempt,
    requestBytes: Buffer.from(attempt.questionId), reservation: identical.reservation,
    resultEnvelopeBytes: Buffer.from("6"), signedResult: identicalReceipt,
    release: value.release,
    state: "terminal_success" as const }));
  expect((await Promise.all(identicalWriters)).map(({ state }) => state))
    .toEqual(Array.from({ length: 8 }, () => "terminal_success"));

  const conflicting = await reserve(await mkdtemp(join(tmpdir(), "quality-conflicting-terminal-")));
  let releaseStart!: () => void; let readyCount = 0; let reportReady!: () => void;
  const start = new Promise<void>((resolve) => {releaseStart = resolve;});
  const ready = new Promise<void>((resolve) => {reportReady = resolve;});
  const write = async (resultDigestSha256: string, state: "terminal_failure" |
    "terminal_success") => {
    readyCount += 1; if (readyCount === 2) {reportReady();} await start;
    return await conflicting.journal.terminal({ expectedResultDigestSha256: resultDigestSha256,
      identity: attempt, reservation: conflicting.reservation,
      requestBytes: Buffer.from(attempt.questionId), resultEnvelopeBytes:
        Buffer.from(resultDigestSha256 === sha256(Buffer.from("7")) ? "7" : "8"),
      release: value.release,
      signedResult: signedTerminal(resultDigestSha256, state), state });
  };
  const writers = [write(sha256(Buffer.from("7")), "terminal_success"),
    write(sha256(Buffer.from("8")), "terminal_failure")];
  await ready; releaseStart();
  const results = await Promise.allSettled(writers);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
  expect(String((results.find(({ status }) => status === "rejected") as
    PromiseRejectedResult).reason)).toMatch(/create-only artifact conflicts/u);
  await Promise.all([identical.journal.close(), conflicting.journal.close()]);
}, 30_000);

it("enforces cumulative token, encrypted-byte, and per-kind ceilings", async () => {
  const value = fixture(); const scenarios = [
    { maxCallsByKind: 2, maxEncryptedBytes: 2, maxTokens: 1 },
    { maxCallsByKind: 2, maxEncryptedBytes: 1, maxTokens: 2 },
    { maxCallsByKind: 1, maxEncryptedBytes: 2, maxTokens: 2 }];
  for (const scenario of scenarios) {
    const spendReservation = value.makeSpend({ maxCallsByKind: { adjudicator_1: 0,
      adjudicator_2: 0, answer: scenario.maxCallsByKind, capability: 0, resolver: 0,
      retrieval: 0 }, maxEncryptedBytes: scenario.maxEncryptedBytes, maxTokens: scenario.maxTokens });
    const spendDigest = sha256(spendReservation); let providerCalls = 0;
    const journal = new DurableAttemptJournal(await mkdtemp(join(tmpdir(), "quality-budget-")),
      value.policy);
    for (const questionId of ["question-1", "question-2"]) {
      const attempt = identity(value.releaseRootSha256, spendDigest, questionId);
      await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
        effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: attempt,
        journal, nowEpochMs: 1_000, port: { exchange: async () => {providerCalls += 1;
          return { effect: "unknown" as const };} }, provider, release: value.release,
        request: Buffer.from(questionId), signal: new AbortController().signal, spendReservation });
    }
    expect(providerCalls).toBe(1);
    await journal.close();
  }
});

async function collectChild(child: ChildProcess): Promise<{
  readonly code: number | null; readonly stderr: string; readonly stdout: string }> {
  let stdout = "", stderr = "";
  child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {stdout += chunk;});
  child.stderr?.on("data", (chunk: string) => {stderr += chunk;});
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject); child.once("close", resolve);
  });
  return { code, stderr, stdout };
}
