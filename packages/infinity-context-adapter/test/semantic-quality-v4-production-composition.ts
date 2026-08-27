import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HmacHistoricalOpaqueIds } from "../src/hmac-historical-ids.js";
import { PrepareFocusedLocatorRetrievalV2Request,
  type FocusedLocatorRetrievalV2ProviderBinding } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresHistoricalEvidenceAuthority, PostgresHistoricalMemoryStore } from
  "@discord-meeting/postgres-adapter";
import { subscriptionRuntimeCliEngine, type KnowledgeAnswerProviderExchangeIdentity,
  type KnowledgeAnswerQualificationExecutionBinding } from
  "@discord-meeting/subscription-runtime-adapter";
import { Pool } from "pg";

import { frozenSemanticQualityCorpusV4 } from
  "./semantic-quality-v4-corpus.js";
import { SemanticQualityV4CreateOnlyJournal } from "./semantic-quality-v4-evidence-store.js";
import { canonicalIntegerJson, canonicalSha256, createSemanticQualityV4Manifest } from
  "./semantic-quality-v4-manifest.js";
import { createSemanticQualityV4ProductionPorts,
  createSemanticQualityV4ProductionPostgresAuthority } from
  "./semantic-quality-v4-production-ports.js";
import { createSemanticQualityV4RealRunAuthorities, loadRealSemanticQualityV4Corpus } from
  "./semantic-quality-v4-private-corpus.js";
import { semanticQualityV4LocatorAuthoritySha256,
  semanticQualityV4ThresholdProfileSha256, semanticQualityV4TurnToBlockMappingSha256,
  type SemanticQualityV4ReleaseBinding, type SemanticQualityV4SpendReservation } from
  "./semantic-quality-v4-qualification.js";
import { executeSemanticQualityV4RawCampaign, runSemanticQualityV4RealCampaign,
  sealSemanticQualityV4CampaignRequest } from
  "./semantic-quality-v4-real-run.js";
import { SemanticQualityV4QualificationWorkflow } from "./semantic-quality-v4-workflow.js";
import { assertSemanticQualityV4ObservedArtifactBinding,
  requireIndependentSemanticQualityV4Receipts, requireSemanticQualityV4ExecutionObservation,
  requireSemanticQualityV4ServiceExecutionAttestation,
  semanticQualityV4ReviewerKeyRegistrySha256, verifySemanticQualityV4ReleaseTrustAnchor } from
  "./semantic-quality-v4-trusted-receipts.js";

interface QualificationTopology {
  readonly automated: QualificationScope;
  readonly real: QualificationScope;
}
interface QualificationScope {
  readonly currentMeetingId: string; readonly roomId: string; readonly scopeId: string;
}

type QualificationRuntimeModule = {
  GrpcSubscriptionRuntimeTransport:
    new(input: { address: string; serviceToken: string }) => { close(): void };
  createGrpcQualifiedGroundedAnswerAdapter(input: {
    beforeProviderCall(identity: KnowledgeAnswerProviderExchangeIdentity): Promise<void>;
    executionBinding: import("@discord-meeting/subscription-runtime-adapter")
      .KnowledgeAnswerQualificationExecutionBinding;
    options: { expectedLauncherSha256: string;
      expectedRuntimeEngine: typeof subscriptionRuntimeCliEngine };
    transport: unknown;
  }): import("@discord-meeting/subscription-runtime-adapter")
    .SubscriptionRuntimeGroundedAnswerAdapter;
};

