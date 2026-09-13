import { readFileSync } from "node:fs";

import { runSemanticQualityV4 } from "../src/semantic-quality-v4-runner.js";
import { frozenSemanticQualityCorpusV4, v4EvaluationQuestionText } from
  "./semantic-quality-v4-corpus.js";
import { evaluateSemanticQualityV4, evaluateV4Thresholds } from
  "./semantic-quality-v4-evaluation.js";
import {
  createSemanticQualityV4Manifest,
  evaluateV4QualificationReadiness,
} from "./semantic-quality-v4-manifest.js";
import { perfectOutcomesForP0Test } from "./semantic-quality-v4-test-fixtures.js";
import { verifySemanticQualityV4ReleaseTrustAnchor } from
  "./semantic-quality-v4-trusted-receipts.js";
import { runSemanticQualityV4WorkflowResumeCommand } from
  "./semantic-quality-v4-workflow-command.js";

if (process.argv.includes("--real-execute")) {
  throw new Error("real execution moved to the installed quality-campaign execute command");
} else if (process.argv.includes("--real-run")) {
  throw new Error("semantic quality V4 real-run was replaced by explicit execute/resume phases");
} else if (process.argv.includes("--real-adjudicate")) {
  await runResume("adjudicate");
} else if (process.argv.includes("--real-retention")) {
  await runResume("retention");
} else if (process.argv.includes("--real-cleanup")) {
  await runResume("cleanup");
} else if (process.argv.includes("--real-status")) {
  await runResume("status");
} else if (process.argv.some((argument) => argument.startsWith("--real-"))) {
  throw new Error("unsupported legacy real command; use the installed quality-campaign runner");
} else {
  await runProviderFreeStructuralGate();
}

async function runResume(command: "adjudicate" | "cleanup" | "retention" | "status") {
  const result = await runSemanticQualityV4WorkflowResumeCommand({ command,
    ...(command === "status" ? {} : { phaseInputPath:
      requiredPath("SEMANTIC_QUALITY_V4_PHASE_INPUT_PATH") }),
    pinnedKeys: verifySemanticQualityV4ReleaseTrustAnchor(readInjectedJson(
      requiredPath("SEMANTIC_QUALITY_V4_TRUST_ANCHOR_PATH")),
    readExternalReleaseRoot()).reviewerKeys,
    workflowRoot: requiredPath("SEMANTIC_QUALITY_V4_WORKFLOW_ROOT") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "paused") {process.exitCode = 20;}
  else if (result.status === "unqualified") {process.exitCode = 1;}
}

async function runProviderFreeStructuralGate(): Promise<void> {

const corpus = frozenSemanticQualityCorpusV4();
const fixtures = perfectOutcomesForP0Test(corpus);
const fixtureById = new Map(fixtures.map((outcome) => [outcome.queryId, outcome]));
const requiredFixture = (queryId: string) => {
  const outcome = fixtureById.get(queryId);
  if (outcome === undefined) {throw new Error(`missing provider-free V4 fixture ${queryId}`);}
  return outcome;
};
const questions = [...corpus.automatedQuestions, ...corpus.humanReviewQuestions].map((question) =>
  ({ id: question.id, locale: question.locale, question: v4EvaluationQuestionText(question) }));

const outcomes = await runSemanticQualityV4({
  adjudication: { adjudicate: async ({ queryId }) => {
    const outcome = requiredFixture(queryId);
    return { adjudications: outcome.adjudications,
      citationEntailments: outcome.citationEntailments, kind: outcome.adjudicationKind };
  } },
  answer: { answer: async ({ queryId }) => {
    const outcome = requiredFixture(queryId);
    return { ...outcome.answer, measurement: outcome.answerMeasurement,
      prompt: outcome.prompt };
  } },
  evidence: { rehydrate: async ({ queryId }) => {
    const outcome = requiredFixture(queryId);
    return { turns: outcome.locallyRehydratedEvidence };
  } },
  canonicalQuestions: questions,
  questions,
  retrieval: { retrieve: async ({ queryId }) => requiredFixture(queryId).retrieval },
});

const metrics = evaluateSemanticQualityV4({ outcomes });
const thresholds = evaluateV4Thresholds(metrics);
const manifest = createSemanticQualityV4Manifest(corpus);
const negativeKindCounts = Object.fromEntries(
  [...Map.groupBy(corpus.fixtureComponents.factFamilyNegatives,
    ({ negativeKind }) => negativeKind)]
    .map(([kind, negatives]) => [kind, negatives.length] as const)
    .toSorted(([left], [right]) => left.localeCompare(right)),
);
const qualification = evaluateV4QualificationReadiness({
  independentQuestionReviewReceiptDigests: [], runs: [],
});
process.stdout.write(`${JSON.stringify({ outcomeCount: outcomes.length, providerFree: true,
  corpus: {
    automatedQuestionCount: corpus.automatedQuestions.length,
    factFamilyCount: new Set(corpus.fixtureComponents.factFamilyNegatives.map(
      ({ factFamilyId }) => factFamilyId,
    )).size,
    factFamilyNegativeCount: corpus.fixtureComponents.factFamilyNegatives.length,
    humanReviewCandidateCount: corpus.humanReviewQuestions.length,
    negativeKindCounts,
  },
  digests: {
    automatedQuestionSetSha256: manifest.questionSets.automated.questionSetSha256,
    corpusSha256: manifest.corpus.corpusSha256,
    factFamilyNegativesSha256: manifest.components.factFamilyNegativesSha256,
    humanQuestionSetSha256: manifest.questionSets.humanReviewCandidates.questionSetSha256,
    manifestSha256: manifest.manifestSha256,
    thresholdProfileSha256: manifest.evaluation.thresholdProfileSha256,
  },
  qualification, structuralThresholds: thresholds }, null, 2)}\n`);
if (!thresholds.passed || outcomes.length !== 240) {
  process.exitCode = 1;
}
}

function requiredPath(name: string): string {
  const value = process.env[name];
  if (value === undefined || !value.startsWith("/") || value.includes("\0")) {
    throw new Error("semantic quality V4 required path injection is absent");
  }
  return value;
}

function readInjectedJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("semantic quality V4 injected control JSON is invalid");
  }
}

function readExternalReleaseRoot(): string {
  const raw = process.env.SEMANTIC_QUALITY_V4_RELEASE_ROOT_FD;
  if (raw === undefined || !/^\d+$/u.test(raw)) {
    throw new Error("semantic quality V4 release root must arrive on an inherited descriptor");
  }
  const descriptor = Number(raw);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3 || descriptor > 1_024) {
    throw new Error("semantic quality V4 release root descriptor is invalid");
  }
  return readFileSync(descriptor, "utf8");
}
