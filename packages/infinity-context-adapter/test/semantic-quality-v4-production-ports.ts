import {
  DEFAULT_FOCUSED_LOCATOR_RETRIEVAL_V2_POLICY,
  PrepareFocusedLocatorRetrievalV2Request,
  createFocusedRetrievalGroundingPlan,
  rehydrateHistoricalBlock,
  type FocusedLocatorRetrievalV2RequestSnapshot,
  type GroundedAnswerGenerationBinding,
  type RehydratedEvidenceTurn,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresHistoricalEvidenceAuthority, PostgresHistoricalMemoryStore,
  assertConstructedPostgresHistoricalEvidenceAuthority,
  assertConstructedPostgresHistoricalMemoryStore, canonicalFinalReplyTurnHash } from
  "@discord-meeting/postgres-adapter";
import {
  type SubscriptionRuntimeGroundedAnswerAdapter,
  type KnowledgeAnswerQualificationExecutionBinding,
} from "@discord-meeting/subscription-runtime-adapter";
import { createHash } from "node:crypto";

import { type HmacHistoricalOpaqueIds, assertConstructedHmacHistoricalOpaqueIds } from
  "../src/hmac-historical-ids.js";

import {
  InfinityContextRetrievalV2Adapter,
  type InfinityContextRetrievalV2Config,
} from "../src/infinity-context-retrieval-v2.js";
import type {
  SemanticQualityV4AnswerPort,
  SemanticQualityV4EvidencePort,
  SemanticQualityV4GeneratedClaim,
  SemanticQualityV4LocalEvidenceTurn,
  SemanticQualityV4RetrievalPort,
} from "../src/semantic-quality-v4-runner.js";
import { createV4GeneratedClaimId } from "./semantic-quality-v4-evaluation.js";
import { canonicalIntegerJson, canonicalSha256 } from "./semantic-quality-v4-manifest.js";
import { type SemanticQualityV4CreateOnlyJournal, SemanticQualityV4EncryptedArtifactStore,
  assertSemanticQualityV4ProductionArtifactStore, assertSemanticQualityV4ProductionJournal,
  semanticQualityV4AttemptId,
  type SemanticQualityV4ArtifactKind, type SemanticQualityV4ArtifactReceipt } from
  "./semantic-quality-v4-evidence-store.js";

export interface SemanticQualityV4ProductionEvidenceTurn
  extends SemanticQualityV4LocalEvidenceTurn {
  readonly source?: RehydratedEvidenceTurn["source"];
  readonly turnHash: string;
}

export interface SemanticQualityV4RetrievalObservation {
  readonly capabilityAndRetrievalLatencyUs: number;
  readonly capabilityBytes: number;
  readonly capabilitySha256: string;
  readonly requestBytes: number;
  readonly requestSha256: string;
  readonly requestSnapshotSha256: string;
  readonly responseBytes: number;
  readonly responseSha256: string;
  readonly routeLatencyUs: number;
}

export interface SemanticQualityV4AnswerObservation {
  readonly attemptId: string;
  readonly outcomeCertain: boolean;
  readonly providerBytesSent: boolean;
  readonly responseBytes: number;
  readonly runtimeReceiptSha256: string;
}

const productionRetrievalPorts = new WeakSet<object>();
const productionAnswerPorts = new WeakSet<object>();
const productionPostgresAuthorities = new WeakSet<object>();

interface SemanticQualityV4ProductionPostgresAuthority {
  answerBinding(queryId: string): GroundedAnswerGenerationBinding;
  rehydrate(input: { readonly locatorIds: readonly string[]; readonly queryId: string;
    readonly request: FocusedLocatorRetrievalV2RequestSnapshot }):
    Promise<readonly SemanticQualityV4ProductionEvidenceTurn[]>;
}

export function createSemanticQualityV4ProductionPostgresAuthority(input: {
  readonly authority: PostgresHistoricalEvidenceAuthority;
  readonly contexts: ReadonlyMap<string, { readonly currentMeetingId: string;
    readonly roomId: string; readonly scopeId: string }>;
  readonly ids: HmacHistoricalOpaqueIds;
  readonly store: PostgresHistoricalMemoryStore;
}): SemanticQualityV4ProductionPostgresAuthority {
  assertConstructedPostgresHistoricalEvidenceAuthority(input.authority);
  assertConstructedPostgresHistoricalMemoryStore(input.store);
  assertConstructedHmacHistoricalOpaqueIds(input.ids);
  const value = new ConcreteProductionPostgresAuthority(input);
  productionPostgresAuthorities.add(value);
  return value;
}