interface OperatorConfiguration {
  readonly adjudicationDirectory: string;
  readonly artifactKeyId: string;
  readonly artifactKeyPath: string;
  readonly artifactRoot: string;
  readonly campaignReceiptDirectory: string;
  readonly campaignRunId: string;
  readonly infinityBaseUrl: string;
  readonly infinityCapabilityPath: string;
  readonly infinityServiceAttestationReceiptPath: string;
  readonly infinityTokenPath: string;
  readonly executionObservationReceiptPath: string;
  readonly exchangeObservationReceiptDirectory: string;
  readonly journalRoot: string;
  readonly postgresUrlPath: string;
  readonly privateQuestionPath: string;
  readonly privateRubricPath: string;
  readonly privateTranscriptPath: string;
  readonly questionReviewReceiptsPath: string;
  readonly runtimeAddress: string;
  readonly runtimeServiceAttestationReceiptPath: string;
  readonly runtimeTokenPath: string;
  readonly topologyKeyPath: string;
  readonly topologyPath: string;
  readonly trustAnchorPath: string;
  readonly workflowRoot: string;
}
/** The sole executable real-call composition; operator data is credentials, paths and receipts. */
export async function runSemanticQualityV4QualificationProductionComposition(
  configurationPath: string,
  phase: "execute" | "legacy_complete" = "legacy_complete",
) {
  const config = decodeOperatorConfiguration(readJson(configurationPath));
  const trustAnchor = verifySemanticQualityV4ReleaseTrustAnchor(readJson(config.trustAnchorPath),
    readExternalReleaseRoot());
  const pinnedKeys = trustAnchor.reviewerKeys;
  const sdkRuntimeUrl = import.meta.resolve("@infinity-context/sdk");
  const sdkRuntime = await import(sdkRuntimeUrl) as typeof import("@infinity-context/sdk");
  const questionReviewReceipts = readJson(config.questionReviewReceiptsPath) as readonly unknown[];
  const topology = decodeTopology(readJson(config.topologyPath));
  const capability = decodeCapability(readJson(config.infinityCapabilityPath));
  const providerBinding = providerBindingFrom(capability, sdkRuntime);
  const pool = new Pool({ connectionString: readSecret(config.postgresUrlPath),
    connectionTimeoutMillis: 5_000 });
  const store = new PostgresHistoricalMemoryStore(pool);
  const evidenceAuthority = new PostgresHistoricalEvidenceAuthority(pool);
  const ids = new HmacHistoricalOpaqueIds(readSecret(config.topologyKeyPath));
  const preparer = new PrepareFocusedLocatorRetrievalV2Request({ ids, providerBinding, store });
  const realCorpus = loadRealSemanticQualityV4Corpus({ pinnedReviewerKeys: pinnedKeys,
    questionPath: config.privateQuestionPath, reviewReceipts: questionReviewReceipts,
    rubricPath: config.privateRubricPath, transcriptPath: config.privateTranscriptPath });
  const automatedCorpus = frozenSemanticQualityCorpusV4();
  const [automatedPlans, realPlans] = await Promise.all([
    store.listCurrentRoomPlans(topology.automated.scopeId, topology.automated.roomId, 102),
    store.listCurrentRoomPlans(topology.real.scopeId, topology.real.roomId, 102),
  ]);
  const automatedMapping = turnMappingFromPlans(automatedPlans);
  const realMapping = turnMappingFromPlans(realPlans);
  const automatedForbidden = new Set(automatedCorpus.auxiliaryTurns.map(({ turnId }) => turnId));
  const forbiddenLocatorIds = automatedMapping.filter(({ turnId }) =>
    automatedForbidden.has(turnId)).map(({ sourceLocatorId }) => sourceLocatorId);
  const authorities = createSemanticQualityV4RealRunAuthorities({ automatedCorpus,
    automatedMapping, forbiddenLocatorIds, realCorpus, realMapping });
  const questions = authorities.overall.questions.map((question) => Object.freeze({ id: question.id,
    locale: question.locale, question: question.evaluationQuestionText ?? question.question }));
  const contexts = new Map(questions.map(({ id }) => [id,
    authorities.real.questions.some((question) => question.id === id) ? topology.real :
      topology.automated]));
  const requestSnapshots = [];
  for (const question of questions) {
    const context = contexts.get(question.id)!;
    const request = await preparer.prepare({ ...context, question: question.question });
    if (request === null) {throw new Error("qualification production request preflight failed");}
    requestSnapshots.push({ queryId: question.id, requestSnapshotSha256: canonicalSha256(request) });
  }
  const automatedManifest = createSemanticQualityV4Manifest(automatedCorpus);
  const runtimeModuleUrl = new URL("../../../apps/meeting-platform/src/adapters/outbound/" +
    "subscription-runtime-grpc-transport.ts", import.meta.url);
  const promptMapperUrl = new URL("../../../packages/subscription-runtime-adapter/src/" +
    "knowledge-answer-request-mapper.ts", import.meta.url);
  const tokenizerConfigurationUrl = new URL("../../../packages/subscription-runtime-adapter/src/" +
    "subscription-runtime-grounded-answer-adapter.ts", import.meta.url);
  const verifierModuleSetSha256 = canonicalSha256([
    import.meta.url, runtimeModuleUrl.href, promptMapperUrl.href, tokenizerConfigurationUrl.href,
    sdkRuntimeUrl, new URL("../src/infinity-context-retrieval-v2.ts", import.meta.url).href,
    ...["semantic-quality-v4-evidence-store.ts", "semantic-quality-v4-production-ports.ts",
      "semantic-quality-v4-qualification.ts", "semantic-quality-v4-real-run.ts",
      "semantic-quality-v4-trusted-receipts.ts"].map((file) => new URL(file, import.meta.url).href),
  ].map((url) => ({ sha256: hashModuleUrl(url), url: normalizedModuleIdentity(url) })));
  const observedArtifactBinding = Object.freeze({
    answerModelConfigurationSha256: hashModuleUrl(promptMapperUrl.href),
    answerPolicySha256: hashModuleUrl(promptMapperUrl.href),
    discordRuntimeModuleSha256: hashModuleUrl(runtimeModuleUrl.href),
    discordSourceCommit: trustAnchor.artifactBinding.discordSourceCommit,
    discordSourceTree: trustAnchor.artifactBinding.discordSourceTree,
    infinityServiceImageSha256: trustAnchor.artifactBinding.infinityServiceImageSha256,
    infinitySourceCommit: trustAnchor.artifactBinding.infinitySourceCommit,
    infinitySourceTree: trustAnchor.artifactBinding.infinitySourceTree,
    promptMapperSha256: hashModuleUrl(promptMapperUrl.href),
    reviewerKeyRegistrySha256: semanticQualityV4ReviewerKeyRegistrySha256(pinnedKeys),
    runtimeArtifactSha256: hashModuleUrl(runtimeModuleUrl.href),
    runtimeLauncherSha256: trustAnchor.artifactBinding.runtimeLauncherSha256,
    sdkPackageSha256: hashModuleUrl(sdkRuntimeUrl),
    sdkPackageSriSha512: trustAnchor.artifactBinding.sdkPackageSriSha512,
    tokenizerSha256: hashModuleUrl(tokenizerConfigurationUrl.href),
    verifierModuleSetSha256,
  });
  assertSemanticQualityV4ObservedArtifactBinding(trustAnchor, observedArtifactBinding);
  const stableAttemptId = canonicalSha256({ campaignRunId: config.campaignRunId,
    verifierModuleSetSha256 });
  const executionObservation = requireSemanticQualityV4ExecutionObservation({
    expected: { artifactBindingSha256: canonicalSha256(observedArtifactBinding),
      campaignRunId: config.campaignRunId,
      endpointIdentitySha256: canonicalSha256({ infinityBaseUrl: config.infinityBaseUrl,
        runtimeAddress: config.runtimeAddress }),
      modelIdentitySha256: canonicalSha256({ maxOutputTokens: 2_048, model: "gpt-5.6-sol",
        outputSchemaName: "discord_meeting_knowledge_answer_v1",
        policyVersion: "meeting-knowledge.answer.subscription-runtime.v3",
        reasoningEffort: "medium" }),
      processIdentitySha256: processIdentitySha256(),
      promptMapperSha256: observedArtifactBinding.promptMapperSha256,
      providerOrdinalContractSha256: canonicalSha256({ answer: ["original", "repair"],
        retrieval: ["capability", "retrieval"] }), stableAttemptId,
      tokenizerSha256: observedArtifactBinding.tokenizerSha256 }, pinnedKeys,
    receipt: readJson(config.executionObservationReceiptPath),
  });
  const executionReceiptBinding = executionObservation.receipt.binding as unknown as
    import("./semantic-quality-v4-trusted-receipts.js").SemanticQualityV4ExecutionObservationBinding;
  const serviceAttestationDigests = requireCurrentServiceAttestations({ capability, config,
    executionReceiptBinding, observedArtifactBinding, pinnedKeys });
  const rootBinding: SemanticQualityV4ReleaseBinding = Object.freeze({
    answerModelConfigurationSha256: observedArtifactBinding.answerModelConfigurationSha256,
    answerPolicySha256: observedArtifactBinding.answerPolicySha256,
    automatedCorpusSha256: automatedManifest.corpus.corpusSha256,
    automatedQuestionSetSha256: automatedManifest.questionSets.automated.questionSetSha256,
    capabilityBytesSha256: sha256(canonicalIntegerJson(capability)),
    capabilityFingerprintSha256: canonicalSha256(capability.capability_fingerprint),
    discordRuntimeModuleSha256: observedArtifactBinding.discordRuntimeModuleSha256,
    discordSourceCommit: observedArtifactBinding.discordSourceCommit,
    discordSourceTree: observedArtifactBinding.discordSourceTree,
    executionObservationSha256: canonicalSha256([executionObservation.digestSha256,
      ...serviceAttestationDigests]),
    indexProfileSha256: canonicalSha256(capability.index_profile_digest),
    infinityServiceImageSha256: observedArtifactBinding.infinityServiceImageSha256,
    infinitySourceCommit: observedArtifactBinding.infinitySourceCommit,
    infinitySourceTree: observedArtifactBinding.infinitySourceTree,
    locatorAuthoritySha256: semanticQualityV4LocatorAuthoritySha256(authorities),
    privateCorpusSha256: realCorpus.bindings.corpusSha256,
    privateInputSha256: realCorpus.bindings.inputSha256,
    privateQuestionSetSha256: realCorpus.bindings.questionSetSha256,
    promptMapperSha256: observedArtifactBinding.promptMapperSha256,
    questionReviewBindingSha256: canonicalSha256(realCorpus.bindings),
    requestSnapshotSha256: canonicalSha256(requestSnapshots),
    reviewerKeyRegistrySha256: semanticQualityV4ReviewerKeyRegistrySha256(pinnedKeys),
    rubricSha256: realCorpus.bindings.rubricSha256,
    runtimeArtifactSha256: observedArtifactBinding.runtimeArtifactSha256,
    sdkPackageSha256: observedArtifactBinding.sdkPackageSha256,
    sdkPackageSriSha512: observedArtifactBinding.sdkPackageSriSha512,
    thresholdProfileSha256: semanticQualityV4ThresholdProfileSha256(),
    tokenizerSha256: observedArtifactBinding.tokenizerSha256,
    trustAnchorSha256: trustAnchor.anchorSha256,
    turnToBlockMappingSha256: semanticQualityV4TurnToBlockMappingSha256(authorities),
    verifierModuleSetSha256: observedArtifactBinding.verifierModuleSetSha256,
  });
  const request = sealSemanticQualityV4CampaignRequest({
    questionReviewBinding: realCorpus.bindings, rootBinding });
  const artifactKey = Buffer.from(readSecret(config.artifactKeyPath), "base64");
  if (artifactKey.byteLength !== 32) {throw new Error("qualification artifact key must be 32 bytes");}
  const localAuthority = createSemanticQualityV4ProductionPostgresAuthority({
    authority: evidenceAuthority, contexts, ids, store });
  const runtimeModule = await import(runtimeModuleUrl.href) as QualificationRuntimeModule;
  const runtimeTransports: { close(): void }[] = [];
  const answerExecutionBinding = Object.freeze({
    artifactBindingSha256: executionReceiptBinding.artifactBindingSha256,
    campaignRunId: executionReceiptBinding.campaignRunId,
    endpointIdentitySha256: executionReceiptBinding.endpointIdentitySha256,
    processIdentitySha256: executionReceiptBinding.processIdentitySha256,
    promptMapperSha256: executionReceiptBinding.promptMapperSha256,
    serviceGenerationSha256: executionReceiptBinding.runtimeServiceProcessIdentitySha256,
    serviceIdentitySha256: executionReceiptBinding.runtimeServiceIdentitySha256,
    stableAttemptId: executionReceiptBinding.stableAttemptId,
    tokenizerSha256: executionReceiptBinding.tokenizerSha256,
  });
  const retrievalExecutionBinding = Object.freeze({ ...answerExecutionBinding,
    serviceGenerationSha256: executionReceiptBinding.infinityServiceProcessIdentitySha256,
    serviceIdentitySha256: executionReceiptBinding.infinityServiceIdentitySha256 });
  const productionPorts = (repetition: 1 | 2 | 3, evidence: Parameters<Parameters<
    typeof runSemanticQualityV4RealCampaign>[0]["productionPorts"]>[1]) =>
    createQualificationProductionPorts({ answerExecutionBinding, config, contexts,
      localAuthority, observedArtifactBinding, pinnedKeys, preparer, request,
      retrievalExecutionBinding, runtimeModule, runtimeTransports }, repetition, evidence);
  const adjudicationCounts = new Map<string, number>();
  try {
    if (phase === "execute") {
      return await executeQualificationWorkflowPhase({ artifactKey, authorities, config,
        pinnedKeys, productionPorts, questionReviewReceipts, questions, request });
    }
    return await runSemanticQualityV4RealCampaign({
      adjudication: { adjudicate: async (adjudicationInput) => {
        const repetition = (adjudicationCounts.get(adjudicationInput.queryId) ?? 0) + 1;
        adjudicationCounts.set(adjudicationInput.queryId, repetition);
        if (repetition > 3) {throw new Error("qualification adjudication repetition is invalid");}
        const value = exact(readJson(join(config.adjudicationDirectory,
          `${repetition}-${adjudicationInput.queryId}.json`)), ["receipts", "result"]);
        if (!Array.isArray(value.receipts)) {
          throw new Error("qualification adjudication receipts are invalid");
        }
        const binding = { adjudicationInputSha256: canonicalSha256(adjudicationInput),
          adjudicationResultSha256: canonicalSha256(value.result), repetition,
          rootBindingSha256: request.rootBindingSha256 };
        requireIndependentSemanticQualityV4Receipts({ binding, minimum: 2, pinnedKeys,
          receipts: value.receipts, role: "per_question_adjudication" });
        if ((value.result as { kind?: unknown }).kind !== "external_independent") {
          throw new Error("qualification adjudication is not externally independent");
        }
        return value.result as never;
      } },
      adjudicationReceipts: async (run) => readJson(join(config.campaignReceiptDirectory,
        `adjudication-${run.repetition}.json`)) as never,
      artifactEncryption: { key: artifactKey, keyId: config.artifactKeyId },
      artifactStoreRoot: config.artifactRoot, authorities,
      cleanup: async () => readJson(join(config.campaignReceiptDirectory, "cleanup.json")) as never,
      pinnedKeys,
      productionPorts,
      questionReviewReceipts, questions, request,
      reserveSpend: async (reservation) => {
        const value = readJson(join(config.campaignReceiptDirectory,
          `spend-${reservation.repetition}.json`)) as SemanticQualityV4SpendReservation;
        return value;
      },
      retention: async () => readJson(join(config.campaignReceiptDirectory, "retention.json")) as never,
    });
  } finally {
    for (const runtimeTransport of runtimeTransports) {runtimeTransport.close();}
    await pool.end();
  }
}

