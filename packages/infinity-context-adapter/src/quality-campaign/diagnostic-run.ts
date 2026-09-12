import { InfinityRetrievalScopeResolution } from "../infinity-retrieval-scope-resolution.js";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { buildHistoricalIndexPlan, historicalEmbeddingTokenProfile,
  PrepareFocusedLocatorRetrievalV2Request, PrepareFocusedLocatorRetrievalV3Request,
  type HistoricalIndexPlanV1 } from "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresDiagnosticFinalEvidence } from "@discord-meeting/postgres-adapter";
import { createGrpcQualifiedGroundedAnswerAdapter, GrpcSubscriptionRuntimeTransport, subscriptionRuntimeCliEngine } from "@discord-meeting/subscription-runtime-adapter";
import { HmacHistoricalOpaqueIds } from "../hmac-historical-ids.js";
import { InfinityContextHistoricalMemoryAdapter } from "../infinity-context-historical-memory.js";
import { InfinityContextRetrievalV2Adapter } from "../infinity-context-retrieval-v2.js";
import { InfinityContextRetrievalV3Adapter } from "../infinity-context-retrieval-v3.js";
import { INFINITY_CONTEXT_RETRIEVAL_V3_SDK_PROVENANCE } from "../infinity-sdk-provenance.js";
import { PinnedMultilingualMiniLmTokenizer } from "../pinned-multilingual-minilm-tokenizer.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { awaitDiagnosticIndexReadiness, awaitDiagnosticIndexReadinessV3,
  DiagnosticIndexReadinessError } from "./diagnostic-index-readiness.js";
import { DiagnosticCustody } from "./diagnostic-custody.js";
import { DiagnosticFrozenStore } from "./diagnostic-frozen-store.js";
import { decodeVersionedDiagnosticManifest, decodeDiagnosticQuestions,
  type DiagnosticManifest, type DiagnosticManifestV2, type DiagnosticQuestion,
  type DiagnosticSdkIdentity } from "./diagnostic-manifest.js";
import { createDiagnosticCanonicalQuestionChain,
  type QualificationEncryptedAuditPort } from "./production-canonical-question-chain.js";
import type { QualificationExternalEffectReservationPort } from
  "./execute-admitted-qualification-question.js";
import { createProductionCanonicalExecutionEvidence } from "./production-canonical-execution-evidence.js";
export interface DiagnosticOutcome {
  readonly questionId: string;
  readonly status: "answered" | "abstained" | "failed" | "outcome_unknown";
  readonly reason: string | null;
  readonly citations: readonly string[];
  readonly claims: readonly string[];
  readonly retrievedLocators: readonly string[];
  readonly citationValidity: {
    readonly valid: number;
    readonly total: number;
  };
  readonly latencyMs: {
    readonly retrieval: number | null;
    readonly postgres: number | null;
    readonly answer: number | null;
    readonly endToEnd: number;
  };
  readonly bytes: {
    readonly evidence: number;
    readonly originalPrompt: number;
    readonly repairPrompt: number;
  };
}
export async function runDiagnosticCli(argv: readonly string[], writeSafeLine?: (line: string) => void): Promise<0 | 1> {
  const manifestPath = argv[1], reportPath = argv[2];
  if (manifestPath === undefined || reportPath === undefined || !manifestPath.startsWith("/") ||
    !reportPath.startsWith("/")) {
    return 1;
  }
  try {
    const manifest = decodeVersionedDiagnosticManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    if ((argv[3] !== undefined && argv[3] !== "--reconcile-index") || argv.length > 4) {
      throw new Error("diagnostic report path or option is invalid");
    }
    if (manifest.schemaVersion === "meeting_knowledge.real40_diagnostic.v2") {
      await verifyInstalledDiagnosticSdk(manifest.sdkIdentity);
    }
    const resolvedReportPath = await resolveDiagnosticReportPath(reportPath, manifest.connections.artifactRoot);
    const reportFile = await open(resolvedReportPath, "wx", 0o600);
    try {
      const report = await runDiagnostic(manifest, argv[3] === "--reconcile-index");
      await reportFile.writeFile(canonicalJson(report));
      await reportFile.sync();
      writeSafeLine?.(canonicalJson({ status: "completed", qualifying: false, ...report.counts }));
      return 0;
    }
    finally {
      await reportFile.close();
    }
  }
  catch (error) {
    if (error instanceof DiagnosticIndexReadinessError) {
      writeSafeLine?.(canonicalJson({ status: "blocked", qualifying: false,
        reason: error.message, indexPreparation: error.preparation }));
      return 1;
    }
    writeSafeLine?.('{"status":"blocked","qualifying":false,"reason":"diagnostic_execution_blocked"}');
    return 1;
  }
}
/** Compare physical parents as well as lexical normalization before reserving output. */
export async function resolveDiagnosticReportPath(reportPath: string, artifactRoot: string): Promise<string> {
  if (!isAbsolute(artifactRoot)) {throw new Error("invalid diagnostic artifact path");}
  const [report, root] = await Promise.all([
    diagnosticPhysicalPath(reportPath), diagnosticPhysicalPath(resolve(artifactRoot)),
  ]);
  const child = relative(root, report);
  if (child === "" || (child !== ".." && !child.startsWith(".." + sep) && !isAbsolute(child))) {
    throw new Error("diagnostic report overlaps artifact custody");
  }
  return report;
}
async function diagnosticPhysicalPath(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error("invalid diagnostic path");}
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      // Resolve before normalizing: a symlink followed by /.. uses its target parent.
      return join(await realpath(existing), ...missing);
    } catch (error) {
      if ((error as {code?:string}).code !== "ENOENT" || dirname(existing) === existing) {throw error;}
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
}

