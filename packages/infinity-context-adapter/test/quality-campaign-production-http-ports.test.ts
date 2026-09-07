import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { artifactAttemptIdentity, attemptIdentity, canonicalJson, createHttpQualityCampaignProductionPorts,
  sha256, verifyExternalSignedValue } from "../src/quality-campaign/index.js";

const REVIEW_KEYS = ["firstEffectEvidence", "firstReceipt", "predecessorPlaintextSha256",
  "rawOutcomeEnvelopeSha256", "resolverEffectEvidence", "resolverReceipt",
  "secondEffectEvidence", "secondReceipt"] as const;

afterEach(() => {vi.unstubAllGlobals();});

describe("concrete HTTP production review evidence", () => {
  it("preserves the exact eight-field contract without treating signatures as trusted", async () => {
    const fixture = await httpFixture(); const payload = fullReviewEvidence(fixture.answerAttempt);
    fixture.respondWith(payload);
    const ports = await createHttpQualityCampaignProductionPorts(fixture.connectionsPath);
    await expect(ports.mainCanonicalEvidence.verify({ attempts: [],
      campaignRootSha256: "a".repeat(64) })).rejects.toThrow(/inventory is empty/u);
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
    expect(fixture.fetchCalls().every((call) => call.init.redirect === "error" &&
      (call.init.headers as Record<string, string>).authorization ===
        `Bearer ${fixture.providerCredential}`)).toBe(true);
  });

  it("rejects every plaintext endpoint before credential reads or network access", async () => {
    const fixture = await httpFixture();
    const variants = ["absenceEndpoint", "deletionEndpoint", "evidenceEndpoint",
      "holdoutAnswerEndpoint", "holdoutCapabilityEndpoint", "holdoutEvidenceEndpoint",
      "holdoutRetrievalEndpoint", "rawOutcomeEndpoint", "releaseObservationEndpoint"];
    for (const key of variants) {
      await fixture.writeInvalidEndpoint((config) => {config[key] = "http://authority.invalid/path";});
      await expect(createHttpQualityCampaignProductionPorts(fixture.connectionsPath))
        .rejects.toThrow(/absolute HTTPS URL/u);
    }
    for (const index of [0, 1, 2]) {
      await fixture.writeInvalidEndpoint((config) => {
        const adjudicators = config.adjudicators as Record<string, unknown>[];
        adjudicators[index]!.endpoint = "http://reviewer.invalid/path";
      });
      await expect(createHttpQualityCampaignProductionPorts(fixture.connectionsPath))
        .rejects.toThrow(/absolute HTTPS URL/u);
    }
    await fixture.writeInvalidEndpoint((config) => {
      const canonical = config.canonicalExecution as Record<string, unknown>;
      canonical.infinityBaseUrl = "http://infinity.invalid";
    });
    await expect(createHttpQualityCampaignProductionPorts(fixture.connectionsPath))
      .rejects.toThrow(/absolute HTTPS URL/u);
    expect(fixture.fetchCalls()).toHaveLength(0);
  });

  it.each(["not a URL", "https://user:password@authority.invalid/path"])(
    "rejects malformed or credential-bearing endpoint %s", async (endpoint) => {
      const fixture = await httpFixture();
      await fixture.writeInvalidEndpoint((config) => {config.rawOutcomeEndpoint = endpoint;});
      await expect(createHttpQualityCampaignProductionPorts(fixture.connectionsPath))
        .rejects.toThrow(/absolute HTTPS URL/u);
      expect(fixture.fetchCalls()).toHaveLength(0);
    });

  it("refuses redirects for credential-bearing requests", async () => {
    const fixture = await httpFixture(); fixture.respondWith({}, 0, 302);
    const ports = await createHttpQualityCampaignProductionPorts(fixture.connectionsPath);
    await expect(ports.review.receipts(fixture.answerAttempt.attemptId,
      context(Date.now() + 5_000))).rejects.toThrow(/request failed/u);
    expect(fixture.fetchCalls()).toHaveLength(1);
    expect(fixture.fetchCalls()[0]).toMatchObject({ input: "https://authority.invalid/review",
      init: { redirect: "error" } });
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
  let responseValue: unknown = {}; let responseDelayMs = 0; let responseStatus = 200;
  const bodies: unknown[] = []; const fetchCalls: { readonly input: string;
    readonly init: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
    fetchCalls.push({ input: typeof input === "string" ? input :
      input instanceof URL ? input.href : input.url, init });
    if (typeof init.body !== "string") {throw new Error("expected JSON string request body");}
    bodies.push(JSON.parse(init.body) as unknown);
    return new Promise<Response>((resolve, reject) => {
      const finish = () => {resolve(new Response(JSON.stringify(responseValue), {
        headers: { "content-type": "application/json" }, status: responseStatus }));};
      if (responseDelayMs === 0) {finish(); return;}
      const timeout = setTimeout(finish, responseDelayMs);
      init.signal?.addEventListener("abort", () => {clearTimeout(timeout);
        reject(init.signal?.reason);}, { once: true });
    });
  }));
  const endpoint = "https://authority.invalid/review";
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
  const providerCredential = randomUUID();
  const tokenPath = join(root, "token"); await writeFile(tokenPath, providerCredential);
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
  const configuration: Record<string, unknown> = { absenceAuthority: authority("absence"),
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
    schemaVersion: "meeting_knowledge.semantic_quality_http_connections.v5" };
  await writeFile(connectionsPath, canonicalJson(configuration));
  const answerAttempt = attemptIdentity({ callKind: "answer", callOrdinal: 0,
    campaignRootSha256: sha256("campaign"), questionDigestSha256: sha256("question"),
    questionId: "question-1", releaseRootSha256: sha256("release"), repetition: 1,
    spendReservationSha256: sha256("spend") });
  return { answerAttempt, connectionsPath, providerCredential, providerPublicKeyPem,
    fetchCalls: () => fetchCalls, requests: () => bodies,
    respondWith(value: unknown, delayMs = 0, status = 200) {
      responseValue = value; responseDelayMs = delayMs; responseStatus = status;},
    async writeInvalidEndpoint(change: (config: Record<string, unknown>) => void) {
      const invalid = structuredClone(configuration);
      invalid.credentialPath = join(root, "missing-credential"); change(invalid);
      await writeFile(connectionsPath, canonicalJson(invalid));
    } };
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
