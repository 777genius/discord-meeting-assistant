import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { admitAcceptedFinalMeeting, buildHistoricalIndexPlan,
  createHistoricalReleaseBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { Meeting } from "@discord-meeting/meeting-core/meeting-lifecycle";
import { FinalTranscript } from "@discord-meeting/meeting-core/transcription";
import { canonicalJsonSha256 } from "@discord-meeting/subscription-runtime-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { artifactAttemptIdentity, attemptIdentity,
  type QualityCampaignRelease } from "../src/quality-campaign/index.js";
import { HmacHistoricalOpaqueIds } from "../src/hmac-historical-ids.js";
import { retrievalV2CapabilityFingerprint } from "../src/infinity-context-retrieval-v2.js";
import { recoverProductionCanonicalOutcome } from
  "../src/quality-campaign/production-canonical-execution-evidence.js";
import { qualificationProviderAccountingFixture } from
  "./quality-campaign-provider-accounting-fixture.js";

const execute = promisify(execFile);
const servers: ReturnType<typeof createServer>[] = [];
const require = createRequire(import.meta.url);
const subscriptionRequire = createRequire(new URL(
  "../../subscription-runtime-adapter/package.json", import.meta.url));
interface TestGrpcServer { addService(service: Record<string, unknown>, implementation: object): void;
  bindAsync(address: string, credentials: unknown,
    callback: (error: Error | null, port: number) => void): void;
  tryShutdown(callback: () => void): void }
const grpc = subscriptionRequire("@grpc/grpc-js") as {
  readonly Server: new() => TestGrpcServer;
  readonly ServerCredentials: { createInsecure(): unknown };
  loadPackageDefinition(value: unknown): unknown };
const protoLoader = subscriptionRequire("@grpc/proto-loader") as {
  loadSync(path: string, options: Record<string, unknown>): unknown };
const grpcServers: TestGrpcServer[] = [];
let installed!: Awaited<ReturnType<typeof packAndInstall>>;
let localHttpsFixturePromise: Promise<{
  readonly certificate: string;
  readonly certificatePath: string;
  readonly privateKey: string;
}> | undefined;

beforeAll(async () => {installed = await packAndInstall();}, 180_000);
afterAll(async () => {await Promise.all(servers.splice(0).map(async (server) => {
  await new Promise<void>((resolve) => {server.close(() => {resolve();});});
})); await Promise.all(grpcServers.splice(0).map(async (server) => {
  await new Promise<void>((resolve) => {server.tryShutdown(() => {resolve();});});
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

  it("executes the packed official SDK, selected PostgreSQL evidence and grounded answer chain",
    async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-packed-command-"));
    const fixture = await createPackedPreflightFixture(root, installed.consumerRoot);
    const statusPath = join(root, "preflight-status.json");
    await expect(execute(installed.bin, ["preflight", fixture.phasePath, statusPath], {
      env: fixture.childEnvironment, timeout: 30_000 })).rejects.toMatchObject({ code: 20,
        stderr: "" });
    expect(fixture.releaseRequests()).toBe(1);
    expect(await readFile(statusPath, "utf8")).toMatch(/"status":"paused"/u);
    const executeStatusPath = join(root, "execute-status.json");
    await expect(execute(installed.bin, ["execute", fixture.phasePath, executeStatusPath], {
      env: fixture.childEnvironment, timeout: 60_000 })).rejects.toMatchObject({ code: 21,
        stderr: "" });
    expect(fixture.providerRequests()).toBe(0);
    expect(fixture.retrievalRequests()).toBeGreaterThan(0);
    expect(await readFile(executeStatusPath, "utf8")).toMatch(/"status":"outcome_unknown"/u);
    const selectedReads = JSON.parse(await readFile(fixture.postgresAuditPath, "utf8")) as string[];
    expect(selectedReads.length).toBeGreaterThan(0);
    expect(new Set(selectedReads)).toEqual(new Set([fixture.selectedLocator]));
    expect(fixture.answerPrompts().some((prompt) => prompt.includes(fixture.selectedText))).toBe(true);
    expect(fixture.answerPrompts().every((prompt) => !prompt.includes(fixture.unselectedText)))
      .toBe(true);
    await expect(recoverProductionCanonicalOutcome(fixture.recovery)).resolves.toMatchObject({
      citations: [fixture.selectedTurnId], status: "answered",
    });
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
      cwd: installed.consumerRoot, env: fixture.childEnvironment,
      timeout: 10_000 })).resolves.toMatchObject({ stderr: "" });

    fixture.setReviewEvidence({ firstReceipt: full.firstReceipt,
      rawOutcomeEnvelopeSha256: full.rawOutcomeEnvelopeSha256,
      resolverReceipt: full.resolverReceipt, secondReceipt: full.secondReceipt });
    await expect(execute(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: installed.consumerRoot, env: fixture.childEnvironment,
      timeout: 10_000 })).rejects.toMatchObject({ code: 1 });
  }, 60_000);

  it("routes installed adjudication and final admission commands and fails closed on missing phases",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "quality-packed-phases-"));
      const fixture = await createPackedPreflightFixture(root, installed.consumerRoot);
      for (const command of ["adjudicate", "final-admission"] as const) {
        await expect(execute(installed.bin, [command, fixture.phasePath,
          join(root, `${command}-status.json`)], { env: fixture.childEnvironment,
            timeout: 30_000 }))
          .rejects.toMatchObject({ code: 1, stderr: "" });
      }
      expect(fixture.releaseRequests()).toBe(2);
    }, 60_000);

});