export function assertSemanticQualityV4ProductionRetrievalPorts(input: {
  readonly evidence: SemanticQualityV4EvidencePort;
  readonly retrieval: SemanticQualityV4RetrievalPort;
}): void {
  if (!productionRetrievalPorts.has(input.evidence) || !productionRetrievalPorts.has(input.retrieval)) {
    throw new Error("semantic quality V4 real run requires exact production retrieval ports");
  }
}

export function assertSemanticQualityV4ProductionAnswerPort(
  answer: SemanticQualityV4AnswerPort,
): void {
  if (!productionAnswerPorts.has(answer)) {
    throw new Error("semantic quality V4 real run requires the exact production answer port");
  }
}

/**
 * Thin qualification composition. Ranking, query decomposition, filtering,
 * neighbor policy, block construction, and prompt mapping remain production-owned.
 */
interface SemanticQualityV4ProductionPortsInput {
  readonly answerExecutionBinding: KnowledgeAnswerQualificationExecutionBinding;
  readonly localPostgresAuthority: SemanticQualityV4ProductionPostgresAuthority;
  readonly preparer: PrepareFocusedLocatorRetrievalV2Request;
  readonly questionContext: (input: { readonly queryId: string }) => {
    readonly currentMeetingId: string;
    readonly roomId: string;
    readonly scopeId: string;
  };
  readonly repetition: 1 | 2 | 3;
  readonly retrievalExecutionBinding: KnowledgeAnswerQualificationExecutionBinding;
  readonly retrievalConfig: InfinityContextRetrievalV2Config;
  readonly rootBindingSha256: string;
  readonly verifyExchangeObservation: (
    binding: Readonly<Record<string, string | number>>,
  ) => void;
  readonly artifactEncryption: { readonly key: Uint8Array; readonly keyId: string };
  readonly artifactStore: SemanticQualityV4EncryptedArtifactStore;
  readonly recordArtifactReceipt: (receipt: SemanticQualityV4ArtifactReceipt) => void;
  readonly retrievalJournal: SemanticQualityV4CreateOnlyJournal;
}

