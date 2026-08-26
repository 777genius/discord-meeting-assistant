import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { exactRecord } from "./canonical.js";
import type { AdjudicationAuthorityPort } from "./adjudication.js";
import type { ProviderExchangePort } from "./execution.js";
import type { QualityCampaignRelease } from "./release.js";
import type { CampaignProviderPorts, QualityCampaignProductionPorts } from
  "./production-ports.js";

interface HttpConnectionConfiguration {
  readonly absenceEndpoint: string;
  readonly adjudicators: readonly [HttpReviewer, HttpReviewer, HttpReviewer];
  readonly answerEndpoint: string;
  readonly capabilityEndpoint: string;
  readonly credentialPath: string;
  readonly deletionEndpoint: string;
  readonly holdoutAnswerEndpoint: string;
  readonly holdoutCapabilityEndpoint: string;
  readonly holdoutRetrievalEndpoint: string;
  readonly metricsEndpoint: string;
  readonly providerResultAuthority: HttpAuthority;
  readonly rawOutcomeEndpoint: string;
  readonly releaseObservationEndpoint: string;
  readonly retentionEndpoint: string;
  readonly retrievalEndpoint: string;
  readonly schemaVersion: "meeting_knowledge.semantic_quality_http_connections.v1";
}
interface HttpAuthority { readonly keyId: string; readonly publicKeyPath: string }
interface HttpReviewer extends HttpAuthority { readonly endpoint: string }
type AbsenceInput = Parameters<QualityCampaignProductionPorts["absence"]["observe"]>[0];
type DeletionInput = Parameters<QualityCampaignProductionPorts["deletion"]["deleteDerived"]>[0];
type MetricsInput = Parameters<QualityCampaignProductionPorts["qualification"]["metrics"]>[0];
type RetentionInput = Parameters<QualityCampaignProductionPorts["qualification"]["retention"]>[0];
type VaultInput = Parameters<QualityCampaignProductionPorts["review"]["vault"]["reconstruct"]>[0];

/** Concrete production edge. Secrets are read from custody paths and never enter status values. */
export async function createHttpQualityCampaignProductionPorts(path: string):
Promise<QualityCampaignProductionPorts> {
  const config = await load(path);
  const token = (await readFile(absolute(config.credentialPath), "utf8")).trim();
  if (token === "") {throw new Error("production provider credential is empty");}
  const resultAuthority = { keyId: config.providerResultAuthority.keyId,
    publicKeyPem: await readFile(absolute(config.providerResultAuthority.publicKeyPath), "utf8") };
  const provider = (capability: string, retrieval: string, answer: string): CampaignProviderPorts =>
    ({ answer: exchange(answer, token), capability: exchange(capability, token),
      resultAuthority, retrieval: exchange(retrieval, token) });
  const reviewers = await Promise.all(config.adjudicators.map(async (value) => ({
    authorityId: value.keyId, publicKeyPem: await readFile(absolute(value.publicKeyPath), "utf8"),
    adjudicate: async (input) => await requestJson(value.endpoint, token, input),
  } satisfies AdjudicationAuthorityPort)));
  return Object.freeze({
    absence: { observe: async (input: AbsenceInput) =>
      await requestJson(config.absenceEndpoint, token, input) },
    clock: { nowEpochMs: () => Date.now() },
    deletion: { deleteDerived: async (input: DeletionInput) =>
      await requestJson(config.deletionEndpoint,
      token, input) as never },
    holdoutProvider: provider(config.holdoutCapabilityEndpoint,
      config.holdoutRetrievalEndpoint, config.holdoutAnswerEndpoint),
    mainProvider: provider(config.capabilityEndpoint, config.retrievalEndpoint,
      config.answerEndpoint),
    qualification: {
      metrics: async (input: MetricsInput) =>
        await requestJson(config.metricsEndpoint, token, input) as never,
      retention: async (input: RetentionInput) =>
        await requestJson(config.retentionEndpoint, token, input) as never,
    },
    release: { observe: async () => await requestJson(config.releaseObservationEndpoint,
      token, {}) as QualityCampaignRelease },
    review: { first: reviewers[0]!, second: reviewers[1]!, resolver: reviewers[2]!,
      rawOutcomeEnvelopeSha256: async (attemptId: string) => {
        const value = await requestJson(config.rawOutcomeEndpoint, token, { attemptId }) as
          { readonly rawOutcomeEnvelopeSha256?: unknown };
        if (typeof value.rawOutcomeEnvelopeSha256 !== "string") {
          throw new Error("raw outcome authority returned an invalid envelope");
        }
        return value.rawOutcomeEnvelopeSha256;
      },
      vault: { reconstruct: async (input: VaultInput) =>
        await requestJson(config.rawOutcomeEndpoint,
        token, input) as never } },
  });
}

function exchange(endpoint: string, token: string): ProviderExchangePort {
  return { exchange: async (input) => await requestJson(endpoint, token, {
    attemptId: input.attemptId, requestBase64: Buffer.from(input.request).toString("base64") }) as
    never };
}

async function requestJson(endpoint: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(endpoint, { body: JSON.stringify(body), headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json" }, method: "POST" });
  if (!response.ok) {throw new Error("production authority request failed");}
  return await response.json() as unknown;
}

async function load(path: string): Promise<HttpConnectionConfiguration> {
  const keys = ["absenceEndpoint", "adjudicators", "answerEndpoint", "capabilityEndpoint",
    "credentialPath", "deletionEndpoint", "holdoutAnswerEndpoint", "holdoutCapabilityEndpoint",
    "holdoutRetrievalEndpoint", "metricsEndpoint", "providerResultAuthority",
    "rawOutcomeEndpoint", "releaseObservationEndpoint", "retentionEndpoint",
    "retrievalEndpoint", "schemaVersion"];
  const record = exactRecord(JSON.parse(await readFile(absolute(path), "utf8")) as unknown,
    keys, "production connection configuration");
  if (record.schemaVersion !== "meeting_knowledge.semantic_quality_http_connections.v1" ||
    !Array.isArray(record.adjudicators) || record.adjudicators.length !== 3) {
    throw new Error("production connection configuration is invalid");
  }
  return record as unknown as HttpConnectionConfiguration;
}

function absolute(path: string): string {
  if (!isAbsolute(path) || path.includes("\0")) {throw new Error("production path must be absolute");}
  return resolve(path);
}