function createQualificationProductionPorts(input: {
  readonly answerExecutionBinding: KnowledgeAnswerQualificationExecutionBinding;
  readonly config: OperatorConfiguration;
  readonly contexts: Map<string, QualificationScope>;
  readonly localAuthority: ReturnType<typeof createSemanticQualityV4ProductionPostgresAuthority>;
  readonly observedArtifactBinding: { readonly runtimeLauncherSha256: string };
  readonly pinnedKeys: Parameters<typeof requireIndependentSemanticQualityV4Receipts>[0]["pinnedKeys"];
  readonly preparer: PrepareFocusedLocatorRetrievalV2Request;
  readonly request: ReturnType<typeof sealSemanticQualityV4CampaignRequest>;
  readonly retrievalExecutionBinding: KnowledgeAnswerQualificationExecutionBinding;
  readonly runtimeModule: QualificationRuntimeModule;
  readonly runtimeTransports: { close(): void }[];
}, repetition: 1 | 2 | 3, evidence: Parameters<Parameters<
  typeof runSemanticQualityV4RealCampaign>[0]["productionPorts"]>[1]) {
  const { config, request } = input;
  const ports = createSemanticQualityV4ProductionPorts({
    answerExecutionBinding: input.answerExecutionBinding,
    localPostgresAuthority: input.localAuthority, preparer: input.preparer,
    questionContext: ({ queryId }) => input.contexts.get(queryId)!, repetition,
    retrievalConfig: { baseUrl: config.infinityBaseUrl, operationTimeoutMs: 3_000,
      requestTimeoutMs: 1_000, token: () => readSecret(config.infinityTokenPath) },
    retrievalExecutionBinding: input.retrievalExecutionBinding,
    rootBindingSha256: request.rootBindingSha256, ...evidence,
    retrievalJournal: new SemanticQualityV4CreateOnlyJournal(join(config.journalRoot,
      `repetition-${repetition}`, "retrieval")),
    verifyExchangeObservation: (binding) => {
      verifyExchangeObservationFrom(config, repetition, input.pinnedKeys, binding); } });
  return { evidence: ports.evidence, retrieval: ports.retrieval, createAnswer: async () => {
    const runtimeTransport = new input.runtimeModule.GrpcSubscriptionRuntimeTransport({
      address: config.runtimeAddress, serviceToken: readSecret(config.runtimeTokenPath) });
    input.runtimeTransports.push(runtimeTransport);
    const journal = new SemanticQualityV4CreateOnlyJournal(join(config.journalRoot,
      `repetition-${repetition}`, "answer"));
    const answer = input.runtimeModule.createGrpcQualifiedGroundedAnswerAdapter({
      beforeProviderCall: async (identity) => {
        await journal.reserveProviderCall({ attemptId: identity.attemptId,
          callOrdinal: identity.callOrdinal, purpose: identity.purpose,
          requestRunId: identity.runId, rootBindingSha256: request.rootBindingSha256,
          runtimeProfile: identity.runtimeProfile });
      },
      options: { expectedLauncherSha256: input.observedArtifactBinding.runtimeLauncherSha256,
        expectedRuntimeEngine: subscriptionRuntimeCliEngine },
      executionBinding: input.answerExecutionBinding, transport: runtimeTransport,
    });
    return await ports.createAnswer({ answer, journal });
  } };
}

