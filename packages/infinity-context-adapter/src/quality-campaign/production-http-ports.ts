import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { digest, exactRecord, safeId } from "./canonical.js";
import { assertAttemptIdentity, attemptIdentity, type AttemptIdentity,
  type ProviderExchangePort } from "./execution.js";
import { createLocalEvidenceCustody } from "./production-evidence-custody.js";
import { createProductionCanonicalExecutorFactory,
  type ProductionCanonicalExecutionConnectionConfiguration } from
  "./production-canonical-executor-factory.js";
import type { QualityCampaignRelease } from "./release.js";
import type { CampaignCallContext, CampaignProviderPorts,
  CampaignReviewEvidence, QualityCampaignProductionPorts } from "./production-ports.js";

interface HttpConnectionConfiguration {
  readonly absenceAuthority: HttpAuthority;
  readonly absenceEndpoint: string;
  readonly adjudicators: readonly [HttpReviewer, HttpReviewer, HttpReviewer];
  readonly artifactCustody: { readonly envelopeRoot: string; readonly keyCustodySha256: string;
    readonly keyId: string; readonly keyPath: string };
  readonly canonicalExecution: ProductionCanonicalExecutionConnectionConfiguration;
  readonly credentialPath: string;
  readonly deletionAuthority: HttpAuthority;
  readonly deletionEndpoint: string;
  readonly evidenceEndpoint: string;
  readonly evidenceAuthority: HttpAuthority;
  readonly evidenceKeyId: string;
  readonly evidenceKeyPath: string;
  readonly holdoutAnswerEndpoint: string;
  readonly holdoutCapabilityEndpoint: string;
  readonly holdoutEvidenceEndpoint: string;
  readonly holdoutEvidenceAuthority: HttpAuthority;
  readonly holdoutEvidenceKeyId: string;
  readonly holdoutEvidenceKeyPath: string;
  readonly holdoutProviderResultAuthority: HttpAuthority;
  readonly holdoutRetrievalEndpoint: string;
  readonly providerResultAuthority: HttpAuthority;
  readonly rawOutcomeEndpoint: string;
  readonly releaseObservationEndpoint: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_http_connections.v5";
}
interface HttpAuthority { readonly keyId: string; readonly publicKeyPath: string }
interface HttpReviewer extends HttpAuthority { readonly endpoint: string }
type AbsenceInput = Parameters<QualityCampaignProductionPorts["absence"]["observe"]>[0];
type DeletionInput = Parameters<QualityCampaignProductionPorts["deletion"]["deleteDerived"]>[0];
type MainEvidenceInput = Parameters<QualityCampaignProductionPorts["evidence"]["main"]>[0];
type HoldoutEvidenceInput = Parameters<QualityCampaignProductionPorts["evidence"]["holdout"]>[0];
type VaultInput = Parameters<QualityCampaignProductionPorts["review"]["vault"]["reconstruct"]>[0];