async function packAndInstall() {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const workspaceRoot = dirname(dirname(packageRoot));
  await mkdir(join(packageRoot, "dist", "test"), { recursive: true });
  await writeFile(join(packageRoot, "dist", "test", "stale-generated.test.js"), "stale");
  const packRoot = await mkdtemp(join(tmpdir(), "quality-npm-pack-"));
  await execute(process.execPath, [join(packageRoot, "scripts", "clean-dist.mjs")], {
    cwd: packageRoot, timeout: 30_000 });
  const typescriptRoot = dirname(require.resolve("typescript/package.json"));
  await execute(process.execPath, [join(typescriptRoot, "bin", "tsc"), "--project",
    join(packageRoot, "tsconfig.build.json"), "--pretty", "false"], { cwd: packageRoot,
    timeout: 120_000 });
  await execute(process.execPath, [join(packageRoot, "scripts", "packed-manifest.mjs"), "prepare"],
    { cwd: packageRoot, timeout: 30_000 });
  let packed;
  try {packed = await execute("npm", ["pack", "--ignore-scripts", "--silent", "--json",
    "--pack-destination", packRoot], { cwd: packageRoot, timeout: 120_000 });}
  finally {await execute(process.execPath, [join(packageRoot, "scripts", "packed-manifest.mjs"),
    "restore"], { cwd: packageRoot, timeout: 30_000 });}
  const result = (JSON.parse(packed.stdout) as { readonly filename: string;
    readonly files: readonly { readonly path: string }[] }[])[0]!;
  const archive = join(packRoot, result.filename); const consumerRoot = await mkdtemp(join(tmpdir(),
    "quality-npm-consumer-"));
  await execute("npm", ["install", "--prefix", consumerRoot, "--ignore-scripts", "--omit=optional",
    "--package-lock=false", archive], { timeout: 60_000 });
  const discordModules = join(consumerRoot, "node_modules", "@discord-meeting");
  const infinityModules = join(consumerRoot, "node_modules", "@infinity-context");
  await Promise.all([mkdir(discordModules, { recursive: true }), mkdir(infinityModules,
    { recursive: true })]);
  for (const packageName of ["meeting-core", "meeting-routing-core", "postgres-adapter",
    "subscription-runtime-adapter"] as const) {
    await symlink(join(workspaceRoot, "packages", packageName), join(discordModules, packageName),
      "dir");
  }
  const sdkRoot = dirname(dirname(require.resolve("@infinity-context/sdk")));
  await symlink(sdkRoot, join(infinityModules, "sdk"), "dir");
  await installDisposablePgModule(consumerRoot);
  return { bin: join(consumerRoot, "node_modules", ".bin",
    "discord-meeting-quality-campaign"), consumerRoot,
  files: result.files.map(({ path }) => path) };
}

function packedRelease(authorities: Record<string, ReturnType<typeof localSigner>>,
  capability: Record<string, unknown>, policyBindingSha256: string): QualityCampaignRelease {
  const d = (value: string) => digest(value);
  return { answerImageSha256: d("answer-image"),
    answerProcessIdentitySha256: d("answer-process"), answerReleaseSha256: d("answer-release"),
    artifactKeyCustodySha256: fingerprint(authorities.custody!.publicKeyPem),
    authorityPolicySha256: policyBindingSha256,
    discordCommitSha256: d("discord-commit"), discordImageSha256: d("discord-image"),
    discordReleaseSha256: d("discord-release"), infinityCapabilitySha256: sha256(capability),
    infinityCommitSha256: d("infinity-commit"), infinityImageSha256: d("infinity-image"),
    infinityProfileSha256: d("profile"), infinityReleaseSha256: d("infinity-release"),
    mapperSha256: d("mapper"), model: "gpt-5.6-sol", policySha256: d("policy"),
    promptSha256: d("prompt"), reasoning: "medium", sdkArchiveSha256: d("sdk"),
    serviceTier: "default", targetInventoryAuthorityKeySha256:
    fingerprint(authorities.deletion!.publicKeyPem), tokenizerSha256: d("tokenizer") };
}

function packedQuestion(source: "automatic" | "independent_review", prefix: string,
  index: number) {
  const id = `${prefix}-${index}`;
  const locale = index % 2 === 0 ? "en" as const : "ru" as const;
  return { locale, questionDigestSha256: sha256(packedExecutionPacket(id, locale, source)), questionId: id,
    rubricDigestSha256: digest(`rubric:${id}`), source };
}

function packedExecutionPacket(questionId: string, locale: "en" | "ru",
  source: "automatic" | "independent_review") {
  return { locale, questionId, questionText: `Packed question ${questionId}?`,
    scopeTopologyReference: `scope:${questionId}`, source };
}

interface PackedAdmittedExecutionCorpusInput {
  readonly acceptance: unknown;
  readonly authorities: Record<string, ReturnType<typeof localSigner>>;
  readonly authorization: unknown;
  readonly automatic: readonly ReturnType<typeof packedQuestion>[];
  readonly corpusDigestSha256: string;
  readonly custody: ReturnType<typeof localSigner>;
  readonly files: Readonly<Record<string, unknown>>;
  readonly mainRootSha256: string;
  readonly manifestPath: string;
  readonly questions: readonly ReturnType<typeof packedQuestion>[];
  readonly releaseRootSha256: string;
  readonly reviewed: readonly ReturnType<typeof packedQuestion>[];
  readonly root: string;
  readonly selectedLocator: string;
}

