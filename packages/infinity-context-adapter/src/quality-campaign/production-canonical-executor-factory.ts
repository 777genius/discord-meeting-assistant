import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { PrepareFocusedLocatorRetrievalV2Request,
  type FocusedLocatorRetrievalV2ProviderBinding } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresHistoricalEvidenceAuthority, PostgresHistoricalMemoryStore,
  PostgresHistoricalRoomAuthoritySnapshot } from "@discord-meeting/postgres-adapter";
import { createGrpcQualifiedGroundedAnswerAdapter, GrpcSubscriptionRuntimeTransport,
  subscriptionRuntimeCliEngine, type KnowledgeAnswerQualificationExecutionBinding } from
  "@discord-meeting/subscription-runtime-adapter";
import { CONTEXT_RETRIEVAL_CONTRACT, CONTEXT_RETRIEVAL_RANKING_POLICY } from
  "@infinity-context/sdk";
import { Pool } from "pg";

import { HmacHistoricalOpaqueIds } from "../hmac-historical-ids.js";
import { InfinityContextRetrievalV2Adapter } from "../infinity-context-retrieval-v2.js";
import { digest, exactRecord, safeId, sha256 } from "./canonical.js";
import { verifyExternalSignedValue } from "./execution.js";
import { ExecuteAdmittedQualificationQuestion,
  type QualificationQuestionExecutorFactoryPort } from
  "./execute-admitted-qualification-question.js";
import { createProductionCanonicalExecutionEvidence, recoverProductionCanonicalOutcome } from
  "./production-canonical-execution-evidence.js";
import { createProductionCanonicalQuestionChain,
  type QualificationScopeTopologyPort } from "./production-canonical-question-chain.js";

export interface ProductionCanonicalExecutionConnectionConfiguration {
  readonly answerExecutionBindingPath: string;
  readonly answerJournalRoot: string;
  readonly artifactKeyId: string;
  readonly artifactKeyPath: string;
  readonly artifactRoot: string;
  readonly expectedRuntimeLauncherSha256: string;
  readonly infinityBaseUrl: string;
  readonly infinityCapabilityPath: string;
  readonly infinityTokenPath: string;
  readonly postgresUrlPath: string;
  readonly requestTimeoutMs: number;
  readonly retrievalJournalRoot: string;
  readonly runtimeAddress: string;
  readonly runtimeTokenPath: string;
  readonly topologyAuthority: { readonly keyId: string; readonly publicKeyPath: string };
  readonly topologyKeyPath: string;
  readonly topologyPath: string;
}

interface ScopeTopologyDocument {
  readonly entries: readonly { readonly currentMeetingId: string; readonly questionId: string;
    readonly reference: string; readonly roomId: string; readonly scopeId: string }[];
  readonly schemaVersion: "meeting_knowledge.quality_scope_topology.v1";
}