export async function runDiagnostic(manifest: DiagnosticManifest | DiagnosticManifestV2,
  reconcileIndex = false) {
  // Decode again: exported composition never treats a TypeScript cast as authority.
  const m = decodeVersionedDiagnosticManifest(manifest), c = m.connections;
  if (sha256(m.frozen.roster) !== m.rosterSha256) {
    throw new Error("diagnostic frozen identity/profile differs");
  }
  // V2 may execute only from the exact installed draft package authenticated by
  // the repository's test-only SDK intake boundary. A source checkout,
  // entrypoint alias, or manifest assertion alone is never package custody.
  const installedSdk = m.schemaVersion === "meeting_knowledge.real40_diagnostic.v2"
    ? await verifyInstalledDiagnosticSdk(m.sdkIdentity) : null;
  const [postgresUrl, infinityToken, runtimeToken, keyText, topologyKey] = await Promise.all([
    secret(c.postgresUrlPath), secret(c.infinityTokenPath), secret(c.runtimeTokenPath),
    secret(c.artifactKeyPath), readFile(c.topologyKeyPath),
  ]);
  const key = Buffer.from(keyText, "base64");
  if (key.length !== 32 || topologyKey.length < 32) {
    throw new Error("invalid diagnostic keys");
  }
  const loadedModuleSha256 = sha256(await readFile(new URL(import.meta.url)));
  const loadedSdkSha256 = sha256(await readFile(new URL(import.meta.resolve("@infinity-context/sdk"))));
  const root = sha256({ manifest: m, loadedModuleSha256, loadedSdkSha256 });
  const custody = new DiagnosticCustody(c.artifactRoot, key, root);
  const pool = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 5000, max: 1,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000" });
  const transport = new GrpcSubscriptionRuntimeTransport({ address: c.runtimeAddress, serviceToken: runtimeToken });
  try {
    const authority = new PostgresDiagnosticFinalEvidence(pool, m.frozen);
    const meeting = await authority.loadFrozenProjection();
    const ids = new HmacHistoricalOpaqueIds(topologyKey);
    const tokenizer = new PinnedMultilingualMiniLmTokenizer();
    const rebuilt = buildHistoricalIndexPlan(meeting, ids, undefined, tokenizer);
    let plan = await custody.recover<HistoricalIndexPlanV1>("frozen-plan");
    if (plan === null) {
      await custody.retain("frozen-plan", rebuilt);
      plan = rebuilt;
    }
    if (canonicalJson(plan) !== canonicalJson(rebuilt)) {
      throw new Error("frozen diagnostic plan differs");
    }
    const memory = new InfinityContextHistoricalMemoryAdapter({
      baseUrl: c.infinityBaseUrl, token: infinityToken, requestTimeoutMs: 30_000, operationTimeoutMs: 600_000,
      schemaVersion: 1, embeddingTokenProfile: () => historicalEmbeddingTokenProfile(tokenizer),
      actorKeys: { activeActorKey: actor => `dactor1.diagnostic.${ids.keyedId("diagnostic-actor", [actor])}` },
    });
    let applied = await custody.recover<{
      remoteDocumentIds: Record<string, string>;
      planSha256: string;
    }>("applied-index");
    if (applied === null) {
      const reserved = await custody.reserved("index");
      if (reserved && !reconcileIndex) {
        throw new Error("diagnostic index outcome unknown; reconcile retained same IDs");
      }
      if (!reserved) {
        await custody.reserve("index", { planSha256: sha256(plan) });
      }
      const result = await memory.indexFinalMeeting(plan);
      if (result.status !== "applied") {
        if (await custody.recover("index-failure") === null) {
          await custody.retain("index-failure", result);
        }
        throw new Error("diagnostic index not applied; same-ID reconciliation required");
      }
      applied = { remoteDocumentIds: { ...result.remoteDocumentIds }, planSha256: sha256(plan) };
      await custody.retain("applied-index", applied);
    }
    if (applied.planSha256 !== sha256(plan)) {
      throw new Error("diagnostic applied receipt is foreign");
    }
    const indexPreparation = m.schemaVersion === "meeting_knowledge.real40_diagnostic.v2"
      ? await awaitDiagnosticIndexReadinessV3({ baseUrl: c.infinityBaseUrl,
          token: infinityToken, binding: m.providerBinding, custody })
      : await awaitDiagnosticIndexReadiness({ baseUrl: c.infinityBaseUrl,
          token: infinityToken, binding: m.providerBinding, custody });
    const store = new DiagnosticFrozenStore(authority, plan, applied.remoteDocumentIds);
    const outcomes = await runDiagnosticSchedule(custody, m.questions, question => executeQuestion({ m, question, root, key, custody, authority, store, ids,
      transport, infinityToken }));
    const commonReport = { qualifying: false,
      rootBindingSha256: root, declaredSourceRevision: m.sourceRevision, sourceRevisionAuthority: "owner_declared_unverified", loadedModuleSha256, loadedSdkSha256,
      snapshotSha256: m.frozen.snapshotSha256, transcriptSha256: m.frozen.transcriptSha256,
      rosterSha256: m.rosterSha256, planSha256: sha256(plan), questionDenominator: 40, indexPreparation,
      counts: { answered: outcomes.filter(o => o.status === "answered").length,
        abstained: outcomes.filter(o => o.status === "abstained").length,
        failed: outcomes.filter(o => o.status === "failed").length,
        unknown: outcomes.filter(o => o.status === "outcome_unknown").length },
      factualAccuracy: "UNMEASURED", recall: "UNMEASURED_REQUIRES_SEPARATE_GOLD_MAPPING",
      questions: outcomes.map(({ claims, citations, retrievedLocators, ...safe }) => ({
        ...safe, citationCount: citations.length, retrievedCount: retrievedLocators.length,
        claimCount: claims.length
      })),
    };
    const report = m.schemaVersion === "meeting_knowledge.real40_diagnostic.v2"
      ? { ...commonReport, schemaVersion: "meeting_knowledge.real40_diagnostic_report.v2",
          executingModuleIdentity: Object.freeze({ loadedModuleSha256 }),
          sdkIdentity: m.sdkIdentity, executingSdkIdentity: installedSdk,
          selectedContracts: Object.freeze({ manifest: m.schemaVersion,
            report: "meeting_knowledge.real40_diagnostic_report.v2" as const,
            retrieval: m.providerBinding.contractVersion,
            threadSelector: m.threadSelector }) }
      : { schemaVersion: "meeting_knowledge.real40_diagnostic_report.v1", ...commonReport };
    if (await custody.recover("execution-complete") === null) {
      await custody.retain("execution-complete", report);
    }
    return report;
  }
  finally {
    await pool.end();
    transport.close();
  }
}
/** Fixed membership orchestration. The callback cannot receive gold or alter the denominator. */
export async function runDiagnosticSchedule(custody: DiagnosticCustody, packets: readonly DiagnosticQuestion[], execute: (question: DiagnosticQuestion) => Promise<DiagnosticOutcome>): Promise<readonly DiagnosticOutcome[]> {
  const questions = decodeDiagnosticQuestions(packets);
  const outcomes: DiagnosticOutcome[] = [];
  let stopped = false;
  for (const question of questions) {
    const artifactId = `question-${sha256(question.questionId)}`;
    const recovered = await custody.recover<DiagnosticOutcome>(artifactId);
    if (recovered !== null) {
      if (recovered.questionId !== question.questionId) {
        throw new Error("foreign diagnostic outcome");
      }
      outcomes.push(recovered);
      stopped ||= recovered.status === "outcome_unknown";
      continue;
    }
    if (stopped) {
      const skipped = emptyOutcome(question, "failed", "blocked_after_unknown");
      await custody.retain(artifactId, skipped);
      outcomes.push(skipped);
      continue;
    }
    if (await custody.reserved(artifactId)) {
      const outcome = emptyOutcome(question, "outcome_unknown", "reserved_without_terminal");
      await custody.retain(artifactId, outcome);
      outcomes.push(outcome);
      stopped = true;
      continue;
    }
    await custody.reserve(artifactId, { questionSha256: sha256(question), root: custody.bindingSha256 });
    const outcome = await execute(question);
    if (outcome.questionId !== question.questionId) {
      throw new Error("foreign diagnostic outcome");
    }
    await custody.retain(artifactId, outcome);
    outcomes.push(outcome);
    stopped ||= outcome.status === "outcome_unknown";
  }
  return outcomes;
}
async function executeQuestion(input: {
  readonly m: DiagnosticManifest | DiagnosticManifestV2;
  readonly question: DiagnosticQuestion;
  readonly root: string;
  readonly key: Uint8Array;
  readonly custody: DiagnosticCustody;
  readonly authority: PostgresDiagnosticFinalEvidence;
  readonly store: DiagnosticFrozenStore;
  readonly ids: HmacHistoricalOpaqueIds;
  readonly transport: GrpcSubscriptionRuntimeTransport;
  readonly infinityToken: string;
}): Promise<DiagnosticOutcome> {
  const { m, question, custody } = input, c = m.connections;
  const attemptId = `sqv4-${sha256({ run: m.runId, root: input.root, question: question.questionId })}`;
  const start = Date.now(), signal = AbortSignal.timeout(180000);
  const evidence = createProductionCanonicalExecutionEvidence({
    answerJournalRoot: `${c.artifactRoot}/answer-journal`, retrievalJournalRoot: `${c.artifactRoot}/retrieval-journal`,
    artifactRoot: `${c.artifactRoot}/canonical`, artifactKey: input.key, artifactKeyId: "diagnostic",
    attemptId, questionId: question.questionId, repetition: 1, rootBindingSha256: input.root,
  });
  const effect = {providerReserved:false};
  let retrievalCompleted = false, repairSurfaceBytes = 0;
  const bytes = { evidence: 0, originalPrompt: 0, repairPrompt: 0 };
  const latencyMs: {
    retrieval: number | null;
    postgres: number | null;
    answer: number | null;
    endToEnd: number;
  } = { retrieval: null, postgres: null, answer: null, endToEnd: 0 };
  let retrievedLocators: readonly string[] = [];
  const answer = createGrpcQualifiedGroundedAnswerAdapter({
    transport: input.transport, options: { expectedLauncherSha256: c.expectedRuntimeLauncherSha256,
      expectedRuntimeEngine: subscriptionRuntimeCliEngine, maxOutputTokens: 2048 },
    beforeProviderCall: async (identity) => {
      if (identity.attemptId !== attemptId || identity.runtimeProfile.model !== m.model ||
        identity.runtimeProfile.reasoningEffort !== m.reasoningEffort) {
        throw new Error("foreign answer identity");
      }
      await custody.reserve(`call-${sha256({ attemptId, ordinal: identity.callOrdinal })}`, identity);
      effect.providerReserved = true;
    },
  });
  const commonChain = {
    answer, audit: { seal: async (value: Parameters<QualificationEncryptedAuditPort["seal"]>[0]) => {
        if (value.kind === "selected_canonical_turns") {
          bytes.evidence = value.plaintext.length;
        }
        if (value.kind === "answer_original_model_surface") {
          bytes.originalPrompt = value.plaintext.length;
        }
        // A prepared repair surface is not an executed repair; count it only when sent.
        if (value.kind === "answer_repair_model_surface") {
          repairSurfaceBytes = value.plaintext.length;
        }
        if (value.kind === "answer_repair_request") {
          bytes.repairPrompt = repairSurfaceBytes;
        }
        await evidence.audit.seal(value);
      } },
    evidenceAuthority: input.authority, store: input.store, ids: input.ids, journal: evidence.journal,
    spend: { reserve: async (reservation: Parameters<
      QualificationExternalEffectReservationPort["reserve"]>[0]) => {
        await custody.reserve(`effect-${sha256({ attemptId, kind: reservation.effectKind })}`, reservation);
      } },
    topology: { resolve: async (reference: string) => {
        if (reference !== question.scopeTopologyReference) {
          throw new Error("foreign diagnostic question");
        }
        return { currentMeetingId: m.frozen.meetingId, scopeId: m.frozen.scopeId, roomId: m.frozen.roomId };
      } },
  };
  const retrievalConfiguration = { baseUrl: c.infinityBaseUrl,
    token: input.infinityToken, operationTimeoutMs: 4000, requestTimeoutMs: 2000 };
  const preparationDependencies = { ids: input.ids,
      scopeResolution: new InfinityRetrievalScopeResolution({ baseUrl: c.infinityBaseUrl,
        token: input.infinityToken, operationTimeoutMs: 500, requestTimeoutMs: 500 }),
      snapshot: input.store };
  const chain = m.schemaVersion === "meeting_knowledge.real40_diagnostic.v2"
    ? createDiagnosticCanonicalQuestionChain({ ...commonChain,
        preparer: new PrepareFocusedLocatorRetrievalV3Request({ ...preparationDependencies,
          providerBinding: m.providerBinding }),
        retrieval: new InfinityContextRetrievalV3Adapter(retrievalConfiguration) })
    : createDiagnosticCanonicalQuestionChain({ ...commonChain,
        preparer: new PrepareFocusedLocatorRetrievalV2Request({ ...preparationDependencies,
          providerBinding: m.providerBinding }),
        retrieval: new InfinityContextRetrievalV2Adapter(retrievalConfiguration) });
  const options = { attemptId, signal };
  try {
    let mark = Date.now();
    const retrieved = await chain.retrieval.retrieve(question, options);
    latencyMs.retrieval = Date.now() - mark;
    if (retrieved.status !== "completed") {
      return { ...emptyOutcome(question, "failed", retrieved.reason), bytes,
        latencyMs: { ...latencyMs, endToEnd: Date.now() - start } };
    }
    retrievalCompleted = true;
    retrievedLocators = retrieved.candidates.map(r => r.locatorId);
    mark = Date.now();
    const selected = await chain.evidence.rehydrate({ locatorIds: retrievedLocators,
      questionId: question.questionId, scopeTopologyReference: question.scopeTopologyReference }, options);
    latencyMs.postgres = Date.now() - mark;
    // Overlapping canonical slices are not silently collapsed into misleading citation identity.
    if (new Set(selected.turns.map(t => t.turnId)).size !== selected.turns.length) {
      return { ...emptyOutcome(question, "failed", "overlapping_canonical_turn_identity"), retrievedLocators, bytes,
        latencyMs: { ...latencyMs, endToEnd: Date.now() - start } };
    }
    mark = Date.now();
    const result = await chain.answer.generate({ ...selected, evidence: selected.turns,
      locale: question.locale, questionId: question.questionId, questionText: question.questionText }, options);
    latencyMs.answer = Date.now() - mark;
    latencyMs.endToEnd = Date.now() - start;
    if (result.status === "failed") {
      return { ...emptyOutcome(question, "failed", result.reason), retrievedLocators, bytes, latencyMs };
    }
    const turnIds = new Set(selected.turns.map(t => t.turnId));
    return { questionId: question.questionId, status: result.status, reason: null,
      claims: result.claims, citations: result.citations, retrievedLocators,
      citationValidity: { valid: result.citations.filter(id => turnIds.has(id)).length, total: result.citations.length },
      bytes, latencyMs };
  }
  catch {
    return { ...emptyOutcome(question, effect.providerReserved || !retrievalCompleted && await custody.reserved(`effect-${sha256({ attemptId, kind: "retrieval" })}`) ? "outcome_unknown" : "failed", signal.aborted ? "timeout" : "diagnostic_execution_failed"), retrievedLocators, bytes,
      latencyMs: { ...latencyMs, endToEnd: Date.now() - start } };
  }
}
function emptyOutcome(question: DiagnosticQuestion, status: DiagnosticOutcome["status"], reason: string): DiagnosticOutcome {
  return { questionId: question.questionId, status, reason, claims: [], citations: [], retrievedLocators: [],
    citationValidity: { valid: 0, total: 0 }, latencyMs: { retrieval: null, postgres: null, answer: null, endToEnd: 0 },
    bytes: { evidence: 0, originalPrompt: 0, repairPrompt: 0 } };
}
async function secret(path: string): Promise<string> {
  const value = (await readFile(path, "utf8")).trim();
  if (value.length === 0) {
    throw new Error("empty diagnostic secret");
  }
  return value;
}