async function createPackedAdmittedExecutionCorpus(input: PackedAdmittedExecutionCorpusInput) {
  const executionRoot = join(input.root, "admitted-execution");
  await mkdir(executionRoot, { mode: 0o700 });
  const executionCorpusPath = join(executionRoot, "execution-corpus.json");
  const executionCorpus = input.custody.signed({ campaignRootSha256:
    input.mainRootSha256, packets: input.questions.map((question) => packedExecutionPacket(
      question.questionId, question.locale, question.source)),
    schemaVersion: "meeting_knowledge.quality_execution_corpus.v1" });
  await writeFile(executionCorpusPath, canonicalJson(executionCorpus));
  const admittedLocatorIds = [input.selectedLocator];
  const admittedArtifacts: Readonly<Record<string, unknown>> = {
    "InputManifest.v4.json": JSON.parse(await readFile(input.manifestPath, "utf8")) as unknown,
    "acceptance-receipt.json": input.acceptance, "automatic-questions.json": input.automatic,
    "execution-authorization.json": input.authorization,
    "forbidden-locator-manifest.json": input.files["forbidden-locator-manifest.json"],
    "forbidden-locators.json": input.authorities.evidence!.signed({ campaignRootSha256:
      input.mainRootSha256, forbiddenLocatorIds: [digest("packed-forbidden-locator")],
      questionSetSha256: sha256(input.questions), releaseRootSha256: input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_forbidden_locators.v2" }),
    "gold-relevance.json": input.authorities["gold-relevance"]!.signed({ campaignRootSha256:
      input.mainRootSha256, entries: input.questions.map((question) => ({ ...question,
        campaignRootSha256: input.mainRootSha256, expectedAbstention: false, releaseRootSha256:
        input.releaseRootSha256, relevantLocatorIds: admittedLocatorIds })), releaseRootSha256:
      input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_gold_relevance.v1" }),
    "independent-review-questions.json": input.reviewed,
    "locator-inventory.json": input.authorities.evidence!.signed({ campaignRootSha256:
      input.mainRootSha256, locatorIds: admittedLocatorIds, releaseRootSha256:
      input.releaseRootSha256,
      schemaVersion: "meeting_knowledge.semantic_quality_locator_inventory.v1" }),
    "question-review-1.json": input.files["question-review-1.json"],
    "question-review-2.json": input.files["question-review-2.json"],
    "turn-to-block-manifest.json": input.files["turn-to-block-manifest.json"],
  };
  for (const [name, value] of Object.entries(admittedArtifacts)) {
    await writeFile(join(executionRoot, name), canonicalJson(value));
  }
  const admittedArtifactNames = [...Object.keys(admittedArtifacts), "execution-corpus.json"];
  const artifactInventory = await Promise.all(admittedArtifactNames.map(async (path) => ({ path,
    sha256: digestBytes(await readFile(join(executionRoot, path))) })));
  await writeFile(join(executionRoot, "corpus-admission-manifest.json"), canonicalJson({
    artifactInventory, authorizationComparisonEpochMs: Date.now(), campaignRootSha256:
    input.mainRootSha256, completionState: "complete", corpusDigestSha256:
    input.corpusDigestSha256, questionCount: input.questions.length, questionSetSha256:
    sha256(input.questions), releaseRootSha256: input.releaseRootSha256, schemaVersion:
    "meeting_knowledge.semantic_quality_corpus_admission_manifest.v1" }));
  return executionCorpusPath;
}

async function createPackedPreflightFixture(root: string, consumerRoot: string) {
  let observedProviderRequests = 0; let observedReleaseRequests = 0;
  let observedRetrievalRequests = 0;
  let release: unknown; let reviewEvidence: unknown = {};
  let providerSigner: ReturnType<typeof localSigner> | undefined;
  const memory = canonicalMemoryFixture();
  const capability = sdkQualificationCapability();
  const retrievalSuccess = sdkRetrievalResponse(memory.selectedLocator, capability);
  const tls = await localHttpsFixture();
  const childEnvironment = { ...process.env, NODE_EXTRA_CA_CERTS: tls.certificatePath };
  const server = createServer({ cert: tls.certificate, key: tls.privateKey },
    (request, response) => {if (request.url === "/release") {
    observedReleaseRequests += 1; response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(release)); return;} if (request.url === "/review") {
    request.resume(); request.on("end", () => {response.writeHead(200,
      { "content-type": "application/json" }); response.end(JSON.stringify(reviewEvidence));});
    return;}
    if (request.url === "/v1/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ context: { retrieval: capability } })); return;
    }
    if (request.url === "/v1/context/retrieve") {
      observedRetrievalRequests += 1; request.resume();
      request.on("end", () => {
        if (observedRetrievalRequests > 2) {response.destroy(); return;}
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(retrievalSuccess));
      }); return;
    }
    if (request.url === "/provider") {
      const chunks: Uint8Array[] = []; request.on("data", (chunk: Uint8Array) => {chunks.push(chunk);});
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
  const base = `https://127.0.0.1:${address.port}`;
  const { authorities, authorityPaths, policyBindingSha256, policyInput } =
    await createPackedAuthorities(root);
  providerSigner = authorities["main-result"]!;
  const releaseSigner = authorities.release!; const releasePublicKeyPath = join(root,
    "release.pem");
  const roleNames = packedAuthorityRoleNames();
  const authorityPolicyPath = join(root, "authority-policy.json"); await writeFile(
    authorityPolicyPath, canonicalJson(Object.fromEntries(Object.entries(roleNames).map(
      ([role, name]) => [role, authorityPaths[name]]))));
  const d = (value: string) => digest(value);
  release = packedRelease(authorities, capability, policyBindingSha256);
  const releaseDocument = releaseSigner.signed(release); const releaseRootSha256 = sha256(
    releaseDocument); const releaseRootPath = join(root, "release.json"); await writeFile(
      releaseRootPath, canonicalJson(releaseDocument));
  const automatic = Array.from({ length: 200 }, (_, index) => packedQuestion("automatic", "a", index));
  const reviewed = Array.from({ length: 40 }, (_, index) => packedQuestion("independent_review", "r", index));
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
    "meeting_knowledge.semantic_quality_question_review.v1" }; const mapping = {
    turnMappingsSha256: d("locators"), releaseRootSha256, schemaVersion:
    "meeting_knowledge.semantic_quality_locator_authority.v1", snapshotSha256: d("snapshot") };
  const forbidden = { forbiddenLocatorSetSha256: d("forbidden"), releaseRootSha256,
    schemaVersion: "meeting_knowledge.semantic_quality_locator_authority.v1",
    snapshotSha256: d("snapshot") };
  const files: Record<string, unknown> = { "acceptance-receipt.json": acceptance,
    "automatic-questions.json": automatic, "execution-authorization.json": authorization,
    "forbidden-locator-manifest.json": custody.signed(forbidden),
    "independent-review-questions.json": reviewed,
    "question-review-1.json": authorities.reviewer1!.signed(reviewPayload),
    "question-review-2.json": authorities.reviewer2!.signed(reviewPayload),
    "turn-to-block-manifest.json": custody.signed(mapping) };
  for (const [name, value] of Object.entries(files)) {await writeFile(join(root, name),
    canonicalJson(value));}
  const checksumInventory = await Promise.all(Object.keys(files).map(async (path) => ({ path,
    sha256: digestBytes(await readFile(join(root, path))) })));
  const manifestPath = join(root, "InputManifest.v4.json"); await writeFile(manifestPath,
    canonicalJson({ acceptanceReceiptPath: "acceptance-receipt.json", checksumInventory,
      corpusDigestSha256, executionAuthorizationPath: "execution-authorization.json",
      forbiddenLocatorManifestPath: "forbidden-locator-manifest.json",
      independentReviewQuestionsPath: "independent-review-questions.json",
      questionReviewReceiptPaths: ["question-review-1.json", "question-review-2.json"],
      reviewerDigestSha256, schemaVersion: "meeting_knowledge.semantic_quality_input_manifest.v4",
      sealedAutomaticQuestionsPath: "automatic-questions.json", sourceDigestSha256,
      turnToBlockManifestPath: "turn-to-block-manifest.json" }));
  const probe = await execute(process.execPath, ["--input-type=module", "--eval",
    `import{admitMainCampaign,QualityCampaignAuthorityPolicy}from"@discord-meeting/infinity-context-adapter/quality-campaign";const p=new QualityCampaignAuthorityPolicy(${JSON.stringify(policyInput)});const a=await admitMainCampaign(p,${JSON.stringify({ authorityKeyId: custody.keyId,
      manifestPath, nowEpochMs: Date.now(), releaseRootSha256,
      reviewerAuthorityKeyIds: [authorities.reviewer1!.keyId,
        authorities.reviewer2!.keyId] })});process.stdout.write(a.rootBindingSha256)`],
  { cwd: consumerRoot, timeout: 30_000 }); const mainRootSha256 = probe.stdout;
  const spendReservationsPath = join(root, "spend.json");
  const spendDocuments = ([1, 2, 3] as const).map((repetition) =>
    authorities.spend!.signed({ allowedCallKinds: ["answer", "capability", "retrieval",
      "adjudicator_1", "adjudicator_2", "resolver"], campaignRootSha256: mainRootSha256,
    expiresAtEpochMs: 4_000_000_000_000, maxCalls: 1_440, maxEncryptedBytes: 100_000_000,
    maxCallsByKind: { adjudicator_1: 240, adjudicator_2: 240, answer: 240, capability: 240,
      resolver: 240, retrieval: 240 }, maximumEffectDurationMs: 120_000,
    maxTokens: 10_000_000, model: "gpt-5.6-sol", provider: "local-fake-http",
    reasoning: "medium", releaseRootSha256, repetition, serviceTier: "default" }));
  await writeFile(spendReservationsPath, canonicalJson(spendDocuments));
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
  const { credentialPath, infinityTokenPath, runtimeTokenPath } =
    await createRoleSeparatedTokens(root);
  const evidenceKeyPath = join(root, "evidence.key"); const holdoutEvidenceKeyPath = join(root,
    "holdout-evidence.key"); await writeFile(evidenceKeyPath, Buffer.alloc(32, 1).toString("base64"));
  await writeFile(holdoutEvidenceKeyPath, Buffer.alloc(32, 2).toString("base64"));
  const capabilityPath = join(root, "infinity-capability.json");
  await writeFile(capabilityPath, canonicalJson(capability));
  const answerExecutionBindingPath = join(root, "answer-execution-binding.json");
  await writeFile(answerExecutionBindingPath, canonicalJson({ artifactBindingSha256: d("artifact"),
    campaignRunId: "packed-campaign", endpointIdentitySha256: d("endpoint"),
    processIdentitySha256: (release as QualityCampaignRelease).answerProcessIdentitySha256,
    promptMapperSha256: (release as QualityCampaignRelease).mapperSha256,
    serviceGenerationSha256: d("service-generation"), serviceIdentitySha256: d("service"),
    stableAttemptId: "packed-stable-attempt",
    tokenizerSha256: (release as QualityCampaignRelease).tokenizerSha256 }));
  const topologyKeyPath = join(root, "topology.key");
  await writeFile(topologyKeyPath, Buffer.alloc(32, 7));
  const topologyPath = join(root, "topology.json");
  await writeFile(topologyPath, canonicalJson(authorities["main-result"]!.signed({ entries:
    questions.map(({ questionId }) => ({ currentMeetingId: memory.binding.meetingId, questionId,
      reference: `scope:${questionId}`, roomId: memory.binding.roomId,
      scopeId: memory.binding.scopeId })),
  schemaVersion: "meeting_knowledge.quality_scope_topology.v1" })));
  const postgresAuditPath = join(root, "postgres-selected-locators.json");
  await writeFile(postgresAuditPath, "[]");
  const postgresFixturePath = join(root, "postgres-fixture.json");
  await writeFile(postgresFixturePath, canonicalJson({ auditPath: postgresAuditPath,
    meetingRevision: memory.snapshot.revision, meetingSnapshot: memory.snapshot, row: memory.row }));
  const postgresUrlPath = join(root, "postgres-url");
  await writeFile(postgresUrlPath, postgresFixturePath);
  const runtime = await startPackedGroundedAnswerRuntime(
    (release as QualityCampaignRelease).answerProcessIdentitySha256);
  const endpoint = `${base}/unused`;
  const canonicalExecution = { answerExecutionBindingPath,
    answerJournalRoot: join(root, "canonical-answer-journal"), artifactKeyId: "retention-key",
    artifactKeyPath: evidenceKeyPath, artifactRoot: join(root, "canonical-artifacts"),
    expectedRuntimeLauncherSha256: (release as QualityCampaignRelease).answerProcessIdentitySha256,
    infinityBaseUrl: base, infinityCapabilityPath: capabilityPath, infinityTokenPath,
    postgresUrlPath, requestTimeoutMs: 1_000,
    retrievalJournalRoot: join(root, "canonical-retrieval-journal"),
    runtimeAddress: runtime.address, runtimeTokenPath,
    topologyAuthority: publicHttp(authorities["main-result"]!, root),
    topologyKeyPath, topologyPath };
  const connectionsPath = join(root, "connections.json");
  await writeFile(connectionsPath, canonicalJson({ absenceAuthority: publicHttp(authorities.absence!, root),
    absenceEndpoint: `${base}/absence`, adjudicators: ["judge1", "judge2", "resolver"].map((name) => ({
      ...publicHttp(authorities[name]!, root), endpoint })),
    artifactCustody: { envelopeRoot: root, keyCustodySha256:
      fingerprint(authorities.custody!.publicKeyPem), keyId: "retention-key",
      keyPath: evidenceKeyPath }, canonicalExecution,
    credentialPath, deletionAuthority: publicHttp(authorities.deletion!, root),
    deletionEndpoint: `${base}/deletion`, evidenceAuthority: publicHttp(authorities.evidence!, root),
    evidenceEndpoint: endpoint, evidenceKeyId: "main-key", evidenceKeyPath,
    holdoutAnswerEndpoint: endpoint, holdoutCapabilityEndpoint: endpoint,
    holdoutEvidenceAuthority: publicHttp(authorities["holdout-evidence"]!, root),
    holdoutEvidenceEndpoint: endpoint, holdoutEvidenceKeyId: "holdout-key", holdoutEvidenceKeyPath,
    holdoutProviderResultAuthority: publicHttp(authorities["holdout-result"]!, root),
    holdoutRetrievalEndpoint: endpoint,
    providerResultAuthority: publicHttp(authorities["main-result"]!, root),
    rawOutcomeEndpoint: `${base}/review`, releaseObservationEndpoint: `${base}/release`,
    schemaVersion: "meeting_knowledge.semantic_quality_http_connections.v5" }));
  const auxiliary = roleSeparatedAuxiliaryPaths(root);
  const configPath = join(root, "operator.json");
  const executionCorpusPath = await createPackedAdmittedExecutionCorpus({ acceptance, authorities,
    authorization, automatic, corpusDigestSha256, custody, files, mainRootSha256, manifestPath,
    questions, releaseRootSha256, reviewed, root, selectedLocator: memory.selectedLocator });
  await writeFile(configPath, canonicalJson({ absenceAuthorityPath: authorityPaths.absence,
    adjudicationAuthorityPaths: [authorityPaths.judge1, authorityPaths.judge2,
      authorityPaths.resolver], admissionAuthorityPath: authorityPaths.custody,
    authoritativeEvidenceInventoryPath: custodyPath, authorityPolicyPath,
    checkpointRoot: join(root, "checkpoints"),
    cleanupPlanPath: auxiliary.cleanup, concurrency: 2, deletionAuthorityPath: authorityPaths.deletion,
    executionCorpusPath,
    holdoutAuthorityPath: authorityPaths.holdout,
    holdoutCleanupPlanPath: auxiliary.holdoutCleanup, holdoutInputPath: auxiliary.holdoutInput,
    holdoutJournalRoot: join(root,
      "holdout-journal"), journalRoot: join(root, "journal"), mainManifestPath:
    manifestPath, releaseAuthorityPublicKeyPath: releasePublicKeyPath, releaseRootPath,
    repetitionAuthorityPath: authorityPaths.repetition,
    reviewerAuthorityPaths: [authorityPaths.reviewer1, authorityPaths.reviewer2], schemaVersion:
    "meeting_knowledge.semantic_quality_production_operator.v4", spendAuthorityPath:
    authorityPaths.spend, spendReservationsPath }));
  const phasePath = join(root, "phase.json"); await writeFile(phasePath, canonicalJson({ payload:
    { configurationPath: configPath, connectionsPath }, schemaVersion:
    "meeting_knowledge.semantic_quality_production_phase.v1" }));
  const firstQuestion = questions[0]!;
  const firstAttempt = attemptIdentity({ callKind: "answer", callOrdinal: 0,
    campaignRootSha256: mainRootSha256, questionDigestSha256: firstQuestion.questionDigestSha256,
    questionId: firstQuestion.questionId, releaseRootSha256, repetition: 1,
    spendReservationSha256: sha256(spendDocuments[0]!) });
  return { answerPrompts: runtime.prompts, childEnvironment, connectionsPath, phasePath,
    postgresAuditPath,
    recovery: { answerJournalRoot: canonicalExecution.answerJournalRoot,
      artifactKey: new Uint8Array(32).fill(1), artifactRoot: canonicalExecution.artifactRoot,
      attemptId: firstAttempt.attemptId, questionId: firstQuestion.questionId, repetition: 1 as const,
      retrievalJournalRoot: canonicalExecution.retrievalJournalRoot,
      rootBindingSha256: mainRootSha256 }, releaseRequests: () => observedReleaseRequests,
    providerRequests: () => observedProviderRequests,
    retrievalRequests: () => observedRetrievalRequests, selectedLocator: memory.selectedLocator,
    selectedText: memory.selectedText, selectedTurnId: memory.selectedTurnId,
    unselectedText: memory.unselectedText,
    setReviewEvidence(value: unknown) {reviewEvidence = value;} };
}

async function localHttpsFixture() {
  localHttpsFixturePromise ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), "quality-local-tls-"));
    const certificatePath = join(root, "certificate.pem");
    const privateKeyPath = join(root, "private-key.pem");
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", privateKeyPath, "-out", certificatePath, "-days", "1", "-subj",
      "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], {
      timeout: 10_000 });
    const [certificate, privateKey] = await Promise.all([
      readFile(certificatePath, "utf8"), readFile(privateKeyPath, "utf8"),
    ]);
    return { certificate, certificatePath, privateKey };
  })();
  return await localHttpsFixturePromise;
}

