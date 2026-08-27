import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { artifactAttemptIdentity, attemptIdentity, qualificationProviderAccountingFixture,
  type QualityCampaignRelease } from "../src/quality-campaign/index.js";

const execute = promisify(execFile); const servers: ReturnType<typeof createServer>[] = [];
let installed!: Awaited<ReturnType<typeof packAndInstall>>;

beforeAll(async () => {installed = await packAndInstall();}, 180_000);
afterAll(async () => {await Promise.all(servers.splice(0).map(async (server) => {
  await new Promise<void>((resolve) => {server.close(() => {resolve();});});
}));});

describe("packed production quality-campaign entrypoint", () => {
  it("ships an allow-listed clean package with safe root imports", async () => {
    expect(installed.files.some((value) => value.includes("test-support") ||
      value.includes("stale-generated"))).toBe(false);
    const manifest = JSON.parse(await readFile(join(installed.consumerRoot, "node_modules",
      "@discord-meeting", "infinity-context-adapter", "package.json"), "utf8")) as unknown;
    expect(JSON.stringify(manifest)).not.toMatch(/workspace:|catalog:/u);
    await expect(execute(process.execPath, ["--input-type=module", "--eval",
      `const root=await import("@discord-meeting/infinity-context-adapter");const q=await import("@discord-meeting/infinity-context-adapter/quality-campaign");const cli=await import("@discord-meeting/infinity-context-adapter/quality-campaign/cli");if(typeof root.attemptIdentity!=="function"||typeof root.measureQualificationModelInput!=="function"||typeof q.reconstructExactHoldoutEvidence!=="function"||typeof q.verifyExactOutcomeAuthorities!=="function"||q.QUALIFICATION_PROVIDER_INPUT_CONTRACT.answer.maximumInputUtf8Bytes!==16000||typeof cli.runQualityCampaignProductionCli!=="function")process.exit(2);const exact=root.measureQualificationModelInput({outputSchema:"",systemPrompt:"",userPrompt:"😀".repeat(3999)});if(exact.fullInputUtf8Bytes!==15998)process.exit(3);try{root.measureQualificationModelInput({outputSchema:"",systemPrompt:"",userPrompt:"😀".repeat(4000)});process.exit(4)}catch{}`],
    { cwd: installed.consumerRoot, timeout: 10_000 })).resolves.toMatchObject({ stderr: "" });
    await expect(execute(process.execPath, ["--input-type=module", "--eval",
      `await import("@discord-meeting/infinity-context-adapter/test-support")`], {
      cwd: installed.consumerRoot, timeout: 10_000 })).rejects.toMatchObject({ code: 1 });
  });

  it("executes the packed preflight command against local fake HTTP", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-packed-command-"));
    const fixture = await createPackedPreflightFixture(root, installed.consumerRoot);
    const statusPath = join(root, "preflight-status.json");
    await expect(execute(installed.bin, ["preflight", fixture.phasePath, statusPath], {
      timeout: 30_000 })).rejects.toMatchObject({ code: 20, stderr: "" });
    expect(fixture.releaseRequests()).toBe(1);
    expect(await readFile(statusPath, "utf8")).toMatch(/"status":"paused"/u);
    const executeStatusPath = join(root, "execute-status.json");
    await expect(execute(installed.bin, ["execute", fixture.phasePath, executeStatusPath], {
      timeout: 60_000 })).rejects.toMatchObject({ code: 21, stderr: "" });
    expect(fixture.providerRequests()).toBeGreaterThanOrEqual(2);
    expect(await readFile(executeStatusPath, "utf8")).toMatch(/"status":"outcome_unknown"/u);
  }, 120_000);

  it("ships the exact fail-closed HTTP review-evidence adapter contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-packed-review-"));
    const fixture = await createPackedPreflightFixture(root, installed.consumerRoot);
    const answer = attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: digest("packed-campaign"), questionDigestSha256: digest("packed-question"),
      questionId: "packed-question", releaseRootSha256: digest("packed-release"), repetition: 1,
      spendReservationSha256: digest("packed-spend") });
    const full = packedReviewEvidence(answer); fixture.setReviewEvidence(full);
    const script = `const{createHttpQualityCampaignProductionPorts}=await import("@discord-meeting/infinity-context-adapter/quality-campaign");const p=await createHttpQualityCampaignProductionPorts(${JSON.stringify(fixture.connectionsPath)});const r=await p.review.receipts(${JSON.stringify(answer.attemptId)},{deadlineEpochMs:Date.now()+5000,signal:new AbortController().signal});if(Object.keys(r).length!==8||r.firstEffectEvidence.attempt.callKind!=="adjudicator_1"||r.resolverEffectEvidence.attempt.callKind!=="resolver")process.exit(2)`;
    await expect(execute(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: installed.consumerRoot, timeout: 10_000 })).resolves.toMatchObject({ stderr: "" });

    fixture.setReviewEvidence({ firstReceipt: full.firstReceipt,
      rawOutcomeEnvelopeSha256: full.rawOutcomeEnvelopeSha256,
      resolverReceipt: full.resolverReceipt, secondReceipt: full.secondReceipt });
    await expect(execute(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: installed.consumerRoot, timeout: 10_000 })).rejects.toMatchObject({ code: 1 });
  }, 60_000);

  it("routes installed adjudication and final admission commands and fails closed on missing phases",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "quality-packed-phases-"));
      const fixture = await createPackedPreflightFixture(root, installed.consumerRoot);
      for (const command of ["adjudicate", "final-admission"] as const) {
        await expect(execute(installed.bin, [command, fixture.phasePath,
          join(root, `${command}-status.json`)], { timeout: 30_000 }))
          .rejects.toMatchObject({ code: 1, stderr: "" });
      }
      expect(fixture.releaseRequests()).toBe(2);
    }, 60_000);

});