export function createSemanticQualityV4ProductionPorts(
  input: SemanticQualityV4ProductionPortsInput,
): {
  readonly createAnswer: (input: {
    readonly answer: SubscriptionRuntimeGroundedAnswerAdapter;
    readonly journal: SemanticQualityV4CreateOnlyJournal;
  }) => Promise<SemanticQualityV4AnswerPort>;
  readonly evidence: SemanticQualityV4EvidencePort;
  readonly retrieval: SemanticQualityV4RetrievalPort;
} {
  if (input.retrievalConfig.transport !== undefined) {
    throw new Error("semantic quality V4 qualification forbids an injected Infinity transport");
  }
  if (!(input.preparer instanceof PrepareFocusedLocatorRetrievalV2Request)) {
    throw new Error("semantic quality V4 qualification requires the production request preparer");
  }
  if (!productionPostgresAuthorities.has(input.localPostgresAuthority)) {
    throw new Error("semantic quality V4 qualification requires the concrete PostgreSQL authority");
  }
  assertSemanticQualityV4ProductionArtifactStore(input.artifactStore);
  const retrievalAdapter = new InfinityContextRetrievalV2Adapter(input.retrievalConfig);
  const requestByQuestion = new Map<string, FocusedLocatorRetrievalV2RequestSnapshot>();
  const evidenceByQuestion = new Map<string, readonly SemanticQualityV4ProductionEvidenceTurn[]>();
  const questionDigestByQuestion = new Map<string, string>();

  const retrieval = createProductionRetrievalPort({ input, requestByQuestion, retrievalAdapter });

  const evidence: SemanticQualityV4EvidencePort = Object.freeze({
    rehydrate: async (portInput: Parameters<SemanticQualityV4EvidencePort["rehydrate"]>[0]) => {
      const { expandedNeighborLocators, questionDigestSha256, queryId,
        rankedSeedLocators } = portInput;
      const request = requestByQuestion.get(queryId);
      if (request === undefined || expandedNeighborLocators.length !== 0) {
        throw new Error("semantic quality V4 production retrieval request is not bound");
      }
      const locatorIds = rankedSeedLocators.map(({ locatorId }) => locatorId);
      const turns = await input.localPostgresAuthority.rehydrate({ locatorIds, queryId, request });
      const admitted = new Set(locatorIds);
      if (turns.some(({ sourceLocatorId }) => !admitted.has(sourceLocatorId))) {
        throw new Error("semantic quality V4 PostgreSQL evidence lacks locator authority");
      }
      evidenceByQuestion.set(queryId, Object.freeze([...turns]));
      questionDigestByQuestion.set(queryId, questionDigestSha256);
      productionRetrievalPorts.add(evidence);
      return Object.freeze({ turns: Object.freeze([...turns]) });
    },
  });

  const createAnswer = async (answerInput: {
    readonly answer: SubscriptionRuntimeGroundedAnswerAdapter;
    readonly journal: SemanticQualityV4CreateOnlyJournal;
  }): Promise<SemanticQualityV4AnswerPort> => {
    assertSemanticQualityV4ProductionJournal(answerInput.journal);
    const runtimeModulePath = new URL("../../../apps/meeting-platform/src/adapters/outbound/" +
      "subscription-runtime-grpc-transport.ts", import.meta.url).href;
    const runtimeModule = await import(runtimeModulePath) as {
      assertGrpcQualifiedGroundedAnswerAdapter(value: unknown): void };
    runtimeModule.assertGrpcQualifiedGroundedAnswerAdapter(answerInput.answer);
    const answer: SemanticQualityV4AnswerPort = Object.freeze({
    answer: async (portInput: Parameters<SemanticQualityV4AnswerPort["answer"]>[0]) => {
      const { evidence: admittedEvidence, locale, queryId, question } = portInput;
      const productionEvidence = evidenceByQuestion.get(queryId);
      const questionDigestSha256 = questionDigestByQuestion.get(queryId);
      if (productionEvidence === undefined || questionDigestSha256 === undefined ||
        canonicalIntegerJson(productionEvidence.map(publicTurn)) !==
          canonicalIntegerJson(admittedEvidence)) {
        throw new Error("semantic quality V4 answer evidence is not locally authoritative");
      }
      const binding = input.localPostgresAuthority.answerBinding(queryId);
      const plan = createFocusedRetrievalGroundingPlan({
        authorityGeneration: binding.memoryGeneration,
        coverage: "sufficient",
        humanActorIds: [...new Set(productionEvidence.map(({ speakerId }) => speakerId))],
        turns: productionEvidence.map((turn) => ({
          endMs: turn.endMs,
          ...(turn.source === undefined ? {} : { source: turn.source }),
          speakerId: turn.speakerId,
          startMs: turn.startMs,
          text: turn.text,
          turnHash: turn.turnHash,
          turnId: turn.turnId,
        })),
      });
      const attemptId = semanticQualityV4AttemptId({ questionId: queryId,
        repetition: input.repetition, rootBindingSha256: input.rootBindingSha256 });
      const request = { attemptId,
        binding, locale, plan, question };
      const prepared = answerInput.answer.prepare(request);
      const modelInputDigests = new Map<string, string>();
      for (const [artifactKind, plaintext] of [
        ["original_model_input", prepared.modelInputs.original],
        ["repair_model_input", prepared.modelInputs.repair],
      ] as const) {
        const receipt = await input.artifactStore.sealCreateOnly({ artifactKind, attemptId,
          key: input.artifactEncryption.key, keyId: input.artifactEncryption.keyId,
          plaintext: new TextEncoder().encode(plaintext),
          rootBindingSha256: input.rootBindingSha256 });
        await input.artifactStore.verifyReceipt({ key: input.artifactEncryption.key,
          receipt });
        input.recordArtifactReceipt(receipt);
        modelInputDigests.set(artifactKind, receipt.plaintextSha256);
      }
      const payloadSha256 = canonicalSha256({
        requestSha256: sha256(canonicalIntegerJson(prepared.request)),
        questionDigestSha256,
      });
      await answerInput.journal.reserve({ reservedPayloadSha256: payloadSha256, questionId: queryId,
        repetition: input.repetition, rootBindingSha256: input.rootBindingSha256 });
      const providerReceipts = new Map<string, SemanticQualityV4ArtifactReceipt>();
      const started = process.hrtime.bigint();
      const generated = await answerInput.answer.generate(request);
      const answerLatencyUs = Number((process.hrtime.bigint() - started) / 1_000n);
      const observation = answerInput.answer.takeQualificationObservation(attemptId);
      if (observation.attemptId !== attemptId) {
        throw new Error("semantic quality V4 runtime observation is not attempt-bound");
      }
      const { exchanges, ...publicObservation } = observation;
      if (observation.providerBytesSent && (!observation.outcomeCertain ||
        exchanges.original.requestBytes.byteLength === 0 ||
        exchanges.original.responseBytes.byteLength === 0)) {
        await answerInput.journal.terminal({ reservedPayloadSha256: payloadSha256,
          terminalPayloadSha256: canonicalSha256({ attemptId, observation: publicObservation,
            reason: "authenticated_raw_envelope_absent" }), questionId: queryId,
          repetition: input.repetition, rootBindingSha256: input.rootBindingSha256,
          state: "outcome_unknown" });
        throw new Error("semantic quality V4 provider outcome is unknown and cannot be retried");
      }
      assertProviderExchangeIdentity(exchanges.original.identity, attemptId, "original",
        input.answerExecutionBinding, prepared.request.runId);
      verifyProviderExchangeObservation(input, exchanges.original);
      const providerArtifacts: { readonly artifactKind: SemanticQualityV4ArtifactKind;
        readonly exchangeBindingSha256: string; readonly plaintext: Uint8Array }[] = [
        { artifactKind: "original_provider_request",
          exchangeBindingSha256: canonicalSha256(exchanges.original.identity),
          plaintext: exchanges.original.requestBytes },
        { artifactKind: "original_provider_response",
          exchangeBindingSha256: canonicalSha256(exchanges.original.identity),
          plaintext: exchanges.original.responseBytes },
      ];
      if (exchanges.repair !== null) {
        assertProviderExchangeIdentity(exchanges.repair.identity, attemptId, "repair",
          input.answerExecutionBinding);
        verifyProviderExchangeObservation(input, exchanges.repair);
        providerArtifacts.push({ artifactKind: "repair_provider_request",
          exchangeBindingSha256: canonicalSha256(exchanges.repair.identity),
          plaintext: exchanges.repair.requestBytes }, { artifactKind: "repair_provider_response",
          exchangeBindingSha256: canonicalSha256(exchanges.repair.identity),
          plaintext: exchanges.repair.responseBytes });
      }
      for (const { artifactKind, exchangeBindingSha256, plaintext } of providerArtifacts) {
        const receipt = await input.artifactStore.sealCreateOnly({ artifactKind, attemptId,
          exchangeBindingSha256, key: input.artifactEncryption.key,
          keyId: input.artifactEncryption.keyId, plaintext,
          rootBindingSha256: input.rootBindingSha256 });
        await input.artifactStore.verifyReceipt({ key: input.artifactEncryption.key, receipt });
        input.recordArtifactReceipt(receipt);
        providerReceipts.set(artifactKind, receipt);
      }
      const runtimeReceipt = await input.artifactStore.sealCreateOnly({
        artifactKind: "response_runtime", attemptId, key: input.artifactEncryption.key,
        keyId: input.artifactEncryption.keyId,
        plaintext: new TextEncoder().encode(canonicalIntegerJson({ generated,
          observation: publicObservation })),
        rootBindingSha256: input.rootBindingSha256 });
      await input.artifactStore.verifyReceipt({ key: input.artifactEncryption.key,
        receipt: runtimeReceipt });
      input.recordArtifactReceipt(runtimeReceipt);
      const terminalState = observation.providerBytesSent && !observation.outcomeCertain
        ? "outcome_unknown" as const
        : generated.status === "completed" ? "succeeded" as const : "failed" as const;
      await answerInput.journal.terminal({ reservedPayloadSha256: payloadSha256,
        terminalPayloadSha256: canonicalSha256({ attemptId, generated,
        observation: publicObservation }), questionId: queryId, repetition: input.repetition,
      rootBindingSha256: input.rootBindingSha256, state: terminalState });
      if (terminalState === "outcome_unknown") {
        throw new Error("semantic quality V4 provider outcome is unknown and cannot be retried");
      }
      productionAnswerPorts.add(answer);
      const prompt = [prepared.request.task.systemPrompt, prepared.request.task.prompt,
        JSON.stringify(prepared.request.task.controls.outputSchema)].join("\n");
      if (generated.status !== "completed") {
        return { claims: [], measurement: { answerLatencyUs, attemptId,
          originalInput: prepared.exactInput.original,
          originalModelInputSha256: modelInputDigests.get("original_model_input")!,
          repairInput: prepared.exactInput.repair,
          repairModelInputSha256: modelInputDigests.get("repair_model_input")!,
          responseBytes: observation.responseBytes,
          originalProviderRequestSha256: providerReceipts.get("original_provider_request")!.plaintextSha256,
          originalProviderResponseSha256: providerReceipts.get("original_provider_response")!.plaintextSha256,
          repairProviderRequestSha256: providerReceipts.get("repair_provider_request")?.plaintextSha256 ?? null,
          repairProviderResponseSha256: providerReceipts.get("repair_provider_response")?.plaintextSha256 ?? null,
          responseRuntimeArtifactSha256: runtimeReceipt.plaintextSha256,
          runtimeReceiptSha256: observation.runtimeReceiptSha256 },
        prompt, status: "failure" as const };
      }
      const evidenceById = new Map(plan.evidence.map((turn) => [turn.evidenceId, turn]));
      const claims = generated.answer.claims.map((claim, claimOrdinal) =>
        generatedClaim(queryId, claimOrdinal, claim.text,
          claim.evidenceIds.map((id) => evidenceById.get(id)!)));
      return Object.freeze({
        claims: Object.freeze(claims),
        measurement: Object.freeze({ answerLatencyUs, attemptId,
        originalInput: prepared.exactInput.original,
          originalModelInputSha256: modelInputDigests.get("original_model_input")!,
          repairInput: prepared.exactInput.repair,
          repairModelInputSha256: modelInputDigests.get("repair_model_input")!,
          responseBytes: observation.responseBytes,
          originalProviderRequestSha256: providerReceipts.get("original_provider_request")!.plaintextSha256,
          originalProviderResponseSha256: providerReceipts.get("original_provider_response")!.plaintextSha256,
          repairProviderRequestSha256: providerReceipts.get("repair_provider_request")?.plaintextSha256 ?? null,
          repairProviderResponseSha256: providerReceipts.get("repair_provider_response")?.plaintextSha256 ?? null,
          responseRuntimeArtifactSha256: runtimeReceipt.plaintextSha256,
          runtimeReceiptSha256: observation.runtimeReceiptSha256 }),
        prompt,
        status: generated.answer.status === "answered" ? "answered" as const :
          "abstained" as const,
      });
    },
    });
    return answer;
  };
  return Object.freeze({ createAnswer, evidence, retrieval });
}