async function createRoleSeparatedTokens(root: string) {
  const paths = { credentialPath: join(root, "provider-token"),
    infinityTokenPath: join(root, "infinity-token"), runtimeTokenPath: join(root, "runtime-token") };
  await Promise.all(Object.values(paths).map(async (path) => {
    await writeFile(path, "local-test-token-123");
  }));
  return paths;
}

async function createPackedAuthorities(root: string) {
  const names = ["absence", "custody", "deletion", "evidence", "gold-relevance", "execution",
    "holdout", "holdout-evidence", "holdout-result", "holdout-spend-call", "judge1", "judge2",
    "main-result", "release", "repetition", "resolver", "reviewer1", "reviewer2", "spend",
    "spend-call"];
  const authorities = Object.fromEntries(names.map((name) => [name, localSigner(name)]));
  const authorityPaths: Record<string, string> = {};
  for (const [name, value] of Object.entries(authorities)) {const publicKeyPath = join(root,
    `${name}.pem`); await writeFile(publicKeyPath, value.publicKeyPem); const path = join(root,
      `${name}-authority.json`); await writeFile(path, canonicalJson({ keyId: value.keyId,
        publicKeyPath })); authorityPaths[name] = path;}
  const roles = packedAuthorityRoleNames();
  const policyInput = Object.fromEntries(Object.entries(roles).map(([role, name]) => {const authority =
    authorities[name]!; return [role, { keyId: authority.keyId, publicKeyFingerprintSha256:
      fingerprint(authority.publicKeyPem), publicKeyPem: authority.publicKeyPem }];}));
  const policyBindingSha256 = sha256(Object.entries(roles).map(([role, name]) => ({ keyId:
    authorities[name]!.keyId, publicKeyFingerprintSha256: fingerprint(
      authorities[name]!.publicKeyPem), role })));
  return { authorities, authorityPaths, policyBindingSha256, policyInput };
}