async function packAndInstall() {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await mkdir(join(packageRoot, "dist", "test"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "test", "stale-generated.test.js"), "stale");
  const packRoot = await mkdtemp(join(tmpdir(), "quality-npm-pack-"));
  const packed = await execute("npm", ["pack", "--silent", "--json", "--pack-destination", packRoot], {
    cwd: packageRoot, timeout: 120_000 });
  const result = (JSON.parse(packed.stdout) as { readonly filename: string;
    readonly files: readonly { readonly path: string }[] }[])[0]!;
  const archive = join(packRoot, result.filename); const consumerRoot = await mkdtemp(join(tmpdir(),
    "quality-npm-consumer-"));
  await execute("npm", ["install", "--prefix", consumerRoot, "--ignore-scripts", "--omit=optional",
    "--package-lock=false", archive], { timeout: 60_000 });
  return { bin: join(consumerRoot, "node_modules", ".bin",
    "discord-meeting-quality-campaign"), consumerRoot,
  files: result.files.map(({ path }) => path) };
}

async function createPackedPreflightFixture(root: string, consumerRoot: string) {
  let observedProviderRequests = 0; let observedReleaseRequests = 0;
  let release: unknown; let reviewEvidence: unknown = {};
  let providerSigner: ReturnType<typeof localSigner> | undefined;
  const server = createServer((request, response) => {if (request.url === "/release") {
    observedReleaseRequests += 1; response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(release)); return;} if (request.url === "/review") {
    request.resume(); request.on("end", () => {response.writeHead(200,
      { "content-type": "application/json" }); response.end(JSON.stringify(reviewEvidence));});
    return;}
    if (request.url === "/provider") {
      const chunks: Buffer[] = []; request.on("data", (chunk) => {chunks.push(Buffer.from(chunk));});
      request.on("end", () => {
        observedProviderRequests += 1; response.writeHead(200, { "content-type": "application/json" });
        if (observedProviderRequests > 1) {response.end(JSON.stringify({ effect: "unknown" })); return;}
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { readonly attempt:
          Record<string, unknown>; readonly requestDigestSha256: string };
        const resultEnvelope = Buffer.from(canonicalJson({ attemptId: body.attempt.attemptId,
          schemaVersion: "meeting_knowledge.semantic_quality_packed_result.v1" }));
        const resultDigestSha256 = sha256(resultEnvelope);
        const signedResult = providerSigner!.signed({ ...body.attempt,
          providerAccounting: qualificationProviderAccountingFixture(
            release as QualityCampaignRelease, String(body.attempt.callKind) as
              "answer" | "capability" | "retrieval"),
          requestDigestSha256: body.requestDigestSha256, resultDigestSha256,
          schemaVersion: "meeting_knowledge.semantic_quality_provider_terminal_payload.v4",
          state: "terminal_success" });
        response.end(JSON.stringify({ effect: "certain_success", resultDigestSha256,
          resultEnvelopeBase64: resultEnvelope.toString("base64"), signedResult }));
      }); return;
    }
    response.writeHead(500).end();
  });
  servers.push(server); await new Promise<void>((resolve) => {server.listen(0, "127.0.0.1",
    () => {resolve();});}); const address = server.address();
  if (address === null || typeof address === "string") {throw new Error("fake HTTP bind failed");}
  const base = `http://127.0.0.1:${address.port}`;
  const authorities = Object.fromEntries(["absence", "custody", "deletion", "evidence", "gold-relevance",
    "execution", "holdout", "holdout-evidence", "holdout-result", "holdout-spend-call", "judge1",
    "judge2", "main-result", "release", "resolver", "reviewer1", "reviewer2", "spend", "spend-call"]
    .map((name) => [name, localSigner(name)]));
  providerSigner = authorities["main-result"]!;
  const authorityPaths: Record<string, string> = {};
  for (const [name, value] of Object.entries(authorities)) {const publicKeyPath = join(root,
    `${name}.pem`); await writeFile(publicKeyPath, value.publicKeyPem); const path = join(root,
      `${name}-authority.json`); await writeFile(path, canonicalJson({ keyId: value.keyId,
        publicKeyPath })); authorityPaths[name] = path;}
  const releaseSigner = authorities.release!; const releasePublicKeyPath = join(root,
    "release.pem");
  const roleNames = { artifact_custody: "custody", cleanup: "absence",
    gold_relevance: "gold-relevance",
    holdout_authorization: "holdout", holdout_provider_result: "holdout-result",
    holdout_question: "holdout-evidence",
    inventory: "deletion", locator: "evidence", main_proof: "execution",
    provider_result: "main-result", release: "release", repetition: "judge1",
    resolver: "resolver", reviewer_1: "reviewer1", reviewer_2: "reviewer2",
    spend: "spend" } as const;
  const policyInput = Object.fromEntries(Object.entries(roleNames).map(([role, name]) => {
    const authority = authorities[name]!; return [role, { keyId: authority.keyId,
      publicKeyFingerprintSha256: fingerprint(authority.publicKeyPem),
      publicKeyPem: authority.publicKeyPem }];}));
  const policyBindingSha256 = sha256(Object.entries(roleNames).map(([role, name]) => ({ keyId:
    authorities[name]!.keyId, publicKeyFingerprintSha256: fingerprint(
      authorities[name]!.publicKeyPem), role })));
  const authorityPolicyPath = join(root, "authority-policy.json"); await writeFile(
    authorityPolicyPath, canonicalJson(Object.fromEntries(Object.entries(roleNames).map(
      ([role, name]) => [role, authorityPaths[name]]))));
  const d = (value: string) => digest(value); release = { answerImageSha256: d("answer-image"),
    answerProcessIdentitySha256: d("answer-process"), answerReleaseSha256: d("answer-release"),
    artifactKeyCustodySha256: fingerprint(authorities.custody!.publicKeyPem),
    authorityPolicySha256: policyBindingSha256,
    discordCommitSha256: d("discord-commit"), discordImageSha256: d("discord-image"),
    discordReleaseSha256: d("discord-release"), infinityCapabilitySha256: d("capability"),
    infinityCommitSha256: d("infinity-commit"), infinityImageSha256: d("infinity-image"),
    infinityProfileSha256: d("profile"), infinityReleaseSha256: d("infinity-release"),
    mapperSha256: d("mapper"), model: "gpt-5.6-sol", policySha256: d("policy"),
    promptSha256: d("prompt"), reasoning: "xhigh", sdkArchiveSha256: d("sdk"),
    serviceTier: "default", targetInventoryAuthorityKeySha256:
    fingerprint(authorities.deletion!.publicKeyPem), tokenizerSha256: d("tokenizer") };
  const releaseDocument = releaseSigner.signed(release); const releaseRootSha256 = sha256(
    releaseDocument); const releaseRootPath = join(root, "release.json"); await writeFile(
      releaseRootPath, canonicalJson(releaseDocument));
  const question = (source: "automatic" | "independent_review", prefix: string, index: number) => {
    const id = `${prefix}-${index}`; return { locale: index % 2 === 0 ? "en" : "ru",
      questionDigestSha256: digest(`question:${id}`), questionId: id,
      rubricDigestSha256: digest(`rubric:${id}`), source };};
  const automatic = Array.from({ length: 200 }, (_, index) => question("automatic", "a", index));
  const reviewed = Array.from({ length: 40 }, (_, index) => question("independent_review", "r", index));
  const questions = [...automatic, ...reviewed]; const custody = authorities.custody!;
  const corpusDigestSha256 = d("corpus");
  const reviewerDigestSha256 = d("reviewers"); const sourceDigestSha256 = d("source");
  const acceptance = custody.signed({ corpusDigestSha256, purpose: "custody_only",
    reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_acceptance.v1",
    sourceDigestSha256 }); const authorization = custody.signed({ acceptanceReceiptSha256:
    sha256(acceptance), authorizedProviderExecution: true, corpusDigestSha256,
    expiresAtEpochMs: 4_000_000_000_000, releaseRootSha256, schemaVersion:
    "meeting_knowledge.semantic_quality_execution_authorization.v1" });
  const reviewPayload = { corpusDigestSha256, questionSetSha256: sha256(questions),
    reviewerDigestSha256, rubricSetSha256: sha256(questions.map(({ questionId,
      rubricDigestSha256 }) => ({ questionId, rubricDigestSha256 }))), schemaVersion:
    "meeting_knowledge.semantic_quality_question_review.v1" }; const locator = { entriesSha256:
    d("locators"), releaseRootSha256, schemaVersion:
    "meeting_knowledge.semantic_quality_locator_authority.v1", snapshotSha256: d("snapshot") };
  const files: Record<string, unknown> = { "acceptance.json": acceptance,
    "authorization.json": authorization, "automatic.json": automatic, "forbidden.json":
    custody.signed(locator), "mapping.json": custody.signed(locator), "review-1.json":
    authorities.reviewer1!.signed(reviewPayload), "review-2.json":
    authorities.reviewer2!.signed(reviewPayload), "reviewed.json": reviewed };
  for (const [name, value] of Object.entries(files)) {await writeFile(join(root, name),
    canonicalJson(value));}
  const checksumInventory = await Promise.all(Object.keys(files).map(async (path) => ({ path,
    sha256: digestBytes(await readFile(join(root, path))) })));
  const manifestPath = join(root, "InputManifest.v4.json"); await writeFile(manifestPath,
    canonicalJson({ acceptanceReceiptPath: "acceptance.json", checksumInventory,
      corpusDigestSha256, executionAuthorizationPath: "authorization.json",
      forbiddenLocatorManifestPath: "forbidden.json", independentReviewQuestionsPath:
      "reviewed.json", questionReviewReceiptPaths: ["review-1.json", "review-2.json"],
      reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_input_manifest.v4",
      sealedAutomaticQuestionsPath: "automatic.json", sourceDigestSha256,
      turnToBlockManifestPath: "mapping.json" }));
  const probe = await execute(process.execPath, ["--input-type=module", "--eval",
    `import{admitMainCampaign,QualityCampaignAuthorityPolicy}from"@discord-meeting/infinity-context-adapter/quality-campaign";const p=new QualityCampaignAuthorityPolicy(${JSON.stringify(policyInput)});const a=await admitMainCampaign(p,${JSON.stringify({ authorityKeyId: custody.keyId,
      manifestPath, nowEpochMs: Date.now(), releaseRootSha256,
      reviewerAuthorityKeyIds: [authorities.reviewer1!.keyId,
        authorities.reviewer2!.keyId] })});process.stdout.write(a.rootBindingSha256)`],
  { cwd: consumerRoot, timeout: 30_000 }); const mainRootSha256 = probe.stdout;
  const spendReservationsPath = join(root, "spend.json");
  await writeFile(spendReservationsPath, canonicalJson(([1, 2, 3] as const).map((repetition) =>
    authorities.spend!.signed({ allowedCallKinds: ["answer", "capability", "retrieval",
      "adjudicator_1", "adjudicator_2", "resolver"], campaignRootSha256: mainRootSha256,
    expiresAtEpochMs: 4_000_000_000_000, maxCalls: 1_440, maxEncryptedBytes: 100_000_000,
    maxCallsByKind: { adjudicator_1: 240, adjudicator_2: 240, answer: 240, capability: 240,
      resolver: 240, retrieval: 240 }, maximumEffectDurationMs: 120_000,
    maxTokens: 10_000_000, model: "gpt-5.6-sol", provider: "local-fake-http",
    reasoning: "xhigh", releaseRootSha256, repetition, serviceTier: "default" }))));
  const protectedEvidence = ["original_craig_recording", "final_transcript", "meeting_database",
    "frozen_snapshot", "frozen_signed_root"].map((kind) => ({ artifactId: `custody-${kind}`,
      artifactSha256: d(kind), kind }));
  const custodyPath = join(root, "custody.json"); await writeFile(custodyPath, canonicalJson(
    custody.signed({ loadedLocatorDigests: [d("main-locator")], loadedQuestionDigests:
      questions.map(({ questionDigestSha256 }) => questionDigestSha256), mainInputRootSha256:
      mainRootSha256,
      mainKeyNamespace: "main:packed", protectedEvidence, releaseRootSha256, schemaVersion:
      "meeting_knowledge.semantic_quality_authoritative_custody.v2", tuningEvidenceDigests:
      [d("tuning")] })));
  const tokenPath = join(root, "token"); await writeFile(tokenPath, "local-token");
  const evidenceKeyPath = join(root, "evidence.key"); const holdoutEvidenceKeyPath = join(root,
    "holdout-evidence.key"); await writeFile(evidenceKeyPath, Buffer.alloc(32, 1).toString("base64"));
  await writeFile(holdoutEvidenceKeyPath, Buffer.alloc(32, 2).toString("base64"));
  const endpoint = `${base}/unused`; const providerEndpoint = `${base}/provider`;
  const connectionsPath = join(root, "connections.json");
  await writeFile(connectionsPath, canonicalJson({ absenceAuthority: publicHttp(authorities.absence!, root),
    absenceEndpoint: `${base}/absence`, adjudicators: ["judge1", "judge2", "resolver"].map((name) => ({
      ...publicHttp(authorities[name]!, root), endpoint })), answerEndpoint: providerEndpoint,
    artifactCustody: { envelopeRoot: root, keyCustodySha256:
      fingerprint(authorities.custody!.publicKeyPem), keyId: "retention-key",
      keyPath: evidenceKeyPath }, capabilityEndpoint: providerEndpoint,
    credentialPath: tokenPath, deletionAuthority: publicHttp(authorities.deletion!, root),
    deletionEndpoint: `${base}/deletion`, evidenceAuthority: publicHttp(authorities.evidence!, root),
    evidenceEndpoint: endpoint, evidenceKeyId: "main-key", evidenceKeyPath,
    holdoutAnswerEndpoint: endpoint, holdoutCapabilityEndpoint: endpoint,
    holdoutEvidenceAuthority: publicHttp(authorities["holdout-evidence"]!, root),
    holdoutEvidenceEndpoint: endpoint, holdoutEvidenceKeyId: "holdout-key", holdoutEvidenceKeyPath,
    holdoutProviderResultAuthority: publicHttp(authorities["holdout-result"]!, root),
    holdoutRetrievalEndpoint: endpoint,
    providerResultAuthority: publicHttp(authorities["main-result"]!, root),
    rawOutcomeEndpoint: `${base}/review`, releaseObservationEndpoint: `${base}/release`, retrievalEndpoint:
    providerEndpoint, schemaVersion: "meeting_knowledge.semantic_quality_http_connections.v3" }));
  const unused = join(root, "unused.json"); const configPath = join(root, "operator.json");
  await writeFile(configPath, canonicalJson({ absenceAuthorityPath: authorityPaths.absence,
    adjudicationAuthorityPaths: [authorityPaths.judge1, authorityPaths.judge2,
      authorityPaths.resolver], admissionAuthorityPath: authorityPaths.custody,
    authoritativeEvidenceInventoryPath: custodyPath, authorityPolicyPath,
    checkpointRoot: join(root, "checkpoints"),
    cleanupPlanPath: unused, concurrency: 2, deletionAuthorityPath: authorityPaths.deletion,
    holdoutAuthorityPath: authorityPaths.holdout,
    holdoutCleanupPlanPath: unused, holdoutInputPath: unused, holdoutJournalRoot: join(root,
      "holdout-journal"), journalRoot: join(root, "journal"), mainManifestPath:
    manifestPath, releaseAuthorityPublicKeyPath: releasePublicKeyPath, releaseRootPath,
    repetitionAuthorityPath: authorityPaths.judge1,
    reviewerAuthorityPaths: [authorityPaths.reviewer1, authorityPaths.reviewer2], schemaVersion:
    "meeting_knowledge.semantic_quality_production_operator.v4", spendAuthorityPath:
    authorityPaths.spend, spendReservationsPath }));
  const phasePath = join(root, "phase.json"); await writeFile(phasePath, canonicalJson({ payload:
    { configurationPath: configPath, connectionsPath }, schemaVersion:
    "meeting_knowledge.semantic_quality_production_phase.v1" }));
  return { connectionsPath, phasePath, releaseRequests: () => observedReleaseRequests,
    providerRequests: () => observedProviderRequests,
    setReviewEvidence(value: unknown) {reviewEvidence = value;} };
}

