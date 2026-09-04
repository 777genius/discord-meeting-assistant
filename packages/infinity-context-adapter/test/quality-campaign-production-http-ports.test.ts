import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { artifactAttemptIdentity, attemptIdentity, canonicalJson, createHttpQualityCampaignProductionPorts,
  sha256, verifyExternalSignedValue } from "../src/quality-campaign/index.js";

const servers: ReturnType<typeof createServer>[] = [];
const REVIEW_KEYS = ["firstEffectEvidence", "firstReceipt", "predecessorPlaintextSha256",
  "rawOutcomeEnvelopeSha256", "resolverEffectEvidence", "resolverReceipt",
  "secondEffectEvidence", "secondReceipt"] as const;

afterEach(async () => {await Promise.all(servers.splice(0).map(async (server) => {
  await new Promise<void>((resolve) => {server.close(() => {resolve();});});
})); vi.unstubAllGlobals();});

describe("concrete HTTP production review evidence", () => {
  it("preserves the exact eight-field contract without treating signatures as trusted", async () => {
    const fixture = await httpFixture(); const payload = fullReviewEvidence(fixture.answerAttempt);
    fixture.respondWith(payload);
    const ports = await createHttpQualityCampaignProductionPorts(fixture.connectionsPath);
    const evidence = await ports.review.receipts(fixture.answerAttempt.attemptId,
      context(Date.now() + 5_000));

    expect(Object.keys(evidence).toSorted()).toEqual([...REVIEW_KEYS].toSorted());
    expect(evidence).toEqual(payload);
    expect(() => verifyExternalSignedValue(evidence.firstEffectEvidence.signedDurableExchange,
      "provider", fixture.providerPublicKeyPem, "HTTP-returned durable exchange"))
      .toThrow(/signature/u);

    fixture.respondWith({ ...payload, resolverEffectEvidence: null, resolverReceipt: null });
    await expect(ports.review.receipts(fixture.answerAttempt.attemptId,
      context(Date.now() + 5_000))).resolves.toMatchObject({ resolverEffectEvidence: null,
        resolverReceipt: null });
    expect(fixture.requests()).toEqual([{ attemptId: fixture.answerAttempt.attemptId },
      { attemptId: fixture.answerAttempt.attemptId }]);
  });

  it("fails closed on legacy, missing, surplus, malformed and resolver-mismatched payloads",
    async () => {
      const fixture = await httpFixture(); const ports = await createHttpQualityCampaignProductionPorts(
        fixture.connectionsPath); const valid = fullReviewEvidence(fixture.answerAttempt);
      const rejected: unknown[] = [
        { firstReceipt: valid.firstReceipt, rawOutcomeEnvelopeSha256:
          valid.rawOutcomeEnvelopeSha256, resolverReceipt: valid.resolverReceipt,
        secondReceipt: valid.secondReceipt },
        ...REVIEW_KEYS.map((key) => without(valid, key)),
        { ...valid, surplus: true },
        { ...valid, predecessorPlaintextSha256: "not-a-digest" },
        { ...valid, rawOutcomeEnvelopeSha256: "0".repeat(63) },
        { ...valid, firstEffectEvidence: { ...valid.firstEffectEvidence,
          requestDigestSha256: "not-a-digest" } },
        { ...valid, secondEffectEvidence: { ...valid.secondEffectEvidence,
          cancellationBoundary: "cancelled" } },
        { ...valid, firstEffectEvidence: valid.secondEffectEvidence,
          secondEffectEvidence: valid.firstEffectEvidence },
        { ...valid, resolverEffectEvidence: null },
        { ...valid, resolverReceipt: null },
        { ...valid, resolverEffectEvidence: { ...valid.resolverEffectEvidence,
          unexpected: true } },
      ];
      for (const value of rejected) {
        fixture.respondWith(value);
        await expect(ports.review.receipts(fixture.answerAttempt.attemptId,
          context(Date.now() + 5_000))).rejects.toThrow();
      }
    });

  it("keeps HTTP review requests bounded by abort and deadline", async () => {
    const fixture = await httpFixture(); fixture.respondWith(fullReviewEvidence(
      fixture.answerAttempt), 250);
    const ports = await createHttpQualityCampaignProductionPorts(fixture.connectionsPath);
    await expect(ports.review.receipts(fixture.answerAttempt.attemptId,
      context(Date.now() + 10))).rejects.toThrow();
  });

  it("rejects an authority response that appends beyond the closed byte limit", async () => {
    const fixture = await httpFixture(); fixture.respondWith("x".repeat(8_000_001));
    const ports = await createHttpQualityCampaignProductionPorts(fixture.connectionsPath);
    await expect(ports.review.receipts(fixture.answerAttempt.attemptId,
      context(Date.now() + 5_000))).rejects.toThrow(/byte limit/u);
  });

  it("rejects malformed response chunks and releases the response reader", async () => {
    const fixture = await httpFixture();
    const ports = await createHttpQualityCampaignProductionPorts(fixture.connectionsPath);
    const releaseLock = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: false,
        value: "not a byte chunk" }), releaseLock }) },
      headers: { get: () => null }, ok: true,
    }));

    await expect(ports.review.receipts(fixture.answerAttempt.attemptId,
      context(Date.now() + 5_000))).rejects.toThrow(/invalid byte chunk/u);
    expect(releaseLock).toHaveBeenCalledOnce();
  });
});