/** Concrete HTTP adapter. Every in-flight request is actively bounded and abortable. */
export async function createHttpQualityCampaignProductionPorts(path: string):
Promise<QualityCampaignProductionPorts> {
  const config = await load(path);
  const token = (await readFile(absolute(config.credentialPath), "utf8")).trim();
  if (token === "") {throw new Error("production provider credential is empty");}
  const mainResultAuthority = await authority(config.providerResultAuthority);
  const holdoutResultAuthority = await authority(config.holdoutProviderResultAuthority);
  if (mainResultAuthority.keyId === holdoutResultAuthority.keyId ||
    mainResultAuthority.publicKeyPem === holdoutResultAuthority.publicKeyPem) {
    throw new Error("main and holdout provider result authorities must be distinct");
  }
  const provider = (capability: string, retrieval: string, answer: string,
    resultAuthority: Awaited<ReturnType<typeof authority>>): CampaignProviderPorts =>
    ({ answer: exchange(answer, token), capability: exchange(capability, token),
      resultAuthority, retrieval: exchange(retrieval, token) });
  const evidenceAuthority = await authority(config.evidenceAuthority);
  const mainEvidenceCustody = createLocalEvidenceCustody({ authority: evidenceAuthority,
    key: decodeAesKey(await readFile(absolute(config.evidenceKeyPath), "utf8")),
    keyId: config.evidenceKeyId });
  const holdoutEvidenceCustody = createLocalEvidenceCustody({ authority:
    await authority(config.holdoutEvidenceAuthority), key: decodeAesKey(await readFile(
      absolute(config.holdoutEvidenceKeyPath), "utf8")), keyId: config.holdoutEvidenceKeyId });
  const evidenceCustody = Object.freeze({ open: async (input: Parameters<
    typeof mainEvidenceCustody.open>[0]) => input.kind === "main" ?
      await mainEvidenceCustody.open(input) : await holdoutEvidenceCustody.open(input) });
  let canonicalFactory: Promise<Awaited<ReturnType<
    typeof createProductionCanonicalExecutorFactory>>> | undefined;
  return Object.freeze({
    absence: { authorityId: config.absenceAuthority.keyId,
      observe: async (input: AbsenceInput) => await requestJson(config.absenceEndpoint, token,
        withoutContext(input), input.context) },
    artifactCustody: {
      loadKey: async ({ keyId }: { readonly keyId: string }) =>
        keyId === config.artifactCustody.keyId ? {
        key: await readFile(absolute(config.artifactCustody.keyPath)),
        authorityKeyId: config.artifactCustody.keyId,
        authorityPublicKeyFingerprintSha256: digest(config.artifactCustody.keyCustodySha256,
          "artifact custody authority fingerprint"),
        keyCustodySha256: config.artifactCustody.keyCustodySha256 } : null,
      readEnvelope: async ({ envelopeSha256 }: { readonly envelopeSha256: string }) => {
        if (!/^[a-f0-9]{64}$/u.test(envelopeSha256)) {return null;}
        try {return await readFile(join(absolute(config.artifactCustody.envelopeRoot),
          `${envelopeSha256}.enc.json`));} catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {return null;} throw error;
        }
      },
    },
    clock: { nowEpochMs: () => Date.now() },
    deletion: { authorityId: config.deletionAuthority.keyId,
      deleteDerived: async (input: DeletionInput) => await requestJson(config.deletionEndpoint,
        token, withoutContext(input), input.context) as never },
    evidence: {
      holdout: async (input: HoldoutEvidenceInput) => decodeRawEvidence(await requestJson(
        config.holdoutEvidenceEndpoint, token, withoutContext(input), input.context)),
      main: async (input: MainEvidenceInput) => decodeRawEvidence(await requestJson(
        config.evidenceEndpoint, token, withoutContext(input), input.context)),
    },
    evidenceCustody,
    holdoutProvider: provider(config.holdoutCapabilityEndpoint,
      config.holdoutRetrievalEndpoint, config.holdoutAnswerEndpoint, holdoutResultAuthority),
    mainExecutorFactory: { create: async (input: Parameters<QualityCampaignProductionPorts[
      "mainExecutorFactory"]["create"]>[0]) => {
      canonicalFactory ??= createProductionCanonicalExecutorFactory(config.canonicalExecution);
      return await (await canonicalFactory).create(input);
    }, recover: async (input: Parameters<QualityCampaignProductionPorts[
      "mainExecutorFactory"]["recover"]>[0]) => {
      canonicalFactory ??= createProductionCanonicalExecutorFactory(config.canonicalExecution);
      return await (await canonicalFactory).recover(input);
    } },
    mainResultAuthority,
    release: { observe: async (callContext: CampaignCallContext) => await requestJson(
      config.releaseObservationEndpoint, token, {}, callContext) as QualityCampaignRelease },
    review: {
      receipts: async (attemptId: string, callContext: CampaignCallContext) => {
        safeId(attemptId, "review answer attempt ID");
        const value = await requestJson(config.rawOutcomeEndpoint, token, { attemptId },
          callContext);
        return decodeReviewEvidence(value, attemptId);
      },
      vault: { reconstruct: async (input: VaultInput) => await requestJson(
        config.rawOutcomeEndpoint, token, input, { deadlineEpochMs: Date.now() + 120_000,
          signal: new AbortController().signal }) as never } },
  });
}