/** Concrete installed composition of the official SDK, selected PostgreSQL evidence and gRPC answer. */
export async function createProductionCanonicalExecutorFactory(
  config: ProductionCanonicalExecutionConnectionConfiguration,
): Promise<QualificationQuestionExecutorFactoryPort> {
  validateConfiguration(config);
  const [artifactKeyText, capabilityValue, executionBindingValue, infinityToken,
    postgresUrl, runtimeToken, topologyKey, topologyValue, topologyPublicKeyPem] =
    await Promise.all([
      readFile(absolute(config.artifactKeyPath, "canonical artifact key"), "utf8"),
      readJson(config.infinityCapabilityPath, "Infinity capability"),
      readJson(config.answerExecutionBindingPath, "answer execution binding"),
      readFile(absolute(config.infinityTokenPath, "Infinity token"), "utf8"),
      readFile(absolute(config.postgresUrlPath, "PostgreSQL URL"), "utf8"),
      readFile(absolute(config.runtimeTokenPath, "runtime token"), "utf8"),
      readFile(absolute(config.topologyKeyPath, "topology HMAC key")),
      readJson(config.topologyPath, "scope topology"),
      readFile(absolute(config.topologyAuthority.publicKeyPath,
        "scope topology authority key"), "utf8"),
    ]);
  const artifactKey = Buffer.from(artifactKeyText.trim(), "base64");
  if (artifactKey.byteLength !== 32 || infinityToken.trim() === "" ||
    postgresUrl.trim() === "" || runtimeToken.trim().length < 16 || topologyKey.byteLength < 32) {
    throw new Error("canonical execution credentials or encryption material are invalid");
  }
  const capability = decodeCapability(capabilityValue);
  const providerBinding = providerBindingFrom(capability);
  const executionBinding = decodeExecutionBinding(executionBindingValue);
  const topology = decodeTopology(topologyValue, config.topologyAuthority.keyId,
    topologyPublicKeyPem);
  const pool = new Pool({ connectionString: postgresUrl.trim(), connectionTimeoutMillis: 5_000,
    max: 32 });
  const store = new PostgresHistoricalMemoryStore(pool);
  const evidenceAuthority = new PostgresHistoricalEvidenceAuthority(pool);
  const ids = new HmacHistoricalOpaqueIds(topologyKey);
  const preparer = new PrepareFocusedLocatorRetrievalV2Request({ ids, providerBinding,
    snapshot: new PostgresHistoricalRoomAuthoritySnapshot(pool) });
  const transport = new GrpcSubscriptionRuntimeTransport({ address: config.runtimeAddress,
    serviceToken: runtimeToken.trim() });
  const topologyPort = topologyResolver(topology);

  return Object.freeze({ create: async (binding: Parameters<
    QualificationQuestionExecutorFactoryPort["create"]>[0]) => {
    assertReleaseBinding(binding, config, capability, executionBinding);
    const evidence = createProductionCanonicalExecutionEvidence({ answerJournalRoot:
      config.answerJournalRoot, artifactKey, artifactKeyId: config.artifactKeyId,
      artifactRoot: config.artifactRoot, attemptId: binding.attemptId,
      questionId: binding.questionId, repetition: binding.repetition,
      retrievalJournalRoot: config.retrievalJournalRoot,
      rootBindingSha256: binding.campaignRootSha256 });
    let answerReserved = false;
    const guardedJournal = Object.freeze({
      reserve: async (input: Parameters<typeof evidence.journal.reserve>[0]) => {
        await evidence.journal.reserve(input);
        if (input.phase === "answer") {answerReserved = true;}
      },
      terminal: evidence.journal.terminal.bind(evidence.journal),
    });
    const answer = createGrpcQualifiedGroundedAnswerAdapter({
      beforeProviderCall: async (identity) => {
        if (identity.attemptId !== binding.attemptId || !answerReserved) {
          throw new Error("grounded answer provider bytes preceded durable reservation");
        }
      },
      executionBinding,
      options: { expectedLauncherSha256: config.expectedRuntimeLauncherSha256,
        expectedRuntimeEngine: subscriptionRuntimeCliEngine, maxOutputTokens: 2_048 },
      transport,
    });
    const chain = createProductionCanonicalQuestionChain({ answer, audit: evidence.audit,
      evidenceAuthority, ids, journal: guardedJournal, preparer,
      retrieval: new InfinityContextRetrievalV2Adapter({ baseUrl: config.infinityBaseUrl,
        operationTimeoutMs: Math.min(4_000, config.requestTimeoutMs * 2),
        requestTimeoutMs: config.requestTimeoutMs, token: infinityToken.trim() }),
      spend: binding.reservation, store, topology: topologyPort });
    return new ExecuteAdmittedQualificationQuestion(chain);
  }, recover: async (binding: Parameters<QualificationQuestionExecutorFactoryPort[
    "recover"]>[0]) => await recoverProductionCanonicalOutcome({ answerJournalRoot:
      config.answerJournalRoot, artifactKey, artifactRoot: config.artifactRoot,
      attemptId: binding.attemptId, questionId: binding.questionId,
      repetition: binding.repetition, retrievalJournalRoot: config.retrievalJournalRoot,
      rootBindingSha256: binding.campaignRootSha256 }) });
}

function assertReleaseBinding(binding: Parameters<QualificationQuestionExecutorFactoryPort[
  "create"]>[0], config: ProductionCanonicalExecutionConnectionConfiguration,
capability: ReturnType<typeof decodeCapability>,
execution: KnowledgeAnswerQualificationExecutionBinding): void {
  for (const value of [binding.answerProcessIdentitySha256, binding.campaignRootSha256,
    binding.infinityCapabilitySha256, binding.mapperSha256, binding.releaseRootSha256,
    binding.spendReservationSha256, binding.tokenizerSha256]) {digest(value, "canonical release binding");}
  if (sha256(capability) !== binding.infinityCapabilitySha256 ||
    config.expectedRuntimeLauncherSha256 !== binding.answerProcessIdentitySha256 ||
    execution.promptMapperSha256 !== binding.mapperSha256 ||
    execution.tokenizerSha256 !== binding.tokenizerSha256) {
    throw new Error("canonical execution adapters differ from the pinned release");
  }
}