async function executeQualificationWorkflowPhase(input: {
  readonly artifactKey: Uint8Array;
  readonly authorities: Parameters<typeof executeSemanticQualityV4RawCampaign>[0]["authorities"];
  readonly config: OperatorConfiguration;
  readonly pinnedKeys: Parameters<typeof executeSemanticQualityV4RawCampaign>[0]["pinnedKeys"];
  readonly productionPorts: Parameters<typeof executeSemanticQualityV4RawCampaign>[0]["productionPorts"];
  readonly questionReviewReceipts: readonly unknown[];
  readonly questions: Parameters<typeof executeSemanticQualityV4RawCampaign>[0]["questions"];
  readonly request: ReturnType<typeof sealSemanticQualityV4CampaignRequest>;
}) {
  const { config, request } = input;
  const workflow = new SemanticQualityV4QualificationWorkflow(config.workflowRoot);
  const spendReservations = new Map([1, 2, 3].map((repetition) => {
    const reservation = readJson(join(config.campaignReceiptDirectory,
      `spend-${repetition}.json`)) as SemanticQualityV4SpendReservation;
    assertSpendAuthorization(reservation, repetition as 1 | 2 | 3,
      request.rootBindingSha256);
    return [repetition as 1 | 2 | 3, reservation] as const;
  }));
  const spendAuthorizationSetSha256 = canonicalSha256([...spendReservations]);
  await workflow.prepare({ campaignRequestSha256: request.sealedRequestSha256,
    rootBindingSha256: request.rootBindingSha256, spendAuthorizationSetSha256 });
  await workflow.startExecuting({ executionReservationSetSha256: spendAuthorizationSetSha256,
    rootBindingSha256: request.rootBindingSha256 });
  const rawRuns = await executeSemanticQualityV4RawCampaign({
    artifactEncryption: { key: input.artifactKey, keyId: config.artifactKeyId },
    artifactStoreRoot: config.artifactRoot, authorities: input.authorities,
    pinnedKeys: input.pinnedKeys, productionPorts: input.productionPorts,
    questionReviewReceipts: input.questionReviewReceipts, questions: input.questions, request,
    reserveSpend: async (reservation) => spendReservations.get(reservation.repetition)!,
  });
  const inventory = Object.freeze({ rootBindingSha256: request.rootBindingSha256,
    runs: rawRuns.map(({ artifactReceipts, repetition, spendReservation }) =>
      ({ artifactReceipts, repetition, spendReservation })),
    schemaVersion: "meeting_knowledge.semantic_quality_execution_inventory.v1" as const });
  const inventorySha256 = canonicalSha256(inventory);
  writeCreateOnlyExact(join(config.workflowRoot, "execution-inventory.json"),
    canonicalIntegerJson(inventory));
  const outcomes = rawRuns.flatMap(({ artifactReceipts, outcomes: runOutcomes, repetition }) =>
    runOutcomes.map((outcome) => {
      const receipt = (kind: "answer" | "evidence" | "raw_outcome") => {
        const match = artifactReceipts.find((item) =>
          item.attemptId === outcome.answerMeasurement.attemptId && item.artifactKind === kind);
        if (match === undefined) {throw new Error(`qualification ${kind} receipt is absent`);}
        return match.envelopeSha256;
      };
      return Object.freeze({ answerArtifactSha256: receipt("answer"),
        attemptId: outcome.answerMeasurement.attemptId,
        evidenceArtifactSha256: receipt("evidence"),
        questionDigestSha256: outcome.questionDigestSha256, questionId: outcome.queryId,
        rawOutcomeArtifactSha256: receipt("raw_outcome"), repetition,
        terminalState: outcome.answer.status === "failure" ? "failed" as const :
          "succeeded" as const });
    }));
  await workflow.awaitAdjudication({ artifactSetSha256: inventorySha256, outcomes,
    rootBindingSha256: request.rootBindingSha256 });
  return Object.freeze({ blockers: Object.freeze(["human_adjudication_pending"]),
    stage: "awaiting_adjudication" as const, status: "paused" as const });
}