function assertProviderExchangeIdentity(
  identity: import("@discord-meeting/subscription-runtime-adapter")
    .KnowledgeAnswerProviderExchangeIdentity,
  attemptId: string,
  callOrdinal: "original" | "repair",
  executionBinding: KnowledgeAnswerQualificationExecutionBinding,
  runId?: string,
): void {
  if (identity.attemptId !== attemptId || identity.callOrdinal !== callOrdinal ||
    identity.purpose !== "discord_meeting.knowledge.answer.v1" ||
    (runId !== undefined && identity.runId !== runId) ||
    identity.runtimeProfile.maxOutputTokens !== 2_048 ||
    identity.runtimeProfile.model !== "gpt-5.6-sol" ||
    identity.runtimeProfile.outputSchemaName !== "discord_meeting_knowledge_answer_v1" ||
    identity.runtimeProfile.policyVersion !== "meeting-knowledge.answer.subscription-runtime.v3" ||
    identity.runtimeProfile.reasoningEffort !== "medium" ||
    canonicalIntegerJson(identity.executionBinding) !== canonicalIntegerJson(executionBinding)) {
    throw new Error("semantic quality V4 provider exchange identity is substituted");
  }
}

function createProductionRetrievalPort(context: {
  readonly input: SemanticQualityV4ProductionPortsInput;
  readonly requestByQuestion: Map<string, FocusedLocatorRetrievalV2RequestSnapshot>;
  readonly retrievalAdapter: InfinityContextRetrievalV2Adapter;
}): SemanticQualityV4RetrievalPort {
  const retrieval: SemanticQualityV4RetrievalPort = Object.freeze({ retrieve: async (portInput: Parameters<
    SemanticQualityV4RetrievalPort["retrieve"]>[0]) => {
    const { input, requestByQuestion, retrievalAdapter } = context;
    const { queryId, question } = portInput;
    const request = await input.preparer.prepare({ ...input.questionContext({ queryId }), question });
    if (request === null) {
      throw new Error("semantic quality V4 production request preparation failed");
    }
    assertReleaseCandidateRequest(request);
    requestByQuestion.set(queryId, request);
    const attemptId = semanticQualityV4AttemptId({ questionId: queryId,
      repetition: input.repetition, rootBindingSha256: input.rootBindingSha256 });
    const exchangeIdentity = Object.freeze({ attemptId, callOrdinal: "retrieval" as const,
      executionBinding: input.retrievalExecutionBinding, queryId });
    const exchangeBindingSha256 = canonicalSha256(exchangeIdentity);
    const reservedPayloadSha256 = canonicalSha256({ request });
    await input.retrievalJournal.reserve({ reservedPayloadSha256, questionId: queryId,
      repetition: input.repetition, rootBindingSha256: input.rootBindingSha256 });
    const result = await retrievalAdapter.retrieve(request);
    const exchange = retrievalAdapter.takeExactExchange();
    const observation = Object.freeze({ ...retrievalAdapter.takeObservation(),
      requestSnapshotSha256: canonicalSha256(request) });
    assertRetrievalObservation(observation, request);
    if (sha256Bytes(exchange.requestBytes) !== observation.requestSha256 ||
      sha256Bytes(exchange.responseBytes) !== observation.responseSha256) {
      throw new Error("semantic quality V4 exact retrieval exchange differs from observation");
    }
    input.verifyExchangeObservation(exchangeObservationBinding({
      attemptId, callOrdinal: "retrieval", execution: input.retrievalExecutionBinding,
      providerRunId: queryId, requestSha256: observation.requestSha256,
      responseSha256: observation.responseSha256,
      receiptOrdinals: ["retrieval_request:1", "retrieval_response:1"] }));
    for (const [artifactKind, plaintext] of [["retrieval_request", exchange.requestBytes],
      ["retrieval_response", exchange.responseBytes]] as const) {
      const receipt = await input.artifactStore.sealCreateOnly({ artifactKind, attemptId,
        exchangeBindingSha256,
        key: input.artifactEncryption.key, keyId: input.artifactEncryption.keyId, plaintext,
        rootBindingSha256: input.rootBindingSha256 });
      await input.artifactStore.verifyReceipt({ key: input.artifactEncryption.key, receipt });
      input.recordArtifactReceipt(receipt);
    }
    await input.retrievalJournal.terminal({ reservedPayloadSha256,
      terminalPayloadSha256: canonicalSha256({ exchangeIdentity, observation }), questionId: queryId,
      repetition: input.repetition, rootBindingSha256: input.rootBindingSha256,
      state: "succeeded" });
    productionRetrievalPorts.add(retrieval);
    const latencyUs = observation.capabilityAndRetrievalLatencyUs;
    if (result.status !== "available") {
      return Object.freeze({ ...observation, expandedNeighborLocators: [], latencyUs,
        rankedSeedLocators: [], status: "failure" as const });
    }
    return Object.freeze({ ...observation, expandedNeighborLocators: Object.freeze([]), latencyUs,
      rankedSeedLocators: Object.freeze(result.candidates.map(({ locator }) =>
        Object.freeze({ locatorId: locator }))), status: "completed" as const });
  } });
  return retrieval;
}