function exchange(endpoint: string, token: string): ProviderExchangePort {
  return { exchange: async (input) => decodeProviderExchange(await requestJson(endpoint, token, {
    attempt: input.attempt, deadlineEpochMs: input.deadlineEpochMs,
    requestDigestSha256: input.requestDigestSha256,
    requestBase64: Buffer.from(input.request).toString("base64") }, {
      deadlineEpochMs: input.deadlineEpochMs, signal: input.signal })) };
}

function decodeProviderExchange(value: unknown): Awaited<ReturnType<ProviderExchangePort["exchange"]>> {
  const record = value as Record<string, unknown>;
  if (record.effect === "unknown") {
    exactRecord(value, ["effect"], "unknown provider exchange response");
    return Object.freeze({ effect: "unknown" });
  }
  const exact = exactRecord(value, ["effect", "resultDigestSha256", "resultEnvelopeBase64",
    "signedResult"], "provider exchange response");
  if (!(["certain_failure", "certain_success"] as const).includes(exact.effect as never) ||
    typeof exact.resultEnvelopeBase64 !== "string") {
    throw new Error("provider exchange response is not a concrete terminal envelope");
  }
  digest(exact.resultDigestSha256, "provider result envelope digest");
  const resultEnvelopeBytes = Buffer.from(exact.resultEnvelopeBase64, "base64");
  if (resultEnvelopeBytes.byteLength === 0) {
    throw new Error("provider result envelope is empty");
  }
  return Object.freeze({ effect: exact.effect as "certain_failure" | "certain_success",
    resultDigestSha256: exact.resultDigestSha256 as string, resultEnvelopeBytes,
    signedResult: exact.signedResult });
}

async function requestJson(endpoint: string, token: string, body: unknown,
  callContext: CampaignCallContext): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => {controller.abort(callContext.signal.reason);};
  if (callContext.signal.aborted) {abort();} else {
    callContext.signal.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(() => {controller.abort(new Error("HTTP authority deadline exceeded"));},
    Math.max(0, callContext.deadlineEpochMs - Date.now()));
  try {
    const response = await fetch(endpoint, { body: JSON.stringify(body), headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json" }, method: "POST",
    signal: controller.signal });
    if (!response.ok) {throw new Error("production authority request failed");}
    return JSON.parse(await response.text()) as unknown;
  } finally {
    clearTimeout(timeout); callContext.signal.removeEventListener("abort", abort);
  }
}

async function load(path: string): Promise<HttpConnectionConfiguration> {
  const keys = ["absenceAuthority", "absenceEndpoint", "adjudicators",
    "artifactCustody",
    "canonicalExecution", "credentialPath", "deletionAuthority", "deletionEndpoint",
    "evidenceAuthority", "evidenceEndpoint", "evidenceKeyId", "evidenceKeyPath",
    "holdoutAnswerEndpoint", "holdoutCapabilityEndpoint", "holdoutEvidenceAuthority",
    "holdoutEvidenceEndpoint", "holdoutEvidenceKeyId", "holdoutEvidenceKeyPath",
    "holdoutProviderResultAuthority", "holdoutRetrievalEndpoint",
    "providerResultAuthority", "rawOutcomeEndpoint", "releaseObservationEndpoint",
    "schemaVersion"];
  const record = exactRecord(JSON.parse(await readFile(absolute(path), "utf8")) as unknown,
    keys, "production connection configuration");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_http_connections.v5" ||
    !Array.isArray(record.adjudicators) || record.adjudicators.length !== 3) {
    throw new Error("production connection configuration is invalid");
  }
  const typed = record as unknown as HttpConnectionConfiguration;
  decodeCanonicalExecutionConfiguration(typed.canonicalExecution);
  const artifactCustody = exactRecord(typed.artifactCustody,
    ["envelopeRoot", "keyCustodySha256", "keyId", "keyPath"], "artifact custody");
  absolute(String(artifactCustody.envelopeRoot)); absolute(String(artifactCustody.keyPath));
  digest(artifactCustody.keyCustodySha256, "artifact key custody");
  safeId(artifactCustody.keyId, "artifact custody key ID");
  if (typed.absenceEndpoint === typed.deletionEndpoint ||
    typed.absenceAuthority.keyId === typed.deletionAuthority.keyId ||
    typed.absenceAuthority.publicKeyPath === typed.deletionAuthority.publicKeyPath) {
    throw new Error("deletion and absence authorities, endpoints, and keys must be distinct");
  }
  return typed;
}