function requireCurrentServiceAttestations(input: {
  readonly capability: ReturnType<typeof decodeCapability>;
  readonly config: OperatorConfiguration;
  readonly executionReceiptBinding:
    import("./semantic-quality-v4-trusted-receipts.js").SemanticQualityV4ExecutionObservationBinding;
  readonly observedArtifactBinding: Parameters<
    typeof assertSemanticQualityV4ObservedArtifactBinding>[1];
  readonly pinnedKeys: Parameters<
    typeof requireSemanticQualityV4ServiceExecutionAttestation>[0]["pinnedKeys"];
}): readonly string[] {
  const { capability, config, executionReceiptBinding: execution,
    observedArtifactBinding, pinnedKeys } = input;
  const base = { artifactBindingSha256: execution.artifactBindingSha256,
    campaignRunId: config.campaignRunId, endpointIdentitySha256: execution.endpointIdentitySha256,
    processIdentitySha256: execution.processIdentitySha256,
    providerOrdinalContractSha256: execution.providerOrdinalContractSha256,
    stableAttemptId: execution.stableAttemptId };
  const infinity = requireSemanticQualityV4ServiceExecutionAttestation({ binding: { ...base,
    serviceIdentitySha256: execution.infinityServiceIdentitySha256,
    serviceImageSha256: observedArtifactBinding.infinityServiceImageSha256,
    serviceKind: "infinity_context",
    serviceProcessIdentitySha256: execution.infinityServiceProcessIdentitySha256,
    workloadIdentitySha256: canonicalSha256({ capability,
      sdkRuntimeModuleSha256: observedArtifactBinding.sdkPackageSha256 }) }, pinnedKeys,
  receipt: readJson(config.infinityServiceAttestationReceiptPath) });
  const runtime = requireSemanticQualityV4ServiceExecutionAttestation({ binding: { ...base,
    serviceIdentitySha256: execution.runtimeServiceIdentitySha256,
    serviceImageSha256: observedArtifactBinding.runtimeArtifactSha256,
    serviceKind: "subscription_runtime",
    serviceProcessIdentitySha256: execution.runtimeServiceProcessIdentitySha256,
    workloadIdentitySha256: canonicalSha256({ modelIdentitySha256: execution.modelIdentitySha256,
      promptMapperSha256: execution.promptMapperSha256,
      tokenizerSha256: execution.tokenizerSha256 }) }, pinnedKeys,
  receipt: readJson(config.runtimeServiceAttestationReceiptPath) });
  return Object.freeze([infinity.digestSha256, runtime.digestSha256]);
}