function verifyProviderExchangeObservation(
  input: SemanticQualityV4ProductionPortsInput,
  exchange: import("@discord-meeting/subscription-runtime-adapter").KnowledgeAnswerProviderExchange,
): void {
  const execution = exchange.identity.executionBinding;
  if (execution === undefined) {
    throw new Error("semantic quality V4 provider execution binding is absent");
  }
  input.verifyExchangeObservation(exchangeObservationBinding({
    attemptId: exchange.identity.attemptId, callOrdinal: exchange.identity.callOrdinal, execution,
    providerRunId: exchange.identity.runId,
    requestSha256: sha256Bytes(exchange.requestBytes),
    responseSha256: sha256Bytes(exchange.responseBytes),
    receiptOrdinals: [`${exchange.identity.callOrdinal}_provider_request:1`,
      `${exchange.identity.callOrdinal}_provider_response:1`] }));
}

function exchangeObservationBinding(input: {
  readonly attemptId: string;
  readonly callOrdinal: "original" | "repair" | "retrieval";
  readonly execution: KnowledgeAnswerQualificationExecutionBinding;
  readonly providerRunId: string;
  readonly receiptOrdinals: readonly string[];
  readonly requestSha256: string;
  readonly responseSha256: string;
}): Readonly<Record<string, string>> {
  return Object.freeze({ artifactBindingSha256: input.execution.artifactBindingSha256,
    attemptId: input.attemptId,
    callOrdinal: input.callOrdinal, campaignRunId: input.execution.campaignRunId,
    endpointIdentitySha256: input.execution.endpointIdentitySha256,
    processIdentitySha256: input.execution.processIdentitySha256,
    promptMapperSha256: input.execution.promptMapperSha256,
    providerRunId: input.providerRunId, receiptOrdinalsSha256:
      canonicalSha256(input.receiptOrdinals), requestSha256: input.requestSha256,
    responseSha256: input.responseSha256,
    serviceGenerationSha256: input.execution.serviceGenerationSha256,
    serviceIdentitySha256: input.execution.serviceIdentitySha256,
    stableAttemptId: input.execution.stableAttemptId,
    tokenizerSha256: input.execution.tokenizerSha256 });
}