function packedAuthorityRoleNames() {return { artifact_custody: "custody", cleanup: "absence",
  gold_relevance: "gold-relevance", holdout_authorization: "holdout",
  holdout_provider_result: "holdout-result", holdout_question: "holdout-evidence",
  inventory: "deletion", locator: "evidence", main_proof: "execution",
  provider_result: "main-result", release: "release", repetition: "repetition", resolver: "resolver",
  reviewer_1: "reviewer1", reviewer_2: "reviewer2", spend: "spend" } as const;}

function roleSeparatedAuxiliaryPaths(root: string) {return {
  cleanup: join(root, "cleanup-plan.json"), holdoutCleanup: join(root, "holdout-cleanup-plan.json"),
  holdoutInput: join(root, "holdout-input.json") } as const;}

function canonicalMemoryFixture() {
  const selectedText = "The launch proposal was approved by the review group.";
  const unselectedText = "UNSELECTED-OMEGA must never enter the grounded answer prompt.";
  const meeting = Meeting.record({ actors: [{ actorId: "speaker-a", kind: "human" },
    { actorId: "speaker-b", kind: "human" }], identityProvenance: {
    actorObservationState: "consistent", actorSemanticsVersion: 1,
    producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
    producerRevision: "0123456789abcdef0123456789abcdef01234567", rosterState: "sealed" },
  lifecycleGeneration: 3, meetingId: "packed-historical-meeting",
  publicationTargetId: "packed-publication", recording: { manifestLocator:
    "s3://synthetic/packed-historical-meeting/manifest.json",
  recordingId: "packed-recording", speakerAudio: [{ audioLocator: "s3://synthetic/a.flac",
    speakerId: "speaker-a", timelineOffsetMs: 0 }, { audioLocator: "s3://synthetic/b.flac",
    speakerId: "speaker-b", timelineOffsetMs: 0 }] }, source: { roomId: "packed-room",
    scopeId: "packed-scope" } });
  meeting.beginTranscription();
  const turns = Array.from({ length: 100 }, (_, index) => ({ endMs: index * 10_000 + 2_000,
    speakerId: index % 2 === 0 ? "speaker-a" : "speaker-b", startMs: index * 10_000,
    text: index === 0 ? selectedText : index === 99 ? unselectedText :
      `Synthetic canonical planning turn ${index}.`, turnId: `packed-turn-${index}` }));
  const transcript = FinalTranscript.create({ recordingId: meeting.recording.recordingId,
    transcriptId: "packed-transcript", turns, version: 1 });
  meeting.completeTranscription(transcript);
  const snapshot = meeting.toSnapshot();
  const binding = createHistoricalReleaseBinding({ acceptedMeetingRevision: snapshot.revision,
    desiredGeneration: 1, meetingId: snapshot.meetingId, roomId: snapshot.source!.roomId,
    scopeId: snapshot.source!.scopeId, transcriptId: transcript.transcriptId,
    transcriptVersion: transcript.version });
  const accepted = admitAcceptedFinalMeeting({ actors: snapshot.actors,
    authoritativeDurationMs: snapshot.recording.authoritativeDurationMs ?? null, binding,
    identityProvenance: snapshot.identityProvenance,
    lifecycleGeneration: snapshot.lifecycleGeneration, meetingRevision: snapshot.revision,
    roomId: snapshot.source!.roomId, scopeId: snapshot.source!.scopeId,
    transcriptId: transcript.transcriptId, transcriptVersion: transcript.version, turns });
  if (accepted === null) {throw new Error("packed historical meeting admission failed");}
  const plan = buildHistoricalIndexPlan(accepted,
    new HmacHistoricalOpaqueIds(new Uint8Array(32).fill(7)));
  if (plan.documents.length < 2 || plan.documents[0]!.manifest.turnSources.some(
    ({ turnId }) => turnId === "packed-turn-99")) {
    throw new Error("packed historical fixture did not create selected and unselected blocks");
  }
  const selectedTurnId = "packed-turn-0";
  return { binding, plan, row: { accepted_meeting_revision: binding.acceptedMeetingRevision,
    applied_index_profile_id: "packed-profile", attempt_count: 1,
    desired_generation: binding.desiredGeneration,
    evidence_policy_version: binding.evidencePolicyVersion, lease_fence: 1,
    meeting_id: binding.meetingId, operation: "index", plan,
    profile_rebuild_requested: false, release_id: binding.releaseId,
    remote_document_ids: {}, room_id: binding.roomId, schema_version: binding.schemaVersion,
    scope_id: binding.scopeId, transcript_id: binding.transcriptId,
    transcript_version: binding.transcriptVersion }, selectedLocator:
    plan.documents[0]!.manifest.candidateLocator, selectedText, selectedTurnId, snapshot,
  unselectedText };
}

