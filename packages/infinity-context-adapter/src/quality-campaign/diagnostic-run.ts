import { open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Pool } from "pg";
import { buildHistoricalIndexPlan, historicalEmbeddingTokenProfile, PrepareFocusedLocatorRetrievalV2Request, type HistoricalIndexPlanV1 } from "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresDiagnosticFinalEvidence } from "@discord-meeting/postgres-adapter";
import { createGrpcQualifiedGroundedAnswerAdapter, GrpcSubscriptionRuntimeTransport, subscriptionRuntimeCliEngine } from "@discord-meeting/subscription-runtime-adapter";
import { HmacHistoricalOpaqueIds } from "../hmac-historical-ids.js";
import { InfinityContextHistoricalMemoryAdapter } from "../infinity-context-historical-memory.js";
import { InfinityContextRetrievalV2Adapter } from "../infinity-context-retrieval-v2.js";
import { PinnedMultilingualMiniLmTokenizer } from "../pinned-multilingual-minilm-tokenizer.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { awaitDiagnosticIndexReadiness, DiagnosticIndexReadinessError } from "./diagnostic-index-readiness.js";
import { DiagnosticCustody } from "./diagnostic-custody.js";
import { DiagnosticFrozenStore } from "./diagnostic-frozen-store.js";
import { decodeDiagnosticManifest, decodeDiagnosticQuestions, type DiagnosticManifest, type DiagnosticQuestion } from "./diagnostic-manifest.js";
import { createDiagnosticCanonicalQuestionChain } from "./production-canonical-question-chain.js";
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
    const manifest = decodeDiagnosticManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    if ((argv[3] !== undefined && argv[3] !== "--reconcile-index") || argv.length > 4) {
      throw new Error("diagnostic report path or option is invalid");
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

export async function runDiagnostic(manifest: DiagnosticManifest, reconcileIndex = false) {
  // Decode again: exported composition never treats a TypeScript cast as authority.
  const m = decodeDiagnosticManifest(manifest), c = m.connections;
  if (sha256(m.frozen.roster) !== m.rosterSha256) {
    throw new Error("diagnostic frozen identity/profile differs");
  }
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
    const indexPreparation = await awaitDiagnosticIndexReadiness({ baseUrl: c.infinityBaseUrl,
      token: infinityToken, binding: m.providerBinding, custody });
    const store = new DiagnosticFrozenStore(authority, plan, applied.remoteDocumentIds);
    const outcomes = await runDiagnosticSchedule(custody, m.questions, question => executeQuestion({ m, question, root, key, custody, authority, store, ids,
      transport, infinityToken }));
    const report = { schemaVersion: "meeting_knowledge.real40_diagnostic_report.v1", qualifying: false,
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
  readonly m: DiagnosticManifest;
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
  const chain = createDiagnosticCanonicalQuestionChain({
    answer, audit: { seal: async (value) => {
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
    preparer: new PrepareFocusedLocatorRetrievalV2Request({ ids: input.ids,
      providerBinding: m.providerBinding, snapshot: input.store }),
    retrieval: new InfinityContextRetrievalV2Adapter({ baseUrl: c.infinityBaseUrl,
      token: input.infinityToken, operationTimeoutMs: 4000, requestTimeoutMs: 2000 }),
    spend: { reserve: async (reservation) => {
        await custody.reserve(`effect-${sha256({ attemptId, kind: reservation.effectKind })}`, reservation);
      } },
    topology: { resolve: async (reference) => {
        if (reference !== question.scopeTopologyReference) {
          throw new Error("foreign diagnostic question");
        }
        return { currentMeetingId: m.frozen.meetingId, scopeId: m.frozen.scopeId, roomId: m.frozen.roomId };
      } },
  });
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