function packedReviewEvidence(answer: ReturnType<typeof attemptIdentity>) {
  const effect = (kind: "adjudicator_1_result" | "adjudicator_2_result" | "resolver_result") => ({
    attempt: artifactAttemptIdentity(answer, kind), cancellationBoundary: "not_cancelled" as const,
    deadlineEpochMs: Date.now() + 60_000, requestDigestSha256: digest(`${kind}:request`),
    resultDigestSha256: digest(`${kind}:result`), signedDurableExchange:
      unsignedPackedTransportValue(`${kind}:durable`), signedProviderTerminal:
      unsignedPackedTransportValue(`${kind}:terminal`) });
  return { firstEffectEvidence: effect("adjudicator_1_result"), firstReceipt:
    unsignedPackedTransportValue("first"),
    predecessorPlaintextSha256: digest("packed-predecessor"),
    rawOutcomeEnvelopeSha256: digest("packed-raw-outcome"),
    resolverEffectEvidence: effect("resolver_result"), resolverReceipt:
      unsignedPackedTransportValue("resolver"), secondEffectEvidence:
      effect("adjudicator_2_result"), secondReceipt: unsignedPackedTransportValue("second") };
}

function unsignedPackedTransportValue(label: string) {
  return { payload: { label }, signatureBase64: "AA==", signerKeyId: "main-result" };
}