function sdkFixture(name: "capability" | "success"): Record<string, unknown> {
  return JSON.parse(readFileSync(require.resolve(
    `@infinity-context/sdk/fixtures/context_retrieval_v2/${name}.json`), "utf8")) as
    Record<string, unknown>;
}

function sdkQualificationCapability(): Record<string, unknown> {
  const capability = sdkFixture("capability");
  capability.profile_id = `locator-v2-full-${String(capability.index_profile_digest)}`;
  capability.capability_fingerprint = retrievalV2CapabilityFingerprint(capability);
  return capability;
}

function sdkRetrievalResponse(locator: string,
  capability: Record<string, unknown>): Record<string, unknown> {
  const fixture = sdkFixture("success");
  const candidate = (fixture.candidates as Record<string, unknown>[])[0]!;
  const direct: Record<string, unknown> = structuredClone({ ...candidate, locator, neighbors: [] });
  Object.assign(direct, { actor_matched_weight_micros: 0, actor_requested_weight_micros: 0,
    matched_query_ids: ["original-question"], preference_boost_micros: 0,
    preference_score_micros: 0, rerank_score_picos: direct.base_score_picos,
    source_matched_weight_micros: 0, source_requested_weight_micros: 0,
    time_matched_weight_micros: 0, time_requested_weight_micros: 0 });
  direct.contributions = (direct.contributions as Record<string, unknown>[]).map((value) =>
    ({ ...value, query_id: "original-question" }));
  return structuredClone({ ...fixture, capability_fingerprint: capability.capability_fingerprint,
    profile_id: capability.profile_id, applied_bounds: { candidate_limit: 100,
    deadline_ms: 1_000, neighbor_radius: 0, response_byte_limit: 16_384, result_limit: 10,
    returned_neighbors: 0, returned_seeds: 1 }, candidates: [direct] });
}

