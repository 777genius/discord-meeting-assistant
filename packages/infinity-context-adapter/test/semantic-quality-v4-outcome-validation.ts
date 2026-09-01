import type { V4EvaluationOutcome } from "./semantic-quality-v4-evaluation.js";
import { canonicalSha256 } from "./semantic-quality-v4-manifest.js";

export function validateV4OutcomeShape(value: unknown): V4EvaluationOutcome {
  const outcome = exactRecord(value, ["adjudicationKind", "adjudicationLatencyUs",
    "adjudications", "answer",
    "answerMeasurement", "citationEntailments", "evidenceBytes", "fullLatencyUs",
    "locallyRehydratedEvidence", "locale", "prompt",
    "promptBytes", "queryId", "questionDigestSha256", "retrieval"], "V4 outcome");
  if (typeof outcome.queryId !== "string" || outcome.queryId.trim() === "" ||
    typeof outcome.adjudicationLatencyUs !== "number" ||
    typeof outcome.evidenceBytes !== "number" || typeof outcome.promptBytes !== "number" ||
    typeof outcome.fullLatencyUs !== "number" || typeof outcome.prompt !== "string" ||
    !oneOf(outcome.locale, ["en", "mixed", "ru"]) ||
    typeof outcome.questionDigestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(outcome.questionDigestSha256) ||
    !oneOf(outcome.adjudicationKind, ["external_independent", "synthetic_structural_fixture"])) {
    throw new Error("V4 outcome has invalid scalar or adjudication kind");
  }
  if (!Array.isArray(outcome.locallyRehydratedEvidence) ||
    !Array.isArray(outcome.citationEntailments) || !Array.isArray(outcome.adjudications)) {
    throw new Error(`V4 outcome ${outcome.queryId} has invalid citation or adjudication arrays`);
  }
  validateLocalEvidence(outcome.locallyRehydratedEvidence, outcome.queryId);
  validateCitationEntailments(outcome.citationEntailments, outcome.queryId);
  validateAdjudications(outcome.adjudications, outcome.queryId);
  validateAnswer(outcome.answer, outcome.queryId);
  validateAnswerMeasurement(outcome.answerMeasurement, outcome.queryId);
  validateRetrieval(outcome.retrieval, outcome.queryId);
  return value as V4EvaluationOutcome;
}

function validateLocalEvidence(values: readonly unknown[], queryId: string): void {
  for (const candidate of values) {
    const item = exactRecord(candidate,
      ["endMs", "sourceLocatorId", "speakerId", "startMs", "text", "turnId"],
      `V4 outcome ${queryId} local evidence`);
    if (typeof item.endMs !== "number" || typeof item.startMs !== "number" ||
      typeof item.sourceLocatorId !== "string" || typeof item.speakerId !== "string" ||
      typeof item.text !== "string" ||
      typeof item.turnId !== "string") {
      throw new Error(`V4 outcome ${queryId} has malformed local evidence`);
    }
  }
}

function validateCitationEntailments(values: readonly unknown[], queryId: string): void {
  for (const candidate of values) {
    const item = exactRecord(candidate, ["claimId", "status", "turnId", "verdict"],
      `V4 outcome ${queryId} citation entailment`);
    if (typeof item.claimId !== "string" || typeof item.turnId !== "string" ||
      item.status !== "finalized" || !oneOf(item.verdict, ["does_not_entail", "entails"])) {
      throw new Error(`V4 outcome ${queryId} has malformed citation entailment`);
    }
  }
}

function validateAdjudications(values: readonly unknown[], queryId: string): void {
  for (const candidate of values) {
    const item = exactRecord(candidate,
      ["claimId", "factuality", "matchedGoldClaimId", "status", "verdict"],
      `V4 outcome ${queryId} adjudication`);
    if (typeof item.claimId !== "string" || item.claimId.trim() === "" ||
      !(item.matchedGoldClaimId === null || typeof item.matchedGoldClaimId === "string") ||
      !oneOf(item.factuality, ["factual", "nonfactual"]) || item.status !== "finalized" ||
      !oneOf(item.verdict, ["stale", "supported", "unsupported"])) {
      throw new Error(`V4 outcome ${queryId} has invalid final claim adjudication`);
    }
  }
}

function validateAnswer(value: unknown, queryId: string): void {
  const answer = exactRecord(value, ["claims", "status"], `V4 outcome ${queryId} answer`);
  if (!oneOf(answer.status, ["abstained", "answered", "failure", "timeout"]) ||
    !Array.isArray(answer.claims)) {
    throw new Error(`V4 outcome ${queryId} has invalid answer status or claims`);
  }
  for (const candidate of answer.claims) {
    const claim = exactRecord(candidate,
      ["citationRefs", "claimId", "claimPayloadSha256", "factual", "text"],
      `V4 outcome ${queryId} claim`);
    if (typeof claim.claimId !== "string" || claim.claimId.trim() === "" ||
      typeof claim.claimPayloadSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(claim.claimPayloadSha256) ||
      typeof claim.factual !== "boolean" || typeof claim.text !== "string" ||
      claim.text.trim() === "" || !Array.isArray(claim.citationRefs)) {
      throw new Error(`V4 outcome ${queryId} has malformed claim`);
    }
    validateCitations(claim.citationRefs, queryId);
  }
}

