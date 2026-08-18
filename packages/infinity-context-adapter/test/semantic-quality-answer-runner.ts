import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import type { FrozenSemanticQualityCorpus } from "./semantic-quality-corpus.js";
import type { QualityRawOutcome, QualityRunBinding } from "./semantic-quality-evaluation.js";
import type { SemanticQualityRetrievalRun } from "./semantic-quality-retrieval-helper.js";

const maximumResponseBytes = 1_000_000;
const maximumClaimTextBytes = 2_048;

export interface ImmutableBuildProvenance {
  readonly releaseRevision: string;
  readonly releaseTree: string;
}

export interface SubscriptionAnswerReceipt {
  readonly answers: readonly {
    readonly claims: readonly { readonly citedTurnIds: readonly string[]; readonly text: string }[];
    readonly measurement: QualityRawOutcome["measurement"];
    readonly queryId: string;
    readonly status: "abstained" | "answered";
  }[];
  readonly attestation: {
    readonly authKind: "subscription_session";
    readonly modelConfigurationSha256: string;
    readonly modelContextTokens: number;
    readonly modelId: string;
    readonly modelRevision: string;
    readonly runnerRevision: string;
    readonly tokenizerDigestSha256: `sha256:${string}`;
    readonly tokenizerId: string;
  };
  readonly requestSha256: string;
  readonly schemaVersion: "meeting_knowledge.subscription_answer_receipt.v1";
}

export interface SubscriptionAnswerTransport {
  execute(input: {
    readonly requests: readonly {
      readonly evidence: readonly { readonly text: string; readonly turnId: string }[];
      readonly queryId: string;
      readonly question: string;
    }[];
    readonly schemaVersion: "meeting_knowledge.subscription_answer_batch.v1";
  }): Promise<SubscriptionAnswerReceipt>;
}

export function immutableCheckoutProvenance(repositoryRoot: string): ImmutableBuildProvenance {
  const status = git(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"]);
  if (status !== "") {throw new Error("semantic quality requires a clean immutable checkout");}
  return Object.freeze({
    releaseRevision: revision(git(repositoryRoot, ["rev-parse", "HEAD"]), "release revision"),
    releaseTree: revision(git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]), "release tree"),
  });
}

export async function runAuthenticatedAnswerEvaluation(input: {
  readonly build: ImmutableBuildProvenance;
  readonly corpus: FrozenSemanticQualityCorpus;
  readonly observedAt: string;
  readonly repetition: number;
  readonly retrieval: SemanticQualityRetrievalRun;
  readonly runId: string;
  readonly transport: SubscriptionAnswerTransport;
}): Promise<{ readonly binding: QualityRunBinding; readonly outcomes: readonly QualityRawOutcome[] }> {
  if (input.retrieval.corpusSha256 !== input.corpus.corpusSha256 ||
    input.retrieval.outcomes.length !== input.corpus.questions.length ||
    !input.retrieval.remoteCleanupVerified) {
    throw new Error("answer run requires exact corpus-bound retrieval with verified cleanup");
  }
  const requests = input.corpus.questions.map((question) => {
    const retrieval = input.retrieval.outcomes.find(({ queryId }) => queryId === question.id);
    if (retrieval?.status !== "ready" || retrieval.answerRequest === null) {
      throw new Error(`answer run requires ready bounded evidence for ${question.id}`);
    }
    return Object.freeze({ evidence: retrieval.answerRequest.evidence, queryId: question.id,
      question: question.question });
  });
  const batch = Object.freeze({ requests: Object.freeze(requests),
    schemaVersion: "meeting_knowledge.subscription_answer_batch.v1" as const });
  for (const request of requests) {
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > 16_000) {
      throw new Error("subscription answer request exceeded its evidence budget");
    }
  }
  if (Buffer.byteLength(JSON.stringify(batch), "utf8") > 4_000_000) {
    throw new Error("subscription answer batch exceeded its total budget");
  }
  const requestSha256 = sha256(JSON.stringify(batch));
  const receipt = await input.transport.execute(batch);
  validateReceipt(receipt, requestSha256, input.corpus, requests);
  const byQuery = new Map(receipt.answers.map((answer) => [answer.queryId, answer]));
  const outcomes = input.corpus.questions.map((question): QualityRawOutcome => {
    const retrieval = input.retrieval.outcomes.find(({ queryId }) => queryId === question.id);
    const answer = byQuery.get(question.id);
    if (retrieval === undefined || answer === undefined) {throw new Error("answer receipt is incomplete");}
    const allowedCitationIds = new Set(retrieval.answerRequest?.evidence.map(({ turnId }) => turnId));
    if (answer.claims.some(({ citedTurnIds }) =>
      citedTurnIds.some((turnId) => !allowedCitationIds.has(turnId)))) {
      throw new Error("answer cited evidence outside its bounded request");
    }
    return Object.freeze({
      adjudication: Object.freeze({
        claims: Object.freeze(answer.claims.map(() => Object.freeze({ citationValid: false,
          matchedGoldClaimId: null, verdict: "pending" as const }))),
        status: "pending" as const,
      }),
      answer: Object.freeze({ claims: Object.freeze(answer.claims.map((claim) => Object.freeze({
        citedTurnIds: Object.freeze([...claim.citedTurnIds]), text: claim.text }))), status: answer.status }),
      measurement: Object.freeze({ ...answer.measurement }), queryId: question.id,
      retrieval: Object.freeze({ candidateBlockCountAt5: retrieval.candidateBlockCountAt5,
        localRehydrationVerified: retrieval.localRehydrationVerified,
        providerPayloadWasReferenceOnly: retrieval.providerPayloadWasReferenceOnly,
        rehydratedTurnIds: retrieval.rehydratedTurnIds, topFiveTurnIds: retrieval.topFiveTurnIds,
        wholeTranscriptIncluded: retrieval.wholeTranscriptIncluded }),
    });
  });
  return Object.freeze({
    binding: Object.freeze({
      corpusSha256: input.corpus.corpusSha256,
      embeddingProfileDigestSha256: input.retrieval.service.embeddingProfileDigestSha256,
      embeddingProfileId: input.retrieval.service.embeddingProfileId,
      modelConfigurationSha256: receipt.attestation.modelConfigurationSha256,
      modelContextTokens: receipt.attestation.modelContextTokens, modelId: receipt.attestation.modelId,
      modelRevision: receipt.attestation.modelRevision, observedAt: input.observedAt,
      questionSetSha256: input.corpus.questionSetSha256, releaseRevision: input.build.releaseRevision,
      releaseTree: input.build.releaseTree, repetition: input.repetition, runId: input.runId,
      serviceApiVersion: input.retrieval.service.apiVersion, serviceName: input.retrieval.service.name,
      serviceRevision: input.retrieval.service.revision, tokenizerId: receipt.attestation.tokenizerId,
      tokenizerDigestSha256: receipt.attestation.tokenizerDigestSha256,
    }),
    outcomes: Object.freeze(outcomes),
  });
}