async function startPackedGroundedAnswerRuntime(launcherSha256: string) {
  const definition = protoLoader.loadSync(fileURLToPath(new URL(
    "../../subscription-runtime-adapter/proto/agent_runtime.proto", import.meta.url)),
  { defaults: true, enums: String, keepCase: false, longs: String, oneofs: true });
  const loaded = grpc.loadPackageDefinition(definition) as Record<string, unknown>;
  const service = (((loaded.social_monitor as Record<string, unknown>).agent_runtime as
    Record<string, unknown>).v1 as Record<string, unknown>).AgentRuntimeService as
    { service: Record<string, unknown> };
  const prompts: string[] = [];
  const server = new grpc.Server();
  server.addService(service.service, { runAgentTask: (call: { request: Record<string, unknown> },
    callback: (error: Error | null, response?: unknown) => void) => {
    const request = runtimeRequestFromGrpc(call.request);
    prompts.push(request.task.prompt);
    const structuredOutput = { claims: [{ evidenceIds: ["evidence-000001"],
      text: "The launch proposal was approved." }], locale: "en", status: "answered" };
    callback(null, { executionAttestation: { canonicalRequestSha256:
      canonicalJsonSha256(request), launcherSha256, model: "gpt-5.6-sol",
    provider: "AGENT_RUNTIME_PROVIDER_CODEX", purpose: request.context.purpose,
    reasoningEffort: "medium", requestId: request.runId,
    runtimeEngine: "subscription-runtime-cli", runtimePackageVersion: "0.1.0-main.27",
    schemaVersion: 1, selectedOutputKind:
      "AGENT_RUNTIME_SELECTED_OUTPUT_KIND_STRUCTURED_OUTPUT",
    selectedOutputSha256: canonicalJsonSha256(structuredOutput) }, schemaVersion: 1,
    status: "AGENT_RUNTIME_TASK_STATUS_COMPLETED",
    structuredOutputJson: JSON.stringify(structuredOutput) });
  } });
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, value) => {
      if (error === null) {resolve(value);} else {reject(error);}
    });
  });
  grpcServers.push(server);
  return { address: `127.0.0.1:${port}`, prompts: () => [...prompts] };
}