/** Authenticate the installed bytes against the explicit test-only V3 draft intake. */
export async function verifyInstalledDiagnosticSdk(
  expected: DiagnosticSdkIdentity,
): Promise<Readonly<DiagnosticSdkIdentity & { readonly loadedEntrypointSha256: string }>> {
  const entrypoint = new URL(import.meta.resolve("@infinity-context/sdk"));
  const installedEntrypoint = await realpath(fileURLToPath(entrypoint));
  if (!installedEntrypoint.includes(`${sep}node_modules${sep}`)) {
    throw new Error("diagnostic SDK resolution is not an installed package artifact");
  }
  const packageRoot = await realpath(fileURLToPath(new URL("..", entrypoint)));
  return verifyDiagnosticSdkPackageBytes(packageRoot, installedEntrypoint, expected);
}

/** Byte verifier kept separate so hostile installed-package layouts can be tested without
 * mutating the workspace installation. It does not establish installed-package resolution. */
export async function verifyDiagnosticSdkPackageBytes(
  packageRoot: string,
  installedEntrypoint: string,
  expected: DiagnosticSdkIdentity,
): Promise<Readonly<DiagnosticSdkIdentity & { readonly loadedEntrypointSha256: string }>> {
  const provenance = INFINITY_CONTEXT_RETRIEVAL_V3_SDK_PROVENANCE;
  if (provenance.evidenceKind !== "draft-qualification" || provenance.releaseState !== "draft" ||
    provenance.qualificationScope !== "test-only" || provenance.immutableAttestationVerified !== false ||
    provenance.publicDistributionVerified !== false) {
    throw new Error("diagnostic SDK provenance is not an admitted test-only draft");
  }
  const observed = Object.freeze({ packageName: provenance.packageName,
    version: provenance.packageVersion,
    sourceRevision: provenance.reviewedSourceCommit,
    tarballSha256: provenance.packageTarballSha256,
    manifestSha256: provenance.packageManifestSha256 });
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error("installed diagnostic SDK differs from authenticated draft package");
  }
  const manifestBytes = await readFile(join(packageRoot, "package.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as { name?: unknown; version?: unknown };
  if (manifest.name !== expected.packageName ||
    manifest.version !== expected.version || sha256(manifestBytes) !== expected.manifestSha256) {
    throw new Error("installed diagnostic SDK manifest differs from authenticated draft package");
  }
  const identityPath = resolve(packageRoot, provenance.artifactIdentityPath);
  if (relative(packageRoot, identityPath).split(sep).join("/") !== provenance.artifactIdentityPath) {
    throw new Error("installed diagnostic SDK artifact identity path is unsafe");
  }
  const identityBytes = await readFile(identityPath);
  const identity = exactInstalledSdkIdentity(JSON.parse(identityBytes.toString("utf8")));
  if (sha256(identityBytes) !== provenance.artifactIdentitySha256 ||
    sha256(identity.files) !== provenance.artifactInventorySha256) {
    throw new Error("installed diagnostic SDK artifact identity differs");
  }
  if (identity.package_name !== expected.packageName || identity.package_version !== expected.version ||
    identity.source_commit !== provenance.reviewedSourceCommit ||
    identity.source_git_tree_oid !== provenance.reviewedSourceTree) {
    throw new Error("installed diagnostic SDK source identity differs");
  }
  const entrypointRelative = relative(packageRoot, installedEntrypoint).split(sep).join("/");
  if (!identity.files.some(({ path }) => path === "package.json") ||
    !identity.files.some(({ path }) => path === entrypointRelative)) {
    throw new Error("installed diagnostic SDK inventory is incomplete");
  }
  for (const file of identity.files) {
    const path = resolve(packageRoot, file.path);
    const child = relative(packageRoot, path);
    if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child) ||
      await realpath(path) !== path ||
      (await lstat(path)).isSymbolicLink() || sha256(await readFile(path)) !== file.sha256_hex) {
      throw new Error("installed diagnostic SDK file inventory differs");
    }
  }
  return Object.freeze({ ...observed,
    loadedEntrypointSha256: sha256(await readFile(installedEntrypoint)) });
}

