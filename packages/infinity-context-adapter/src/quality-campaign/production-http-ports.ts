import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { digest, exactRecord, safeId } from "./canonical.js";
import type { AdjudicationAuthorityPort } from "./adjudication.js";
import type { ProviderExchangePort } from "./execution.js";
import type { QualityCampaignRelease } from "./release.js";
import type { CampaignCallContext, CampaignProviderPorts,
  QualityCampaignProductionPorts } from "./production-ports.js";

interface HttpConnectionConfiguration {
  readonly absenceAuthority: HttpAuthority;
  readonly absenceEndpoint: string;
  readonly adjudicators: readonly [HttpReviewer, HttpReviewer, HttpReviewer];
  readonly answerEndpoint: string;
  readonly artifactCustody: { readonly envelopeRoot: string; readonly keyCustodySha256: string;
    readonly keyId: string; readonly keyPath: string };
  readonly capabilityEndpoint: string;
  readonly credentialPath: string;
  readonly deletionAuthority: HttpAuthority;
  readonly deletionEndpoint: string;
  readonly evidenceEndpoint: string;
  readonly holdoutAnswerEndpoint: string;
  readonly holdoutCapabilityEndpoint: string;
  readonly holdoutEvidenceEndpoint: string;
  readonly holdoutProviderResultAuthority: HttpAuthority;
  readonly holdoutRetrievalEndpoint: string;
  readonly providerResultAuthority: HttpAuthority;
  readonly rawOutcomeEndpoint: string;
  readonly releaseObservationEndpoint: string;
  readonly retrievalEndpoint: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_http_connections.v3";
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
  const reviewers = await Promise.all(config.adjudicators.map(async (value) => ({
    authorityId: value.keyId, publicKeyPem: (await authority(value)).publicKeyPem,
    signerKeyId: value.keyId,
    adjudicate: async (input) => await requestJson(value.endpoint, token,
      withoutSignal(input), context(input)),
  } satisfies AdjudicationAuthorityPort)));
  return Object.freeze({
    absence: { authorityId: config.absenceAuthority.keyId,
      observe: async (input: AbsenceInput) => await requestJson(config.absenceEndpoint, token,
        withoutContext(input), input.context) },
    artifactCustody: {
      loadKey: async ({ keyId }: { readonly keyId: string }) =>
        keyId === config.artifactCustody.keyId ? {
        key: await readFile(absolute(config.artifactCustody.keyPath)),
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
      holdout: async (input: HoldoutEvidenceInput) => await requestJson(
        config.holdoutEvidenceEndpoint, token, withoutContext(input), input.context) as never,
      main: async (input: MainEvidenceInput) => await requestJson(config.evidenceEndpoint, token,
        withoutContext(input), input.context) as never,
    },
    holdoutProvider: provider(config.holdoutCapabilityEndpoint,
      config.holdoutRetrievalEndpoint, config.holdoutAnswerEndpoint, holdoutResultAuthority),
    mainProvider: provider(config.capabilityEndpoint, config.retrievalEndpoint,
      config.answerEndpoint, mainResultAuthority),
    release: { observe: async (callContext: CampaignCallContext) => await requestJson(
      config.releaseObservationEndpoint, token, {}, callContext) as QualityCampaignRelease },
    review: { first: reviewers[0]!, second: reviewers[1]!, resolver: reviewers[2]!,
      rawOutcomeEnvelopeSha256: async (attemptId: string, callContext: CampaignCallContext) => {
        const value = await requestJson(config.rawOutcomeEndpoint, token, { attemptId },
          callContext) as { readonly rawOutcomeEnvelopeSha256?: unknown };
        if (typeof value.rawOutcomeEnvelopeSha256 !== "string") {
          throw new Error("raw outcome authority returned an invalid envelope");
        }
        return value.rawOutcomeEnvelopeSha256;
      },
      vault: { reconstruct: async (input: VaultInput) => await requestJson(
        config.rawOutcomeEndpoint, token, withoutSignal(input), context(input)) as never } },
  });
}

function exchange(endpoint: string, token: string): ProviderExchangePort {
  return { exchange: async (input) => await requestJson(endpoint, token, {
    attempt: input.attempt, deadlineEpochMs: input.deadlineEpochMs,
    requestDigestSha256: input.requestDigestSha256,
    requestBase64: Buffer.from(input.request).toString("base64") }, {
      deadlineEpochMs: input.deadlineEpochMs, signal: input.signal }) as never };
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
  const keys = ["absenceAuthority", "absenceEndpoint", "adjudicators", "answerEndpoint",
    "artifactCustody",
    "capabilityEndpoint", "credentialPath", "deletionAuthority", "deletionEndpoint",
    "evidenceEndpoint", "holdoutAnswerEndpoint", "holdoutCapabilityEndpoint",
    "holdoutEvidenceEndpoint", "holdoutProviderResultAuthority", "holdoutRetrievalEndpoint",
    "providerResultAuthority", "rawOutcomeEndpoint", "releaseObservationEndpoint",
    "retrievalEndpoint", "schemaVersion"];
  const record = exactRecord(JSON.parse(await readFile(absolute(path), "utf8")) as unknown,
    keys, "production connection configuration");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_http_connections.v3" ||
    !Array.isArray(record.adjudicators) || record.adjudicators.length !== 3) {
    throw new Error("production connection configuration is invalid");
  }
  const typed = record as unknown as HttpConnectionConfiguration;
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

async function authority(value: HttpAuthority) {
  return Object.freeze({ keyId: value.keyId,
    publicKeyPem: await readFile(absolute(value.publicKeyPath), "utf8") });
}
function context(input: { readonly deadlineEpochMs: number; readonly signal: AbortSignal }) {
  return { deadlineEpochMs: input.deadlineEpochMs, signal: input.signal };
}
function withoutSignal<T extends { readonly signal: AbortSignal }>(input: T) {
  const { signal: _signal, ...rest } = input; return rest;
}
function withoutContext<T extends { readonly context: CampaignCallContext }>(input: T) {
  const { context: _context, ...rest } = input; return rest;
}
function absolute(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error("production path must be absolute");}
  return resolve(path);
}