function publicTurn(turn: SemanticQualityV4ProductionEvidenceTurn) {
  return { endMs: turn.endMs, sourceLocatorId: turn.sourceLocatorId,
    speakerId: turn.speakerId, startMs: turn.startMs, text: turn.text, turnId: turn.turnId };
}

function generatedClaim(queryId: string, claimOrdinal: number, text: string,
  evidence: readonly ((RehydratedEvidenceTurn & { readonly evidenceId: string }) | undefined)[]):
SemanticQualityV4GeneratedClaim {
  const verifiedEvidence = evidence.map((turn) => {
    if (turn === undefined) {
      throw new Error("semantic quality V4 answer cited evidence outside the production prompt");
    }
    return turn;
  });
  const citationRefs = verifiedEvidence.map(({ endMs, speakerId, startMs, turnId }) =>
    Object.freeze({ endMs, speakerId, startMs, turnId }));
  const claimPayloadSha256 = canonicalSha256({ factual: true, text });
  return Object.freeze({ citationRefs: Object.freeze(citationRefs),
    claimId: createV4GeneratedClaimId({ citationRefs, claimOrdinal, claimPayloadSha256,
      factual: true, queryId }), claimPayloadSha256, factual: true, text });
}

function assertReleaseCandidateRequest(request: FocusedLocatorRetrievalV2RequestSnapshot): void {
  const policy = DEFAULT_FOCUSED_LOCATOR_RETRIEVAL_V2_POLICY;
  if (request.budgets.resultLimit !== 10 || request.budgets.evidenceByteLimit !== 16_000 ||
    request.budgets.candidateLimit !== policy.candidateLimit ||
    request.budgets.deadlineMs !== policy.deadlineMs ||
    request.budgets.responseByteLimit !== policy.responseByteLimit ||
    request.binding.profileId !== `locator-v2-full-${request.binding.indexProfileDigest}` ||
    canonicalIntegerJson([...request.binding.requiredProviderLanes].toSorted()) !==
      canonicalIntegerJson(["postgres_keyword", "qdrant_dense"])) {
    throw new Error("semantic quality V4 request differs from the release-candidate snapshot");
  }
}