function decodeCapability(value: unknown) {
  const record = value as Record<string, unknown>;
  for (const key of ["capability_fingerprint", "index_profile_digest", "profile_id",
    "service_revision"] as const) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error("Infinity capability artifact is invalid");
    }
  }
  return record as Record<string, unknown> & { readonly capability_fingerprint: string;
    readonly index_profile_digest: string; readonly profile_id: string;
    readonly service_revision: string };
}

function providerBindingFrom(capability: ReturnType<typeof decodeCapability>):
FocusedLocatorRetrievalV2ProviderBinding {
  if (capability.profile_id !== `locator-v2-full-${capability.index_profile_digest}`) {
    throw new Error("Infinity capability is not the full locator production profile");
  }
  return Object.freeze({ capabilityFingerprint: capability.capability_fingerprint,
    contractVersion: CONTEXT_RETRIEVAL_CONTRACT,
    indexProfileDigest: capability.index_profile_digest, profileId: capability.profile_id,
    rankingPolicy: CONTEXT_RETRIEVAL_RANKING_POLICY,
    requiredProviderLanes: Object.freeze(["postgres_keyword", "qdrant_dense"]),
    serviceRevision: capability.service_revision });
}

const EXECUTION_BINDING_KEYS = ["artifactBindingSha256", "campaignRunId",
  "endpointIdentitySha256", "processIdentitySha256", "promptMapperSha256",
  "serviceGenerationSha256", "serviceIdentitySha256", "stableAttemptId",
  "tokenizerSha256"] as const;
function decodeExecutionBinding(value: unknown): KnowledgeAnswerQualificationExecutionBinding {
  const record = exactRecord(value, EXECUTION_BINDING_KEYS, "answer execution binding");
  for (const key of EXECUTION_BINDING_KEYS) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      throw new Error("answer execution binding is invalid");
    }
  }
  return Object.freeze(record) as unknown as KnowledgeAnswerQualificationExecutionBinding;
}

function decodeTopology(document: unknown, keyId: string,
  publicKeyPem: string): ScopeTopologyDocument {
  const signed = verifyExternalSignedValue<ScopeTopologyDocument>(document, keyId, publicKeyPem,
    "scope topology");
  const payload = exactRecord(signed.payload, ["entries", "schemaVersion"], "scope topology");
  if (payload.schemaVersion !== "meeting_knowledge.quality_scope_topology.v1" ||
    !Array.isArray(payload.entries)) {throw new Error("scope topology is invalid");}
  const entries = payload.entries.map((entryValue) => {
    const entry = exactRecord(entryValue, ["currentMeetingId", "questionId", "reference", "roomId",
      "scopeId"], "scope topology entry");
    return Object.freeze({ currentMeetingId: safeId(entry.currentMeetingId, "current meeting ID"),
      questionId: safeId(entry.questionId, "topology question ID"),
      reference: safeId(entry.reference, "scope topology reference"),
      roomId: safeId(entry.roomId, "topology room ID"),
      scopeId: safeId(entry.scopeId, "topology scope ID") });
  });
  if (new Set(entries.map(({ reference }) => reference)).size !== entries.length) {
    throw new Error("scope topology references are duplicated");
  }
  return Object.freeze({ entries: Object.freeze(entries), schemaVersion: payload.schemaVersion });
}

function topologyResolver(topology: ScopeTopologyDocument): QualificationScopeTopologyPort {
  const byReference = new Map(topology.entries.map((entry) => [entry.reference, entry]));
  return Object.freeze({ resolve: async (reference: string, questionId: string) => {
    const entry = byReference.get(reference);
    if (entry === undefined || entry.questionId !== questionId) {
      throw new Error("signed scope topology reference is absent or question-substituted");
    }
    return Object.freeze({ currentMeetingId: entry.currentMeetingId, roomId: entry.roomId,
      scopeId: entry.scopeId });
  } });
}

function validateConfiguration(config: ProductionCanonicalExecutionConnectionConfiguration): void {
  for (const [key, value] of Object.entries(config)) {
    if ((key.endsWith("Path") || key.endsWith("Root")) && typeof value === "string") {
      absolute(value, key);
    }
  }
  if (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1 ||
    config.requestTimeoutMs > 2_000 || config.artifactKeyId.trim() === "" ||
    !/^https?:\/\//u.test(config.infinityBaseUrl) || config.runtimeAddress.trim() === "") {
    throw new Error("canonical execution connection configuration is invalid");
  }
  digest(config.expectedRuntimeLauncherSha256, "expected runtime launcher");
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {return JSON.parse(await readFile(absolute(path, label), "utf8")) as unknown;}
  catch (error) {throw new Error(`${label} is unavailable or invalid`, { cause: error });}
}
function absolute(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error(`${label} must be absolute`);}
  return resolve(path);
}
