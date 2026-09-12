import type { HistoricalIndexPlanV1 } from "@discord-meeting/meeting-core/meeting-knowledge";
import type { DiagnosticManifestV2, DiagnosticSdkIdentity } from "./diagnostic-manifest.js";
import { canonicalJson, exactRecord, safeId, sha256 } from "./canonical.js";

type Locale = "en" | "ru" | "mixed";
type Status = "answered" | "abstained" | "failed" | "outcome_unknown";
interface Question { readonly questionId:string; readonly locale:Locale }
interface Outcome { readonly questionId:string; readonly status:Status; readonly retrievedLocators:readonly string[] }
interface Gold { readonly questionId:string; readonly expectedDisposition:"answerable"|"must_abstain"; readonly relevantTurnIds:readonly string[] }
export interface DiagnosticScoreV2Authentication {
  readonly manifest: DiagnosticManifestV2;
  readonly report: unknown;
  readonly installedSdkIdentity: Readonly<DiagnosticSdkIdentity & {
    readonly loadedEntrypointSha256: string;
  }>;
  readonly loadedModuleSha256: string;
}
export interface AuthenticatedDiagnosticScoreV2Execution {
  readonly loadedModuleSha256: string;
  readonly sdkIdentity: DiagnosticScoreV2Authentication["installedSdkIdentity"];
  readonly selectedContracts: Readonly<Record<string, unknown>>;
}
// Fractions remain exact and compatible with the integer-only canonical artifact encoder.
const ratio = (numerator:number, denominator:number) => ({numerator,denominator});

