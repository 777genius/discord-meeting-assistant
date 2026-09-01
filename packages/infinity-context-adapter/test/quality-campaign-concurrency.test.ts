import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { attemptIdentity, canonicalJson, DurableAttemptJournal, executeReservedExchange,
  FROZEN_ANSWER_EXECUTION, publicKeyFingerprintSha256, QUALITY_AUTHORITY_ROLES,
  QualityCampaignAuthorityPolicy, sha256,
  verifySpendReservation } from "../src/quality-campaign/index.js";
import { qualificationProviderAccountingFixture } from
  "./quality-campaign-provider-accounting-fixture.js";

const digest = (value: string) => value.repeat(64);
const campaignRootSha256 = digest("1"), provider = "pinned-provider";

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
const state=await api.executeReservedExchange({campaignRootSha256:c.campaignRootSha256,
deadlineEpochMs:c.deadlineEpochMs,effectReservation:{requestedEncryptedBytes:1,requestedTokens:1},
identity:c.attempt,journal:new api.DurableAttemptJournal(c.journalRoot,policy),nowEpochMs:1000,
port:{exchange:async()=>{await appendFile(c.callsPath,"call\\n");process.send({type:"effect"});
await new Promise(resolve=>process.once("message",resolve));return {effect:"unknown"};}},
provider:c.provider,release:c.release,request:Buffer.from(c.attempt.questionId),
signal:new AbortController().signal,spendReservation:c.spendReservation});
process.send({state,type:"result"});process.disconnect();\n`);
  const participants = [0, 1].map(() => controlledChild(spawn(process.execPath,
    ["--import", "tsx/esm", childPath, configPath], { stdio: ["ignore", "ignore", "pipe", "ipc"] })));
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
}, 30_000);

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
      return await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
        effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: attempt,
        journal: new DurableAttemptJournal(root, value.policy), nowEpochMs: 1_000,
        port: { exchange: async () => {providerCalls += 1; reportProvider();
          await providerRelease; return { effect: "unknown" as const };} }, provider,
        release: value.release, request: Buffer.from(attempt.questionId),
        signal: new AbortController().signal, spendReservation });
    };
    const participants = [participate(), participate()];
    await ready; releaseStart(); await providerEntered;
    expect(await Promise.race(participants)).toBe("outcome_unknown");
    releaseProvider();
    expect(await Promise.all(participants)).toEqual(["outcome_unknown", "outcome_unknown"]);
    expect(providerCalls).toBe(1);
    const reservation = JSON.parse(await readFile(join(root, attempt.attemptId,
      "reserved.json"), "utf8")) as { readonly state: string };
    expect(reservation.state).toBe("provider_reserved");
  }
}, 60_000);

it("ignores a crash-left unpublished temp reservation", async () => {
  const value = fixture(); const spendReservation = value.makeSpend({ maxCalls: 1,
    maxCallsByKind: { adjudicator_1: 0, adjudicator_2: 0, answer: 1, capability: 0,
      resolver: 0, retrieval: 0 } });
  const attempt = identity(value.releaseRootSha256, sha256(spendReservation), "stale-temp-question");
  const root = await mkdtemp(join(tmpdir(), "quality-stale-temp-"));
  const attemptRoot = join(root, attempt.attemptId); await mkdir(attemptRoot, { recursive: true });
  await writeFile(join(attemptRoot, ".reserved.json.crash.tmp"), "partial");
  const state = await executeReservedExchange({ campaignRootSha256, deadlineEpochMs: 1_500,
    effectReservation: { requestedEncryptedBytes: 1, requestedTokens: 1 }, identity: attempt,
    journal: new DurableAttemptJournal(root, value.policy), nowEpochMs: 1_000,
    port: { exchange: async () => ({ effect: "unknown" as const }) }, provider,
    release: value.release, request: Buffer.from(attempt.questionId),
    signal: new AbortController().signal, spendReservation });
  expect(state).toBe("outcome_unknown");
  expect(await readdir(attemptRoot)).toContain("reserved.json");
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
  }
});
