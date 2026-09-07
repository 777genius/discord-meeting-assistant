import type { HistoricalIndexPlanV1 } from "@discord-meeting/meeting-core/meeting-knowledge";
import { exactRecord, safeId } from "./canonical.js";

type Locale = "en" | "ru" | "mixed";
type Status = "answered" | "abstained" | "failed" | "outcome_unknown";
interface Question { readonly questionId:string; readonly locale:Locale }
interface Outcome { readonly questionId:string; readonly status:Status; readonly retrievedLocators:readonly string[] }
interface Gold { readonly questionId:string; readonly expectedDisposition:"answerable"|"must_abstain"; readonly relevantTurnIds:readonly string[] }
// Fractions remain exact and compatible with the integer-only canonical artifact encoder.
const ratio = (numerator:number, denominator:number) => ({numerator,denominator});

/** Post-execution only: inputs must come from the sealed run and its retained frozen plan. */
export function scoreDiagnostic(input:{readonly questions:readonly Question[];
  readonly outcomes:readonly Outcome[];readonly plan:HistoricalIndexPlanV1;readonly gold:unknown}) {
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
  return {schemaVersion:"meeting_knowledge.real40_diagnostic_score.v1",qualifying:false,
    definitions:{ratios:"numerator / denominator; denominator zero means unmeasured",
      retrieval:"Answerable questions only; failed and unknown remain in denominators; retained retrieval is scored even when answer failed",
      targets:"Union of all frozen production block locators containing any relevant turn",
      mrrAt10:"Mean reciprocal rank of first relevant block within top 10, zero when absent; not evidence completeness",
      completeQuestionRecall:"Fraction of answerable questions with every target block retrieved within cutoff"},
    factualAccuracy:"UNMEASURED",factPrecision:"UNMEASURED",entailment:"UNMEASURED",
    citationValidityIsFactualAccuracy:false,overall:aggregate(rows),
    byLocale:{ru:aggregate(rows.filter(r=>r.locale==="ru")),en:aggregate(rows.filter(r=>r.locale==="en")),
      mixed:aggregate(rows.filter(r=>r.locale==="mixed"))},questions:rows};
}