function localSigner(keyId: string) {const pair = generateKeyPairSync("ed25519"); const publicKeyPem =
  pair.publicKey.export({ format: "pem", type: "spki" }).toString(); return { keyId, publicKeyPem,
  signed<T>(payload: T) {return { payload, signatureBase64: sign(null, Buffer.from(canonicalJson(
    payload)), pair.privateKey).toString("base64"), signerKeyId: keyId };} };}
function publicHttp(value: ReturnType<typeof localSigner>, root: string) {return { keyId:
  value.keyId, publicKeyPath: join(root, `${value.keyId}.pem`) };}
function canonicalJson(value: unknown): string {return JSON.stringify(canonical(value));}
function canonical(value: unknown): unknown {if (value === null || typeof value !== "object") {
  return value;} if (Array.isArray(value)) {return value.map(canonical);} return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));}
function sha256(value: unknown) {return digestBytes(value instanceof Uint8Array ? value : Buffer.from(
  canonicalJson(value)));}
function digestBytes(value: Uint8Array) {return createHash("sha256").update(value).digest("hex");}
function digest(value: string) {return digestBytes(Buffer.from(value));}
function fingerprint(publicKeyPem: string) {return createHash("sha256").update(createPublicKey(
  publicKeyPem).export({ format: "der", type: "spki" })).digest("hex");}