function verifyExchangeObservationFrom(config: OperatorConfiguration, repetition: 1 | 2 | 3,
  pinnedKeys: Parameters<typeof requireIndependentSemanticQualityV4Receipts>[0]["pinnedKeys"],
  binding: Readonly<Record<string, string | number>>): void {
  const attemptId = binding.attemptId;
  const callOrdinal = binding.callOrdinal;
  if (typeof attemptId !== "string" || typeof callOrdinal !== "string") {
    throw new Error("qualification exchange observation identity is invalid");
  }
  requireIndependentSemanticQualityV4Receipts({ binding, minimum: 1, pinnedKeys,
    receipts: [readJson(join(config.exchangeObservationReceiptDirectory,
      `repetition-${repetition}`, `${attemptId}-${callOrdinal}.json`))],
    role: "execution_observation" });
}

function turnMappingFromPlans(plans: readonly { readonly plan: { readonly documents: readonly {
  readonly manifest: { readonly candidateLocator: string; readonly turnIds: readonly string[] } }[] } }[]) {
  const byTurn = new Map<string, string>();
  for (const { plan } of plans) {for (const { manifest } of plan.documents) {
    for (const turnId of manifest.turnIds) {
      const existing = byTurn.get(turnId);
      if (existing !== undefined && existing !== manifest.candidateLocator) {
        throw new Error("production turn-to-block authority is ambiguous");
      }
      byTurn.set(turnId, manifest.candidateLocator);
    }
  }}
  return Object.freeze([...byTurn].map(([turnId, sourceLocatorId]) =>
    Object.freeze({ sourceLocatorId, turnId })).toSorted((a, b) => a.turnId.localeCompare(b.turnId)));
}