function validateReceipt(receipt: SubscriptionAnswerReceipt, expectedDigest: string,
  corpus: FrozenSemanticQualityCorpus, requests: readonly {
    readonly evidence: readonly { readonly text: string; readonly turnId: string }[];
    readonly queryId: string;
    readonly question: string;
  }[]): void {
  if (receipt.schemaVersion !== "meeting_knowledge.subscription_answer_receipt.v1" ||
    receipt.attestation.authKind !== "subscription_session" || receipt.requestSha256 !== expectedDigest ||
    receipt.answers.length !== corpus.questions.length ||
    Buffer.byteLength(JSON.stringify(receipt), "utf8") > maximumResponseBytes) {
    throw new Error("subscription answer receipt is incomplete, unbound, or oversized");
  }
  const expectedIds = new Set(corpus.questions.map(({ id }) => id));
  const requestById = new Map(requests.map((request) => [request.queryId, request]));
  const seen = new Set<string>();
  for (const answer of receipt.answers) {
    const request = requestById.get(answer.queryId);
    if (!expectedIds.has(answer.queryId) || seen.has(answer.queryId) ||
      request === undefined || answer.claims.length > 8 ||
      (answer.status === "abstained" && answer.claims.length !== 0) ||
      answer.measurement.requestSha256 !== sha256(JSON.stringify(request)) ||
      answer.measurement.requestBytes !== Buffer.byteLength(JSON.stringify(request), "utf8") ||
      Object.values(answer.measurement).some((value) => typeof value === "number" &&
        (!Number.isFinite(value) || value < 0))) {
      throw new Error("subscription answer receipt has unknown, duplicate, or excessive claims");
    }
    seen.add(answer.queryId);
    for (const claim of answer.claims) {
      if (claim.text.trim() === "" || Buffer.byteLength(claim.text, "utf8") > maximumClaimTextBytes ||
        new Set(claim.citedTurnIds).size !== claim.citedTurnIds.length) {
        throw new Error("subscription answer claim is invalid or oversized");
      }
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(receipt.attestation.runnerRevision) ||
    !/^[a-f0-9]{64}$/u.test(receipt.attestation.modelConfigurationSha256) ||
    !/^sha256:[a-f0-9]{64}$/u.test(receipt.attestation.tokenizerDigestSha256) ||
    !Number.isSafeInteger(receipt.attestation.modelContextTokens) ||
    receipt.attestation.modelContextTokens < 1) {
    throw new Error("subscription answer attestation is invalid");
  }
}

function git(repositoryRoot: string, arguments_: readonly string[]): string {
  return execFileSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function revision(value: string, field: string): string {
  if (!/^[a-f0-9]{40}$/u.test(value)) {throw new Error(`${field} must be an exact git object`);}
  return value;
}
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
