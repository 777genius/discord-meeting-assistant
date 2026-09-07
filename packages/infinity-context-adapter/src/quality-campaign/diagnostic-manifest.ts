import { resolve } from "node:path";
import { CONTEXT_RETRIEVAL_CONTRACT, CONTEXT_RETRIEVAL_RANKING_POLICY } from "@infinity-context/sdk";
import { normalizeDiagnosticFinalEvidenceBinding, type DiagnosticFinalEvidenceBinding } from "@discord-meeting/postgres-adapter";
import type { FocusedLocatorRetrievalV2ProviderBinding } from "@discord-meeting/meeting-core/meeting-knowledge";
import { exactRecord, safeId, digest } from "./canonical.js";
export interface DiagnosticQuestion {
  readonly locale: "en" | "ru" | "mixed";
  readonly questionId: string;
  readonly questionText: string;
  readonly scopeTopologyReference: string;
}
export interface DiagnosticManifest {
  readonly schemaVersion: "meeting_knowledge.real40_diagnostic.v1";
  readonly authorityKind: "owner_authorized_nonqualifying_diagnostic";
  readonly runId: string;
  readonly sourceRevision: string;
  readonly sdkVersion: "0.2.4";
  readonly model: "gpt-5.6-sol";
  readonly reasoningEffort: "medium";
  readonly serviceTier: "default";
  readonly frozen: DiagnosticFinalEvidenceBinding;
  readonly rosterSha256: string;
  readonly providerBinding: FocusedLocatorRetrievalV2ProviderBinding;
  readonly questions: readonly DiagnosticQuestion[];
  readonly connections: {
    readonly postgresUrlPath: string;
    readonly infinityTokenPath: string;
    readonly infinityBaseUrl: string;
    readonly runtimeAddress: string;
    readonly runtimeTokenPath: string;
    readonly expectedRuntimeLauncherSha256: string;
    readonly artifactKeyPath: string;
    readonly topologyKeyPath: string;
    readonly artifactRoot: string;
  };
}
export function decodeDiagnosticQuestions(value: unknown): readonly DiagnosticQuestion[] {
  if (!Array.isArray(value) || value.length !== 40) {
    throw new Error("diagnostic needs exactly forty questions");
  }
  const questions = value.map(item => {
    const q = exactRecord(item, ["locale", "questionId", "questionText", "scopeTopologyReference"], "diagnostic question");
    if (!["en", "ru", "mixed"].includes(String(q.locale)) ||
      typeof q.questionText !== "string" || q.questionText.trim().length === 0 ||
      Buffer.byteLength(q.questionText) > 8000) {
      throw new Error("invalid diagnostic question");
    }
    return Object.freeze({ locale: q.locale as DiagnosticQuestion["locale"],
      questionId: safeId(q.questionId, "question"), questionText: q.questionText,
      scopeTopologyReference: safeId(q.scopeTopologyReference, "scope reference") });
  });
  if (new Set(questions.map(q => q.questionId)).size !== 40) {
    throw new Error("duplicate diagnostic questions");
  }
  return Object.freeze(questions);
}
export function decodeDiagnosticManifest(value: unknown): DiagnosticManifest {
  const v = exactRecord(value, ["schemaVersion", "authorityKind", "runId", "sourceRevision", "sdkVersion",
    "model", "reasoningEffort", "serviceTier", "frozen", "rosterSha256", "providerBinding", "questions", "connections"], "diagnostic manifest");
  if (v.schemaVersion !== "meeting_knowledge.real40_diagnostic.v1" ||
    v.authorityKind !== "owner_authorized_nonqualifying_diagnostic" || v.sdkVersion !== "0.2.4" ||
    v.model !== "gpt-5.6-sol" || v.reasoningEffort !== "medium" || v.serviceTier !== "default" ||
    typeof v.sourceRevision !== "string" || !/^[a-f0-9]{40}$/u.test(v.sourceRevision)) {
    throw new Error("invalid nonqualifying diagnostic binding");
  }
  safeId(v.runId, "diagnostic run");
  digest(v.rosterSha256, "roster digest");
  const connections = exactRecord(v.connections, ["postgresUrlPath", "infinityTokenPath", "infinityBaseUrl",
    "runtimeAddress", "runtimeTokenPath", "expectedRuntimeLauncherSha256", "artifactKeyPath", "topologyKeyPath", "artifactRoot"], "diagnostic connections");
  for (const [key, path] of Object.entries(connections)) {
    if (typeof path !== "string" || path.length === 0 || path.includes("\0") ||
      ((key.endsWith("Path") || key.endsWith("Root")) && !path.startsWith("/"))) {
      throw new Error("diagnostic connection invalid");
    }
  }
  digest(connections.expectedRuntimeLauncherSha256, "runtime launcher");
  const provider = exactRecord(v.providerBinding, ["capabilityFingerprint", "contractVersion", "indexProfileDigest",
    "profileId", "rankingPolicy", "requiredProviderLanes", "serviceRevision"], "diagnostic provider");
  digest(provider.capabilityFingerprint, "capability fingerprint");
  digest(provider.indexProfileDigest, "index profile");
  safeId(provider.serviceRevision, "service revision");
  if (provider.contractVersion !== CONTEXT_RETRIEVAL_CONTRACT ||
    provider.rankingPolicy !== CONTEXT_RETRIEVAL_RANKING_POLICY ||
    provider.profileId !== `locator-v2-full-${String(provider.indexProfileDigest)}` ||
    JSON.stringify(provider.requiredProviderLanes) !== JSON.stringify(["postgres_keyword", "qdrant_dense"])) {
    throw new Error("diagnostic requires full retrieval profile");
  }
  return Object.freeze({ ...v,
    frozen: normalizeDiagnosticFinalEvidenceBinding(v.frozen),
    connections: Object.freeze({...connections, artifactRoot:resolve(connections.artifactRoot as string)}),
    providerBinding: Object.freeze({...provider,
      requiredProviderLanes:Object.freeze([...provider.requiredProviderLanes as string[]])}),
    questions: decodeDiagnosticQuestions(v.questions) }) as unknown as DiagnosticManifest;
}