function readJson(path: string): unknown {return JSON.parse(readFileSync(requireAbsolute(path), "utf8"));}
function readSecret(path: string): string {const value = readFileSync(requireAbsolute(path), "utf8").trim();
  if (value.length < 1) {throw new Error("qualification secret file is empty");} return value;}
function hashFile(path: string): string {return createHash("sha256").update(readFileSync(requireAbsolute(path))).digest("hex");}
function hashModuleUrl(url: string): string {return hashFile(fileURLToPath(url));}
function normalizedModuleIdentity(url: string): string {
  const path = fileURLToPath(url);
  const marker = "/node_modules/";
  const index = path.lastIndexOf(marker);
  return index < 0 ? path.slice(path.lastIndexOf("/packages/")) : path.slice(index + 1);
}
function processIdentitySha256(): string {
  const executableSha256 = hashFile("/proc/self/exe");
  const stat = readFileSync("/proc/self/stat", "utf8");
  const close = stat.lastIndexOf(")");
  const fields = stat.slice(close + 2).split(" ");
  const startTimeTicks = fields[19];
  if (close < 0 || startTimeTicks === undefined || !/^\d+$/u.test(startTimeTicks)) {
    throw new Error("qualification process identity is unavailable");
  }
  return canonicalSha256({ executableSha256, pid: process.pid, startTimeTicks });
}
function readExternalReleaseRoot(): string {
  const raw = process.env.SEMANTIC_QUALITY_V4_RELEASE_ROOT_FD;
  if (raw === undefined || !/^\d+$/u.test(raw)) {
    throw new Error("qualification release root must arrive on an inherited descriptor");
  }
  const fd = Number(raw);
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 1_024) {
    throw new Error("qualification release root descriptor is invalid");
  }
  return readFileSync(fd, "utf8");
}
function sha256(value: string): string {return createHash("sha256").update(value, "utf8").digest("hex");}
function requireAbsolute(path: string): string {if (!path.startsWith("/") || path.includes("\0"))
  {throw new Error("qualification path must be absolute");} return path;}