function validateCitations(values: readonly unknown[], queryId: string): void {
  for (const candidate of values) {
    const citation = exactRecord(candidate, ["endMs", "speakerId", "startMs", "turnId"],
      `V4 outcome ${queryId} citation`);
    if (typeof citation.endMs !== "number" || typeof citation.startMs !== "number" ||
      typeof citation.speakerId !== "string" || typeof citation.turnId !== "string") {
      throw new Error(`V4 outcome ${queryId} has malformed citation fields`);
    }
  }
}

function validateRetrieval(value: unknown, queryId: string): void {
  const retrieval = exactRecord(value, ["capabilityAndRetrievalLatencyUs", "capabilityBytes",
    "capabilitySha256", "expandedNeighborLocators", "latencyUs", "rankedSeedLocators",
    "requestBytes", "requestSha256", "requestSnapshotSha256", "responseBytes", "responseSha256",
    "routeLatencyUs", "status"],
  `V4 outcome ${queryId} retrieval`);
  const rankedSeedLocators = unknownArray(retrieval.rankedSeedLocators, queryId);
  const expandedNeighborLocators = unknownArray(retrieval.expandedNeighborLocators, queryId);
  if ([retrieval.capabilityAndRetrievalLatencyUs, retrieval.capabilityBytes,
    retrieval.latencyUs, retrieval.requestBytes, retrieval.responseBytes,
    retrieval.routeLatencyUs].some((item) => typeof item !== "number") ||
    [retrieval.capabilitySha256, retrieval.requestSha256, retrieval.requestSnapshotSha256,
      retrieval.responseSha256]
      .some((item) => typeof item !== "string" || !/^[a-f0-9]{64}$/u.test(item)) ||
    !oneOf(retrieval.status, ["completed", "failure", "timeout"])) {
    throw new Error(`V4 outcome ${queryId} has invalid retrieval status or fields`);
  }
  for (const candidate of [...rankedSeedLocators, ...expandedNeighborLocators]) {
    const locator = exactRecord(candidate, ["locatorId"], `V4 outcome ${queryId} ranked locator`);
    if (typeof locator.locatorId !== "string") {
      throw new Error(`V4 outcome ${queryId} has malformed ranked locator`);
    }
  }
}

function validateAnswerMeasurement(value: unknown, queryId: string): void {
  const measurement = exactRecord(value, ["answerLatencyUs", "attemptId", "originalInput",
    "originalModelInputSha256", "originalProviderRequestSha256",
    "originalProviderResponseSha256", "repairInput", "repairModelInputSha256",
    "repairProviderRequestSha256", "repairProviderResponseSha256", "responseBytes",
    "responseRuntimeArtifactSha256", "runtimeReceiptSha256"],
  `V4 outcome ${queryId} answer measurement`);
  if (typeof measurement.answerLatencyUs !== "number" ||
    typeof measurement.attemptId !== "string" || measurement.attemptId.trim() === "" ||
    typeof measurement.responseBytes !== "number" ||
    typeof measurement.runtimeReceiptSha256 !== "string" ||
    [measurement.runtimeReceiptSha256, measurement.originalModelInputSha256,
      measurement.originalProviderRequestSha256, measurement.originalProviderResponseSha256,
      measurement.repairModelInputSha256, measurement.responseRuntimeArtifactSha256]
      .some((digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) ||
    ((measurement.repairProviderRequestSha256 === null) !==
      (measurement.repairProviderResponseSha256 === null)) ||
    [measurement.repairProviderRequestSha256, measurement.repairProviderResponseSha256]
      .some((digest) => digest !== null &&
        (typeof digest !== "string" || !/^[a-f0-9]{64}$/u.test(digest)))) {
    throw new Error(`V4 outcome ${queryId} answer measurement is invalid`);
  }
  for (const inputSurface of [measurement.originalInput, measurement.repairInput]) {
    const surface = exactRecord(inputSurface, ["fullInputBytes", "outputSchemaBytes",
      "systemPromptBytes", "userPromptBytes"], `V4 outcome ${queryId} model input`);
    if (Object.values(surface).some((item) => typeof item !== "number")) {
      throw new Error(`V4 outcome ${queryId} model input is invalid`);
    }
  }
}

function unknownArray(value: unknown, queryId: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`V4 outcome ${queryId} has invalid retrieval locator arrays`);
  }
  return value as readonly unknown[];
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonicalSha256(Object.keys(value).toSorted()) !== canonicalSha256([...keys].toSorted())) {
    throw new Error(`${label} has an invalid object shape`);
  }
  return Object.fromEntries(Object.entries(value));
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.some((candidate) => candidate === value);
}