/** Post-execution only: inputs must come from the sealed run and its retained frozen plan. */
export function scoreDiagnostic(input:{readonly questions:readonly Question[];
  readonly outcomes:readonly Outcome[];readonly plan:HistoricalIndexPlanV1;readonly gold:unknown;
  readonly authentication?: DiagnosticScoreV2Authentication}) {
  const authenticatedV2 = input.authentication === undefined ? null
    : authenticateDiagnosticScoreV2(input.authentication, input.plan, input.outcomes);
  const ids=new Set(input.questions.map(q=>safeId(q.questionId,"question")));
  if(input.questions.length!==40 || ids.size!==40 || input.questions.some(q=>
    !["en","ru","mixed"].includes(q.locale))) {throw new Error("invalid forty-question membership");}
  const membership=(items:readonly {readonly questionId:string}[])=> {
    if(items.length!==40 || new Set(items.map(i=>i.questionId)).size!==40 ||
      items.some(i=>!ids.has(i.questionId))) {throw new Error("foreign or duplicate question membership");}
  };
  membership(input.outcomes);
  const byTurn=new Map<string,Set<string>>(), locators=new Set<string>();
  for(const {manifest} of input.plan.documents) {
    if(locators.has(manifest.candidateLocator)) {throw new Error("duplicate plan locator");}
    locators.add(manifest.candidateLocator);
    for(const turn of manifest.turnIds) {
      const mapped=byTurn.get(turn)??new Set<string>(); mapped.add(manifest.candidateLocator);byTurn.set(turn,mapped);
    }
  }
  if(!Array.isArray(input.gold)) {throw new Error("gold must be an array");}
  const gold:Gold[]=input.gold.map(item=> {
    const g=exactRecord(item,["questionId","expectedDisposition","relevantTurnIds"],"diagnostic gold");
    if(!["answerable","must_abstain"].includes(String(g.expectedDisposition)) ||
      !Array.isArray(g.relevantTurnIds) || g.relevantTurnIds.some(t=>typeof t!=="string" || !byTurn.has(t)) ||
      new Set(g.relevantTurnIds).size!==g.relevantTurnIds.length ||
      (g.expectedDisposition==="answerable" ? g.relevantTurnIds.length===0 : g.relevantTurnIds.length!==0)) {
      throw new Error("invalid or foreign gold turns");
    }
    return {questionId:safeId(g.questionId,"gold question"),expectedDisposition:g.expectedDisposition as Gold["expectedDisposition"],
      relevantTurnIds:g.relevantTurnIds as string[]};
  });
  membership(gold);
  for(const o of input.outcomes) {
    if(!["answered","abstained","failed","outcome_unknown"].includes(o.status) ||
      !Array.isArray(o.retrievedLocators) || new Set(o.retrievedLocators).size!==o.retrievedLocators.length ||
      o.retrievedLocators.some(l=>typeof l!=="string" || !locators.has(l))) {throw new Error("invalid diagnostic outcome");}
  }
  const rows=input.questions.map(q=> {
    const g=gold.find(item=>item.questionId===q.questionId)!, o=input.outcomes.find(item=>item.questionId===q.questionId)!;
    // A turn spanning multiple production blocks contributes every real block, never a fabricated single target.
    const targets=new Set(g.relevantTurnIds.flatMap(t=>[...byTurn.get(t)!]));
    const hits=(k:number)=>o.retrievedLocators.slice(0,k).filter(l=>targets.has(l)).length;
    const rank=o.retrievedLocators.slice(0,10).findIndex(l=>targets.has(l))+1;
    return {...q,status:o.status,expectedDisposition:g.expectedDisposition,targetCount:targets.size,
      hits5:hits(5),hits10:hits(10),firstRelevantRank10:rank||null};
  });
  const aggregate=(selected:typeof rows)=> {
    const answerable=selected.filter(r=>r.expectedDisposition==="answerable");
    const abstain=selected.filter(r=>r.expectedDisposition==="must_abstain");
    const blocks=answerable.reduce((n,r)=>n+r.targetCount,0);
    const count=(status:Status)=>selected.filter(r=>r.status===status).length;
    return {questionCount:selected.length,answerableCount:answerable.length,mustAbstainCount:abstain.length,
      counts:{answered:count("answered"),abstained:count("abstained"),failed:count("failed"),unknown:count("outcome_unknown")},
      microBlockRecallAt5:ratio(answerable.reduce((n,r)=>n+r.hits5,0),blocks),
      microBlockRecallAt10:ratio(answerable.reduce((n,r)=>n+r.hits10,0),blocks),
      completeQuestionRecallAt5:ratio(answerable.filter(r=>r.hits5===r.targetCount).length,answerable.length),
      completeQuestionRecallAt10:ratio(answerable.filter(r=>r.hits10===r.targetCount).length,answerable.length),
      mrrAt10:ratio(answerable.reduce((n,r)=>n+(r.firstRelevantRank10===null?0:2520/r.firstRelevantRank10),0),2520*answerable.length),
      answerRateOnAnswerable:ratio(answerable.filter(r=>r.status==="answered").length,answerable.length),
      abstentionRateOnMustAbstain:ratio(abstain.filter(r=>r.status==="abstained").length,abstain.length)};
  };
  const common = {qualifying:false,
    definitions:{ratios:"numerator / denominator; denominator zero means unmeasured",
      retrieval:"Answerable questions only; failed and unknown remain in denominators; retained retrieval is scored even when answer failed",
      targets:"Union of all frozen production block locators containing any relevant turn",
      mrrAt10:"Mean reciprocal rank of first relevant block within top 10, zero when absent; not evidence completeness",
      completeQuestionRecall:"Fraction of answerable questions with every target block retrieved within cutoff"},
    factualAccuracy:"UNMEASURED",factPrecision:"UNMEASURED",entailment:"UNMEASURED",
    citationValidityIsFactualAccuracy:false,overall:aggregate(rows),
    byLocale:{ru:aggregate(rows.filter(r=>r.locale==="ru")),en:aggregate(rows.filter(r=>r.locale==="en")),
      mixed:aggregate(rows.filter(r=>r.locale==="mixed"))},questions:rows};
  return authenticatedV2 === null
    ? {schemaVersion:"meeting_knowledge.real40_diagnostic_score.v1",...common}
    : {schemaVersion:"meeting_knowledge.real40_diagnostic_score.v2",...common,
        authenticatedExecution: authenticatedV2};
}