interface InstalledSdkArtifactIdentity {
  readonly files: readonly { readonly path: string; readonly sha256_hex: string }[];
  readonly package_name: string; readonly package_version: string;
  readonly schema_version: string; readonly source_commit: string;
  readonly source_git_tree_oid: string;
}
function exactInstalledSdkIdentity(value: unknown): InstalledSdkArtifactIdentity {
  const record = value as Record<string, unknown>;
  const keys = ["files", "package_name", "package_version", "schema_version", "source_commit",
    "source_git_tree_oid"];
  if (typeof record !== "object" || record === null ||
    canonicalJson(Object.keys(record).toSorted()) !== canonicalJson(keys.toSorted()) ||
    record.schema_version !== "infinity-context-typescript-sdk-artifact-identity.v1" ||
    !Array.isArray(record.files) || record.files.length === 0 ||
    ![record.package_name, record.package_version, record.source_commit,
      record.source_git_tree_oid].every(item => typeof item === "string" && item.length > 0)) {
    throw new Error("installed diagnostic SDK artifact identity is invalid");
  }
  const files = record.files.map(item => {
    const file = item as Record<string, unknown>;
    if (typeof file !== "object" || file === null ||
      canonicalJson(Object.keys(file).toSorted()) !== canonicalJson(["path", "sha256_hex"]) ||
      typeof file.path !== "string" || file.path.length === 0 || file.path.includes("\0") ||
      file.path.includes("\\") || file.path.startsWith("/") ||
      file.path.split("/").some(part => part === "" || part === "." || part === "..") ||
      typeof file.sha256_hex !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256_hex)) {
      throw new Error("installed diagnostic SDK file identity is invalid");
    }
    return Object.freeze({ path: file.path, sha256_hex: file.sha256_hex });
  });
  if (new Set(files.map(({ path }) => path)).size !== files.length) {
    throw new Error("installed diagnostic SDK file inventory is duplicated");
  }
  return Object.freeze({ ...record, files: Object.freeze(files) }) as unknown as
    InstalledSdkArtifactIdentity;
}
