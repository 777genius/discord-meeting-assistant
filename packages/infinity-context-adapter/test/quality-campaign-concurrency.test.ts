import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { attemptIdentity, canonicalJson, DurableAttemptJournal, executeReservedExchange,
  FROZEN_ANSWER_EXECUTION, publicKeyFingerprintSha256, QUALITY_AUTHORITY_ROLES,
  QualityCampaignAuthorityPolicy, sha256 } from "../src/index.js";

const execFileAsync = promisify(execFile); const digest = (value: string) => value.repeat(64);
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
  return { makeSpend, pins, policy, release, releaseRootSha256 };
}

function identity(releaseRootSha256: string, spendReservationSha256: string, questionId: string) {
  return attemptIdentity({ callKind: "answer", callOrdinal: 0, campaignRootSha256,
    questionDigestSha256: sha256(questionId), questionId, releaseRootSha256, repetition: 1,
    spendReservationSha256 });
}

it("admits one same-attempt exchange across two processes sharing one journal", async () => {
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
await api.executeReservedExchange({campaignRootSha256:c.campaignRootSha256,
deadlineEpochMs:c.deadlineEpochMs,effectReservation:{requestedEncryptedBytes:1,requestedTokens:1},
identity:c.attempt,journal:new api.DurableAttemptJournal(c.journalRoot,policy),nowEpochMs:1000,
port:{exchange:async()=>{await appendFile(c.callsPath,"call\\n");return {effect:"unknown"};}},
provider:c.provider,release:c.release,request:Buffer.from(c.attempt.questionId),
signal:new AbortController().signal,spendReservation:c.spendReservation});\n`);
  await Promise.all([execFileAsync(process.execPath, ["--import", "tsx/esm", childPath, configPath]),
    execFileAsync(process.execPath, ["--import", "tsx/esm", childPath, configPath])]);
  expect((await readFile(callsPath, "utf8")).trim().split("\n")).toHaveLength(1);
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