function runtimeRequestFromGrpc(value: Record<string, unknown>) {
  const controls = JSON.parse(String(value.controlsJson)) as Record<string, unknown>;
  const metadata = value.metadata as Record<string, string>;
  return { context: { application: metadata.application!, correlationId:
    String(value.correlationId), metadata: { locale: metadata.locale!,
    meetingId: metadata.meetingId!, policyVersion: metadata.policyVersion!,
    transcriptId: metadata.transcriptId!, transcriptVersion: metadata.transcriptVersion! },
  purpose: String(value.purpose) }, cwd: String(value.cwd), protocolVersion:
    Number(value.schemaVersion), runId: String(value.requestId), task: { controls,
    kind: "structured-prompt" as const, metadata: { executionProfile: metadata.executionProfile!,
      model: metadata.model!, policyVersion: metadata.policyVersion!,
      reasoningEffort: metadata.reasoningEffort!, runtimeOutput: metadata.runtimeOutput!,
      toolsDisabled: metadata.toolsDisabled! }, outputSchemaName: String(controls.outputSchemaName),
    prompt: String(value.prompt), systemPrompt: String(value.systemPrompt) },
  timeoutMs: Number(value.timeoutMs) };
}

async function installDisposablePgModule(consumerRoot: string): Promise<void> {
  const root = join(consumerRoot, "node_modules", "pg");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "pg", type: "module",
    version: "8.22.0", exports: "./index.js" }));
  await writeFile(join(root, "index.js"), `
import { readFile, writeFile } from "node:fs/promises";
let auditWrite = Promise.resolve();
export class Pool {
  constructor(options) { this.options = options; this.fixture = null; }
  async data() { this.fixture ??= JSON.parse(await readFile(this.options.connectionString, "utf8")); return this.fixture; }
  async query(text, values = []) { return await query(this, text, values); }
  async connect() { const pool = this; return { processID: 4242, query: async (text, values = []) => await query(pool, text, values), release() {} }; }
  async end() {}
}
export class Client { constructor() { this.processID = 4243; } async connect() {} async end() {} async query() { return { rows: [] }; } }
async function query(pool, text, values) {
  const data = await pool.data(); const sql = String(text);
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] };
  if (sql.includes("SELECT historical.*")) return { rows: values[2] === "" ? [{ ...data.row, meeting_revision: data.meetingRevision, meeting_snapshot: data.meetingSnapshot }] : [] };
  if (sql.includes("count(*)::float8 AS count")) return { rows: [{ count: 1 }] };
  if (sql.includes("jsonb_array_elements")) { const locators = values[2]; auditWrite = auditWrite.then(async () => { const prior = JSON.parse(await readFile(data.auditPath, "utf8")); await writeFile(data.auditPath, JSON.stringify([...prior, ...locators])); }); await auditWrite; return { rows: [data.row] }; }
  if (sql.includes("WHERE release_id = $1")) return { rows: [data.row] };
  if (sql.includes("FROM meeting_core.meetings")) return { rows: [{ revision: data.meetingRevision, snapshot: data.meetingSnapshot }] };
  throw new Error("unexpected disposable PostgreSQL query: " + sql.slice(0, 120));
}
`);
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