/** Authenticate a sealed V2 execution without inspecting or requiring retrieval gold. */
export function authenticateDiagnosticScoreV2(input: DiagnosticScoreV2Authentication,
  plan: HistoricalIndexPlanV1, outcomes: readonly Outcome[]): AuthenticatedDiagnosticScoreV2Execution {
  if (!Array.isArray(outcomes) || !Array.isArray(plan.documents)) {
    throw new Error("diagnostic V2 score execution evidence is invalid");
  }
  const manifestQuestionIds = new Set(input.manifest.questions.map(question => question.questionId));
  const outcomeIds = new Set(outcomes.map(outcome => outcome.questionId));
  const planLocators = new Set(plan.documents.map(document => document.manifest.candidateLocator));
  if (input.manifest.questions.length !== 40 || manifestQuestionIds.size !== 40 ||
    outcomes.length !== 40 || outcomeIds.size !== 40 ||
    outcomes.some(outcome => !manifestQuestionIds.has(outcome.questionId) ||
      !["answered", "abstained", "failed", "outcome_unknown"].includes(outcome.status) ||
      !Array.isArray(outcome.retrievedLocators) ||
      new Set(outcome.retrievedLocators).size !== outcome.retrievedLocators.length ||
      outcome.retrievedLocators.some((locator: unknown) =>
        typeof locator !== "string" || !planLocators.has(locator)))) {
    throw new Error("diagnostic V2 score outcomes are invalid");
  }
  const report = exactRecord(input.report, ["schemaVersion", "qualifying", "rootBindingSha256",
    "declaredSourceRevision", "sourceRevisionAuthority", "loadedModuleSha256", "loadedSdkSha256",
    "snapshotSha256", "transcriptSha256", "rosterSha256", "planSha256",
    "questionDenominator", "indexPreparation", "counts", "factualAccuracy", "recall",
    "questions", "executingModuleIdentity", "sdkIdentity", "executingSdkIdentity",
    "selectedContracts"],
  "diagnostic report v2");
  const selected = exactRecord(report.selectedContracts,
    ["manifest", "report", "retrieval", "threadSelector"], "diagnostic selected contracts");
  const moduleIdentity = exactRecord(report.executingModuleIdentity,
    ["loadedModuleSha256"], "diagnostic executing module");
  const installed = input.installedSdkIdentity;
  const expectedSdk = input.manifest.sdkIdentity;
  const expectedRoot = sha256({ manifest: input.manifest,
    loadedModuleSha256: input.loadedModuleSha256,
    loadedSdkSha256: installed.loadedEntrypointSha256 });
  const expectedCounts = { answered: outcomes.filter(({ status }) => status === "answered").length,
    abstained: outcomes.filter(({ status }) => status === "abstained").length,
    failed: outcomes.filter(({ status }) => status === "failed").length,
    unknown: outcomes.filter(({ status }) => status === "outcome_unknown").length };
  const reportQuestions = Array.isArray(report.questions) ? report.questions : [];
  const reportByQuestion = new Map(reportQuestions.map(value => {
    const row = value as { questionId?: unknown; status?: unknown; retrievedCount?: unknown };
    return [row.questionId, row];
  }));
  const observedSdk = { packageName: installed.packageName, version: installed.version,
    sourceRevision: installed.sourceRevision, tarballSha256: installed.tarballSha256,
    manifestSha256: installed.manifestSha256 };
  if (report.schemaVersion !== "meeting_knowledge.real40_diagnostic_report.v2" ||
    report.qualifying !== false || report.questionDenominator !== 40 ||
    report.rootBindingSha256 !== expectedRoot || report.planSha256 !== sha256(plan) ||
    report.sourceRevisionAuthority !== "owner_declared_unverified" ||
    report.factualAccuracy !== "UNMEASURED" ||
    report.recall !== "UNMEASURED_REQUIRES_SEPARATE_GOLD_MAPPING" ||
    canonicalJson(report.counts) !== canonicalJson(expectedCounts) ||
    (report.indexPreparation as { status?: unknown } | null)?.status !== "ready" ||
    reportQuestions.length !== 40 || reportByQuestion.size !== 40 ||
    outcomes.some(outcome => { const row = reportByQuestion.get(outcome.questionId);
      return row?.status !== outcome.status || row?.retrievedCount !== outcome.retrievedLocators.length; }) ||
    report.declaredSourceRevision !== input.manifest.sourceRevision ||
    report.snapshotSha256 !== input.manifest.frozen.snapshotSha256 ||
    report.transcriptSha256 !== input.manifest.frozen.transcriptSha256 ||
    report.rosterSha256 !== input.manifest.rosterSha256 ||
    report.loadedModuleSha256 !== input.loadedModuleSha256 ||
    moduleIdentity.loadedModuleSha256 !== input.loadedModuleSha256 ||
    report.loadedSdkSha256 !== installed.loadedEntrypointSha256 ||
    canonicalJson(report.sdkIdentity) !== canonicalJson(expectedSdk) ||
    canonicalJson(report.executingSdkIdentity) !== canonicalJson(installed) ||
    canonicalJson(observedSdk) !== canonicalJson(expectedSdk) ||
    selected.manifest !== input.manifest.schemaVersion ||
    selected.report !== report.schemaVersion ||
    selected.retrieval !== input.manifest.providerBinding.contractVersion ||
    canonicalJson(selected.threadSelector) !== canonicalJson(input.manifest.threadSelector)) {
    throw new Error("diagnostic V2 score installation or execution evidence differs");
  }
  return Object.freeze({ loadedModuleSha256: input.loadedModuleSha256,
    sdkIdentity: Object.freeze({ ...installed }), selectedContracts: Object.freeze({ ...selected }) });
}