function assertRetrievalObservation(observation: SemanticQualityV4RetrievalObservation,
  request: FocusedLocatorRetrievalV2RequestSnapshot): void {
  const integers = [observation.capabilityAndRetrievalLatencyUs, observation.capabilityBytes,
    observation.requestBytes, observation.responseBytes, observation.routeLatencyUs];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    [observation.capabilitySha256, observation.requestSha256, observation.responseSha256,
      observation.requestSnapshotSha256].some((value) => !/^[a-f0-9]{64}$/u.test(value)) ||
    observation.requestSnapshotSha256 !== canonicalSha256(request) ||
    observation.routeLatencyUs > observation.capabilityAndRetrievalLatencyUs) {
    throw new Error("semantic quality V4 retrieval observation is invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

class ConcreteProductionPostgresAuthority implements SemanticQualityV4ProductionPostgresAuthority {
  readonly #bindings = new Map<string, GroundedAnswerGenerationBinding>();
  readonly #input: {
    readonly authority: PostgresHistoricalEvidenceAuthority;
    readonly contexts: ReadonlyMap<string, { readonly currentMeetingId: string;
      readonly roomId: string; readonly scopeId: string }>;
    readonly ids: HmacHistoricalOpaqueIds; readonly store: PostgresHistoricalMemoryStore;
  };
  public constructor(input: {
    readonly authority: PostgresHistoricalEvidenceAuthority;
    readonly contexts: ReadonlyMap<string, { readonly currentMeetingId: string;
      readonly roomId: string; readonly scopeId: string }>;
    readonly ids: HmacHistoricalOpaqueIds; readonly store: PostgresHistoricalMemoryStore;
  }) {this.#input = Object.freeze({ ...input });}
  public async rehydrate(value: { readonly locatorIds: readonly string[];
    readonly queryId: string; readonly request: FocusedLocatorRetrievalV2RequestSnapshot }) {
    const context = this.#input.contexts.get(value.queryId)!;
    const records = await this.#input.store.findCurrentCandidates(context.scopeId, context.roomId,
      value.locatorIds);
    if (records.length !== value.locatorIds.length) {throw new Error("PostgreSQL locator authority incomplete");}
    const output: SemanticQualityV4ProductionEvidenceTurn[] = [];
    for (const record of records) {
      if (!await this.#input.store.isCurrentGeneration(record.binding,
        record.plan.topology.indexGeneration)) {throw new Error("PostgreSQL locator generation is stale");}
      const meeting = await this.#input.authority.loadAcceptedFinalMeeting(record.binding);
      if (meeting === null) {throw new Error("PostgreSQL accepted meeting authority is absent");}
      const block = rehydrateHistoricalBlock(meeting, record.plan, record.ordinal, this.#input.ids);
      output.push(...block.turns.map((turn) => Object.freeze({ endMs: turn.endMs,
        sourceLocatorId: block.candidateLocator, speakerId: turn.speakerId,
        source: { historicalSource: { candidateLocator: block.candidateLocator,
          indexGeneration: block.indexGeneration, releaseId: block.binding.releaseId },
        meetingId: block.binding.meetingId, sourceEndCodePoint: turn.sourceEndCodePoint,
        sourceStartCodePoint: turn.sourceStartCodePoint, transcriptId: block.binding.transcriptId,
        transcriptVersion: block.binding.transcriptVersion }, startMs: turn.startMs, text: turn.text,
        turnHash: canonicalFinalReplyTurnHash(turn), turnId: turn.turnId })));
      this.#bindings.set(value.queryId, Object.freeze({
        canonicalEvidenceHash: canonicalSha256(output.map(({ turnHash }) => turnHash)),
        memoryGeneration: block.indexGeneration,
        transcriptVersion: block.binding.transcriptVersion }));
    }
    return Object.freeze(output);
  }
  public answerBinding(queryId: string): GroundedAnswerGenerationBinding {
    const value = this.#bindings.get(queryId);
    if (value === undefined) {throw new Error("PostgreSQL answer binding is absent");}
    return value;
  }
}