async function httpFixture() {
  const root = await mkdtemp(join(tmpdir(), "quality-review-http-"));
  let responseValue: unknown = {}; let responseDelayMs = 0; const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {chunks.push(chunk);});
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      setTimeout(() => {response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responseValue));}, responseDelayMs);
    });
  });
  servers.push(server); await new Promise<void>((resolve) => {server.listen(0, "127.0.0.1",
    () => {resolve();});}); const address = server.address();
  if (address === null || typeof address === "string") {throw new Error("local HTTP bind failed");}
  const endpoint = `http://127.0.0.1:${address.port}/review`;
  const provider = generateKeyPairSync("ed25519"); const holdout = generateKeyPairSync("ed25519");
  const providerPublicKeyPem = provider.publicKey.export({ format: "pem", type: "spki" }).toString();
  const holdoutPublicKeyPem = holdout.publicKey.export({ format: "pem", type: "spki" }).toString();
  const publicKeyPaths: Record<string, string> = {};
  for (const [name, pem] of [["provider", providerPublicKeyPem],
    ["holdout", holdoutPublicKeyPem], ["evidence", providerPublicKeyPem],
    ["holdout-evidence", holdoutPublicKeyPem], ["absence", providerPublicKeyPem],
    ["deletion", holdoutPublicKeyPem]] as const) {
    const path = join(root, `${name}.pem`); await writeFile(path, pem); publicKeyPaths[name] = path;
  }
  const tokenPath = join(root, "token"); await writeFile(tokenPath, "local-test-token");
  const keyPath = join(root, "key"); const holdoutKeyPath = join(root, "holdout-key");
  await writeFile(keyPath, Buffer.alloc(32, 1).toString("base64"));
  await writeFile(holdoutKeyPath, Buffer.alloc(32, 2).toString("base64"));
  const authority = (name: string) => ({ keyId: name, publicKeyPath: publicKeyPaths[name]! });
  const canonicalExecution = { answerExecutionBindingPath: keyPath,
    answerJournalRoot: join(root, "answer-journal"), artifactKeyId: "artifact-key",
    artifactKeyPath: keyPath, artifactRoot: join(root, "canonical-artifacts"),
    expectedRuntimeLauncherSha256: sha256("launcher"), infinityBaseUrl: endpoint,
    infinityCapabilityPath: keyPath, infinityTokenPath: tokenPath, postgresUrlPath: tokenPath,
    requestTimeoutMs: 100, retrievalJournalRoot: join(root, "retrieval-journal"),
    runtimeAddress: "127.0.0.1:1", runtimeTokenPath: tokenPath,
    topologyAuthority: authority("provider"), topologyKeyPath: keyPath, topologyPath: keyPath };
  const connectionsPath = join(root, "connections.json");
  await writeFile(connectionsPath, canonicalJson({ absenceAuthority: authority("absence"),
    absenceEndpoint: `${endpoint}/absence`, adjudicators: [authority("provider"),
      authority("holdout"), authority("evidence")].map((item) => ({ ...item, endpoint })),
    artifactCustody: { envelopeRoot: root,
      keyCustodySha256: sha256("custody"), keyId: "artifact-key", keyPath },
    canonicalExecution, credentialPath: tokenPath,
    deletionAuthority: authority("deletion"), deletionEndpoint: `${endpoint}/deletion`,
    evidenceAuthority: authority("evidence"), evidenceEndpoint: endpoint,
    evidenceKeyId: "evidence-key", evidenceKeyPath: keyPath,
    holdoutAnswerEndpoint: endpoint, holdoutCapabilityEndpoint: endpoint,
    holdoutEvidenceAuthority: authority("holdout-evidence"), holdoutEvidenceEndpoint: endpoint,
    holdoutEvidenceKeyId: "holdout-evidence-key", holdoutEvidenceKeyPath: holdoutKeyPath,
    holdoutProviderResultAuthority: authority("holdout"), holdoutRetrievalEndpoint: endpoint,
    providerResultAuthority: authority("provider"), rawOutcomeEndpoint: endpoint,
    releaseObservationEndpoint: endpoint,
    schemaVersion: "meeting_knowledge.semantic_quality_http_connections.v5" }));
  const answerAttempt = attemptIdentity({ callKind: "answer", callOrdinal: 0,
    campaignRootSha256: sha256("campaign"), questionDigestSha256: sha256("question"),
    questionId: "question-1", releaseRootSha256: sha256("release"), repetition: 1,
    spendReservationSha256: sha256("spend") });
  return { answerAttempt, connectionsPath, providerPublicKeyPem,
    requests: () => bodies, respondWith(value: unknown, delayMs = 0) {
      responseValue = value; responseDelayMs = delayMs;} };
}