function decodeCanonicalExecutionConfiguration(value:
  ProductionCanonicalExecutionConnectionConfiguration): void {
  const keys = ["answerExecutionBindingPath", "answerJournalRoot", "artifactKeyId",
    "artifactKeyPath", "artifactRoot", "expectedRuntimeLauncherSha256", "infinityBaseUrl",
    "infinityCapabilityPath", "infinityTokenPath", "postgresUrlPath", "requestTimeoutMs",
    "retrievalJournalRoot", "runtimeAddress", "runtimeTokenPath", "topologyAuthority",
    "topologyKeyPath", "topologyPath"];
  const record = exactRecord(value, keys, "canonical execution connection configuration");
  const topologyAuthority = exactRecord(record.topologyAuthority, ["keyId", "publicKeyPath"],
    "scope topology authority");
  absolute(String(topologyAuthority.publicKeyPath));
  for (const [key, item] of Object.entries(record)) {
    if ((key.endsWith("Path") || key.endsWith("Root")) && typeof item === "string") {
      absolute(item);
    }
  }
  digest(record.expectedRuntimeLauncherSha256, "expected runtime launcher");
  if (!Number.isSafeInteger(record.requestTimeoutMs) || Number(record.requestTimeoutMs) < 1 ||
    Number(record.requestTimeoutMs) > 2_000) {
    throw new Error("canonical execution request timeout is invalid");
  }
}

async function authority(value: HttpAuthority) {
  return Object.freeze({ keyId: value.keyId,
    publicKeyPem: await readFile(absolute(value.publicKeyPath), "utf8") });
}
function withoutContext<T extends { readonly context: CampaignCallContext }>(input: T) {
  const { context: _context, ...rest } = input; return rest;
}
function absolute(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error("production path must be absolute");}
  return resolve(path);
}

function decodeAesKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.byteLength !== 32) {throw new Error("evidence custody key is invalid");}
  return key;
}

function decodeRawEvidence(value: unknown) {
  const record = exactRecord(value, ["envelopeBase64", "signedReceipt"],
    "authenticated evidence delivery");
  if (typeof record.envelopeBase64 !== "string") {
    throw new Error("authenticated evidence envelope is invalid");
  }
  return Object.freeze({ envelopeBytes: Buffer.from(record.envelopeBase64, "base64"),
    signedReceipt: record.signedReceipt });
}

const REVIEW_EVIDENCE_KEYS = ["firstEffectEvidence", "firstReceipt",
  "predecessorPlaintextSha256", "rawOutcomeEnvelopeSha256", "resolverEffectEvidence",
  "resolverReceipt", "secondEffectEvidence", "secondReceipt"] as const;
const EFFECT_EVIDENCE_KEYS = ["attempt", "cancellationBoundary", "deadlineEpochMs",
  "requestDigestSha256", "resultDigestSha256", "signedDurableExchange",
  "signedProviderTerminal"] as const;

