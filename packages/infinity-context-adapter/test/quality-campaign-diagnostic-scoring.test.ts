import { describe, expect, it } from "vitest";
import type { HistoricalIndexPlanV1 } from "@discord-meeting/meeting-core/meeting-knowledge";
import { authenticateDiagnosticScoreV2,
  scoreDiagnostic } from "../src/quality-campaign/diagnostic-scoring.js";
import type { DiagnosticManifestV2 } from "../src/quality-campaign/diagnostic-manifest.js";
import { sha256 } from "../src/quality-campaign/canonical.js";
const fixture=()=>({
  questions:Array.from({length:40},(_,i)=>({questionId:`q${i}`,locale:"en" as const})),
  outcomes:Array.from({length:40},(_,i)=>({questionId:`q${i}`,status:"failed" as "failed"|"answered"|"outcome_unknown"|"abstained",retrievedLocators:[] as string[]})),
  plan:{documents:[{manifest:{candidateLocator:"b1",turnIds:["t1"]}},
    {manifest:{candidateLocator:"b2",turnIds:["t1","t2"]}},
    {manifest:{candidateLocator:"b3",turnIds:["t3"]}}]} as unknown as HistoricalIndexPlanV1,
  gold:Array.from({length:40},(_,i)=>({questionId:`q${i}`,expectedDisposition:"answerable" as "answerable"|"must_abstain",relevantTurnIds:["t1"]})),
});
describe("post-execution diagnostic retrieval scoring",()=> {
  it("scores real multi-block ground truth, exact MRR, and retains all failed/unknown denominators",()=> {
    const f=fixture(); f.outcomes[0]!.retrievedLocators=["b3","b1","b2"];f.outcomes[0]!.status="answered";
    f.outcomes[1]!.retrievedLocators=["b1"];f.outcomes[1]!.status="outcome_unknown";
    const s=scoreDiagnostic(f);
    expect(s.overall.microBlockRecallAt5).toEqual({numerator:3,denominator:80});
    expect(s.overall.completeQuestionRecallAt10).toEqual({numerator:1,denominator:40});
    expect(s.overall.mrrAt10).toEqual({numerator:3780,denominator:100800});
    expect(s.overall.counts).toEqual({answered:1,abstained:0,failed:38,unknown:1});
    expect(s.byLocale.ru.microBlockRecallAt10).toEqual({numerator:0,denominator:0});
    expect(s.factualAccuracy).toBe("UNMEASURED");expect(s.qualifying).toBe(false);
  });
  it("honors top-five and top-ten cutoffs",()=> {
    const f=fixture();
    f.plan={...f.plan,documents:[...f.plan.documents,...Array.from({length:10},(_,i)=>({
      manifest:{candidateLocator:`x${i}`,turnIds:[`extra${i}`]},
    }))]} as unknown as HistoricalIndexPlanV1;
    f.outcomes[0]!.retrievedLocators=[...Array.from({length:5},(_,i)=>`x${i}`),"b1","b2"];
    f.outcomes[1]!.retrievedLocators=[...Array.from({length:10},(_,i)=>`x${i}`),"b1","b2"];
    const s=scoreDiagnostic(f);
    expect(s.overall.microBlockRecallAt5.numerator).toBe(0);
    expect(s.overall.microBlockRecallAt10.numerator).toBe(2);
    expect(s.overall.completeQuestionRecallAt10.numerator).toBe(1);
    expect(s.overall.mrrAt10.numerator).toBe(420);
  });
  it("separates abstention behavior from retrieval and accuracy",()=> {
    const f=fixture();f.gold[0]!.expectedDisposition="must_abstain";f.gold[0]!.relevantTurnIds=[];
    f.outcomes[0]!.status="abstained";
    const s=scoreDiagnostic(f);
    expect(s.overall.abstentionRateOnMustAbstain).toEqual({numerator:1,denominator:1});
    expect(s.overall.completeQuestionRecallAt5.denominator).toBe(39);
    expect(s.overall.questionCount).toBe(40);
  });
  it("rejects foreign, missing, duplicate turns and extra gold fields",()=> {
    for(const turns of [["foreign"],[],["t1","t1"]]) {
      const f=fixture();f.gold[0]!.relevantTurnIds=turns;expect(()=>scoreDiagnostic(f)).toThrow();
    }
    const f=fixture();expect(()=>scoreDiagnostic({...f,gold:f.gold.map(g=>({...g,answer:"leak"}))})).toThrow();
  });
  it("requires exact unique question membership across all three inputs",()=> {
    for(const key of ["questions","outcomes","gold"] as const) {
      const missing=fixture();missing[key].pop();expect(()=>scoreDiagnostic(missing)).toThrow();
      const duplicate=fixture();duplicate[key][0]!.questionId="q1";expect(()=>scoreDiagnostic(duplicate)).toThrow();
      const foreign=fixture();foreign[key][0]!.questionId="foreign";expect(()=>scoreDiagnostic(foreign)).toThrow();
    }
  });
  it("rejects foreign and duplicate retrieved locators",()=> {
    for(const retrieved of [["foreign"],["b1","b1"]]) {
      const f=fixture();f.outcomes[0]!.retrievedLocators=retrieved;expect(()=>scoreDiagnostic(f)).toThrow();
    }
  });
  it("dispatches V2 scoring only for the same installed SDK, module and selected contracts",()=> {
    const f=fixture(), digest="a".repeat(64), revision="b".repeat(40);
    const sdk={packageName:"@infinity-context/sdk" as const,version:"0.3.1",
      sourceRevision:revision,tarballSha256:"c".repeat(64),manifestSha256:"d".repeat(64)};
    const manifest={schemaVersion:"meeting_knowledge.real40_diagnostic.v2",sourceRevision:revision,
      questions:f.questions,sdkIdentity:sdk,threadSelector:{mode:"any"},providerBinding:{contractVersion:"context-retrieval.v3"},
      frozen:{snapshotSha256:digest,transcriptSha256:"e".repeat(64)},rosterSha256:"f".repeat(64)} as unknown as DiagnosticManifestV2;
    const installed={...sdk,loadedEntrypointSha256:"1".repeat(64)};
    const report={schemaVersion:"meeting_knowledge.real40_diagnostic_report.v2",qualifying:false,
      rootBindingSha256:sha256({manifest,loadedModuleSha256:"3".repeat(64),
        loadedSdkSha256:installed.loadedEntrypointSha256}),declaredSourceRevision:revision,
      sourceRevisionAuthority:"owner_declared_unverified",loadedModuleSha256:"3".repeat(64),
      loadedSdkSha256:installed.loadedEntrypointSha256,snapshotSha256:digest,
      transcriptSha256:"e".repeat(64),rosterSha256:"f".repeat(64),planSha256:sha256(f.plan),
      questionDenominator:40,indexPreparation:{status:"ready"},counts:{answered:0,abstained:0,failed:40,unknown:0},
      factualAccuracy:"UNMEASURED",recall:"UNMEASURED_REQUIRES_SEPARATE_GOLD_MAPPING",
      questions:f.outcomes.map(outcome=>({questionId:outcome.questionId,status:outcome.status,
        retrievedCount:outcome.retrievedLocators.length})),
      executingModuleIdentity:{loadedModuleSha256:"3".repeat(64)},sdkIdentity:sdk,
      executingSdkIdentity:installed,
      selectedContracts:{manifest:manifest.schemaVersion,report:"meeting_knowledge.real40_diagnostic_report.v2",
        retrieval:"context-retrieval.v3",threadSelector:{mode:"any"}}};
    const authentication={manifest,report,installedSdkIdentity:installed,
      loadedModuleSha256:"3".repeat(64)};
    expect(authenticateDiagnosticScoreV2(authentication, f.plan, f.outcomes)).toMatchObject({
      loadedModuleSha256: "3".repeat(64), sdkIdentity: installed,
    });
    expect(() => authenticateDiagnosticScoreV2(authentication, f.plan,
      null as unknown as typeof f.outcomes)).toThrow("execution evidence is invalid");
    const score=scoreDiagnostic({...f,authentication});
    expect(score.schemaVersion).toBe("meeting_knowledge.real40_diagnostic_score.v2");
    expect("authenticatedExecution" in score && score.authenticatedExecution.sdkIdentity)
      .toEqual(installed);
    for(const changed of [
      {...authentication,installedSdkIdentity:{...installed,tarballSha256:"9".repeat(64)}},
      {...authentication,loadedModuleSha256:"8".repeat(64)},
      {...authentication,report:{...report,selectedContracts:{...report.selectedContracts,
        retrieval:"context-retrieval.v2"}}},
    ]) expect(()=>scoreDiagnostic({...f,authentication:changed})).toThrow();
  });
});