function fullReviewEvidence(answerAttempt: ReturnType<typeof attemptIdentity>) {
  const effect = (kind: "adjudicator_1_result" | "adjudicator_2_result" | "resolver_result") => ({
    attempt: artifactAttemptIdentity(answerAttempt, kind), cancellationBoundary: "not_cancelled" as const,
    deadlineEpochMs: Date.now() + 60_000, requestDigestSha256: sha256(`${kind}:request`),
    resultDigestSha256: sha256(`${kind}:result`), signedDurableExchange:
      unsignedTransportValue(`${kind}:durable`), signedProviderTerminal:
      unsignedTransportValue(`${kind}:terminal`) });
  return { firstEffectEvidence: effect("adjudicator_1_result"), firstReceipt:
    unsignedTransportValue("first"),
    predecessorPlaintextSha256: sha256("predecessor"),
    rawOutcomeEnvelopeSha256: sha256("raw-outcome"),
    resolverEffectEvidence: effect("resolver_result"), resolverReceipt:
      unsignedTransportValue("resolver"), secondEffectEvidence: effect("adjudicator_2_result"),
    secondReceipt: unsignedTransportValue("second") };
}

function unsignedTransportValue(label: string) {
  return { payload: { label }, signatureBase64: "AA==", signerKeyId: "provider" };
}

function without<T extends Record<string, unknown>>(value: T, key: keyof T): unknown {
  const copy = { ...value }; delete copy[key]; return copy;
}

function context(deadlineEpochMs: number) {
  return { deadlineEpochMs, signal: new AbortController().signal };
}