function decodeReviewEvidence(value: unknown, answerAttemptId: string): CampaignReviewEvidence {
  const record = exactRecord(value, REVIEW_EVIDENCE_KEYS,
    "authenticated adjudication evidence");
  const firstEffectEvidence = decodeEffectEvidence(record.firstEffectEvidence,
    answerAttemptId, "adjudicator_1");
  const secondEffectEvidence = decodeEffectEvidence(record.secondEffectEvidence,
    answerAttemptId, "adjudicator_2");
  const resolverReceipt = nullableSignedValue(record.resolverReceipt, "resolver receipt");
  const resolverEffectEvidence = record.resolverEffectEvidence === null ? null :
    decodeEffectEvidence(record.resolverEffectEvidence, answerAttemptId, "resolver");
  if ((resolverReceipt === null) !== (resolverEffectEvidence === null)) {
    throw new Error("resolver receipt and effect evidence must be present together");
  }
  return Object.freeze({ firstEffectEvidence,
    firstReceipt: signedValue(record.firstReceipt, "first reviewer receipt"),
    predecessorPlaintextSha256: digest(record.predecessorPlaintextSha256,
      "review predecessor plaintext"), rawOutcomeEnvelopeSha256:
      digest(record.rawOutcomeEnvelopeSha256, "review raw outcome envelope"),
    resolverEffectEvidence, resolverReceipt, secondEffectEvidence,
    secondReceipt: signedValue(record.secondReceipt, "second reviewer receipt") });
}

function decodeEffectEvidence(value: unknown, answerAttemptId: string,
  callKind: "adjudicator_1" | "adjudicator_2" | "resolver") {
  const record = exactRecord(value, EFFECT_EVIDENCE_KEYS, `${callKind} effect evidence`);
  const attemptRecord = exactRecord(record.attempt, ["attemptId", "callKind", "callOrdinal",
    "campaignRootSha256", "questionDigestSha256", "questionId", "releaseRootSha256",
    "repetition", "spendReservationSha256"], `${callKind} effect attempt`);
  const attempt = attemptRecord as unknown as AttemptIdentity;
  assertAttemptIdentity(attempt);
  const answerAttempt = attemptIdentity({ callKind: "answer", callOrdinal: 0,
    campaignRootSha256: attempt.campaignRootSha256,
    questionDigestSha256: attempt.questionDigestSha256, questionId: attempt.questionId,
    releaseRootSha256: attempt.releaseRootSha256, repetition: attempt.repetition,
    spendReservationSha256: attempt.spendReservationSha256 });
  if (attempt.callKind !== callKind || attempt.callOrdinal !== 0 ||
    answerAttempt.attemptId !== answerAttemptId || record.cancellationBoundary !== "not_cancelled" ||
    !Number.isSafeInteger(record.deadlineEpochMs) || Number(record.deadlineEpochMs) < 1) {
    throw new Error(`${callKind} effect evidence is not bound to the requested answer attempt`);
  }
  return Object.freeze({ attempt, cancellationBoundary: "not_cancelled" as const,
    deadlineEpochMs: Number(record.deadlineEpochMs), requestDigestSha256:
      digest(record.requestDigestSha256, `${callKind} request`), resultDigestSha256:
      digest(record.resultDigestSha256, `${callKind} result`), signedDurableExchange:
      signedValue(record.signedDurableExchange, `${callKind} durable exchange`),
    signedProviderTerminal: signedValue(record.signedProviderTerminal,
      `${callKind} provider terminal`) });
}

function nullableSignedValue(value: unknown, label: string): unknown {
  return value === null ? null : signedValue(value, label);
}

/** Shape validation is transport-only; adjudicateOutcome performs cryptographic verification. */
function signedValue(value: unknown, label: string): unknown {
  const record = exactRecord(value, ["payload", "signatureBase64", "signerKeyId"], label);
  safeId(record.signerKeyId, `${label} signer key ID`);
  if (typeof record.signatureBase64 !== "string" || record.signatureBase64.length === 0) {
    throw new Error(`${label} signature is invalid`);
  }
  return Object.freeze(record);
}