function exact(value: unknown, keys: readonly string[]) {if (value === null || typeof value !== "object" ||
  Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
  canonicalSha256(Object.keys(value).toSorted()) !== canonicalSha256([...keys].toSorted()))
  {throw new Error("qualification configuration shape is invalid");} return value as Record<string, unknown>;}
function decodeOperatorConfiguration(value: unknown): OperatorConfiguration {const keys = [
  "adjudicationDirectory", "artifactKeyId", "artifactKeyPath", "artifactRoot",
  "campaignReceiptDirectory", "campaignRunId", "infinityBaseUrl", "infinityCapabilityPath",
  "infinityServiceAttestationReceiptPath", "infinityTokenPath",
  "exchangeObservationReceiptDirectory", "executionObservationReceiptPath", "journalRoot",
  "postgresUrlPath", "privateQuestionPath",
  "privateRubricPath", "privateTranscriptPath", "questionReviewReceiptsPath",
  "runtimeAddress", "runtimeServiceAttestationReceiptPath", "runtimeTokenPath", "topologyKeyPath",
  "topologyPath", "trustAnchorPath", "workflowRoot"];
  const record = exact(value, keys); if (Object.values(record).some((item) => typeof item !== "string" || item.length < 1))
  {throw new Error("qualification operator configuration is invalid");} return record as unknown as OperatorConfiguration;}
function decodeTopology(value: unknown): QualificationTopology {const record = exact(value, ["automated", "real"]);
  const scope = (item: unknown) => exact(item, ["currentMeetingId", "roomId", "scopeId"]) as unknown as QualificationScope;
  return Object.freeze({ automated: scope(record.automated), real: scope(record.real) });}
function decodeCapability(value: unknown) {const record = value as Record<string, unknown>;
  for (const key of ["capability_fingerprint", "index_profile_digest", "profile_id", "service_revision"]) {
    if (typeof record[key] !== "string") {throw new Error("qualification capability artifact is invalid");}
  } return record as Record<string, unknown> & { capability_fingerprint: string; index_profile_digest: string;
    profile_id: string; service_revision: string };}
function providerBindingFrom(value: ReturnType<typeof decodeCapability>, sdkRuntime:
  Pick<typeof import("@infinity-context/sdk"), "CONTEXT_RETRIEVAL_CONTRACT" |
    "CONTEXT_RETRIEVAL_RANKING_POLICY">): FocusedLocatorRetrievalV2ProviderBinding {
  if (value.profile_id !== `locator-v2-full-${value.index_profile_digest}`) {
    throw new Error("qualification capability is not the full production profile");
  }
  return Object.freeze({ capabilityFingerprint: value.capability_fingerprint,
    contractVersion: sdkRuntime.CONTEXT_RETRIEVAL_CONTRACT, indexProfileDigest: value.index_profile_digest,
    profileId: value.profile_id, rankingPolicy: sdkRuntime.CONTEXT_RETRIEVAL_RANKING_POLICY,
    requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
    serviceRevision: value.service_revision });
}

function writeCreateOnlyExact(path: string, value: string): void {
  const directory = requireAbsolute(dirname(path));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(path, "wx", 0o600);
    try {writeFileSync(descriptor, value); fsyncSync(descriptor);} finally {closeSync(descriptor);}
    const directoryDescriptor = openSync(directory, "r");
    try {fsyncSync(directoryDescriptor);} finally {closeSync(directoryDescriptor);}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" ||
      readFileSync(path, "utf8") !== value) {
      throw new Error("qualification create-only inventory conflicts", { cause: error });
    }
  }
}

function assertSpendAuthorization(value: SemanticQualityV4SpendReservation,
  repetition: 1 | 2 | 3, rootBindingSha256: string): void {
  const record = exact(value, ["logicalAnswerRequests", "maximumExecutionsIncludingRepair",
    "maximumInputBytesPerExecution", "maximumOutputTokensPerExecution", "repetition",
    "reservationId", "rootBindingSha256", "schemaVersion"]);
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_spend_reservation.v1" ||
    record.logicalAnswerRequests !== 240 || record.maximumExecutionsIncludingRepair !== 480 ||
    record.maximumInputBytesPerExecution !== 16_000 ||
    record.maximumOutputTokensPerExecution !== 2_048 || record.repetition !== repetition ||
    record.rootBindingSha256 !== rootBindingSha256 || typeof record.reservationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.reservationId)) {
    throw new Error("qualification spend authorization is invalid");
  }
}
