import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeDiagnosticManifest, decodeDiagnosticQuestions } from "../src/quality-campaign/diagnostic-manifest.js";
import { resolveDiagnosticReportPath, runDiagnosticCli, runDiagnosticSchedule } from "../src/quality-campaign/diagnostic-run.js";
import { sha256 } from "../src/quality-campaign/canonical.js";
import { DiagnosticCustody } from "../src/quality-campaign/diagnostic-custody.js";

const questions = Array.from({ length: 40 }, (_, i) => ({
  locale: "en", questionId: `q${i}`, questionText: "What was decided?",
  scopeTopologyReference: "diagnostic:scope",
}));
describe("nonqualifying diagnostic custody", () => {
  it("freezes forty gold-free questions without reviewer assertions", () => {
    expect(decodeDiagnosticQuestions(questions)).toHaveLength(40);
    expect(() => decodeDiagnosticQuestions(questions.slice(1))).toThrow();
    expect(() => decodeDiagnosticQuestions(questions.map(q => ({...q, expectedAnswer:"gold"}))))
      .toThrow();
    expect(() => decodeDiagnosticQuestions(questions.map(q => ({...q, source:"independent_review"}))))
      .toThrow();
  });
  it.each(["original", "repair"])("keeps forty outcomes and never repeats after %s crash", async ordinal => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-schedule-"));
    try {
      const custody = new DiagnosticCustody(root, Buffer.alloc(32, 1), "a".repeat(64));
      const packets = decodeDiagnosticQuestions(questions.map((q, i) =>
        i === 0 ? {...q, questionId:"q".repeat(128)} : q));
      await expect(runDiagnosticSchedule(custody, packets, async () => {
        await custody.reserve(ordinal, {runId:ordinal});
        throw new Error("simulated crash after durable provider reservation");
      })).rejects.toThrow();
      let calls = 0;
      const outcomes = await runDiagnosticSchedule(custody, packets, async () => {
        calls += 1;
        throw new Error("must not replay");
      });
      expect(calls).toBe(0);
      expect(outcomes).toHaveLength(40);
      expect(outcomes[0]?.status).toBe("outcome_unknown");
      expect(outcomes.slice(1).every(outcome => outcome.status === "failed")).toBe(true);
      const replay = await runDiagnosticSchedule(custody, packets, async () => {
        throw new Error("must not replay");
      });
      expect(replay).toEqual(outcomes);
    } finally {await rm(root, {recursive:true, force:true});}
  });
  it("never repeats an original or repair reservation after a crash", async () => {
    const root = await mkdtemp(join(tmpdir(), "diagnostic-custody-"));
    try {
      const binding = "a".repeat(64);
      for (const ordinal of ["original", "repair"]) {
        const first = new DiagnosticCustody(root, Buffer.alloc(32, 1), binding);
        await first.reserve(`q0-${ordinal}`, {ordinal, runId:ordinal});
        const reopened = new DiagnosticCustody(root, Buffer.alloc(32, 1), binding);
        await expect(reopened.reserve(`q0-${ordinal}`, {ordinal, runId:ordinal})).rejects.toThrow();
      }
    } finally { await rm(root, {recursive:true, force:true}); }
  });
});

function manifestFixture(artifactRoot: string) {
  const roster = {humans:["human"], automation:["bot"]};
  return {
    schemaVersion:"meeting_knowledge.real40_diagnostic.v1",
    authorityKind:"owner_authorized_nonqualifying_diagnostic",
    runId:"diagnostic:test", sourceRevision:"a".repeat(40), sdkVersion:"0.2.4",
    model:"gpt-5.6-terra", reasoningEffort:"low", serviceTier:"default",
    frozen:{meetingId:"test-meeting", snapshotSha256:"a".repeat(64),
      transcriptSha256:"b".repeat(64), transcriptVersion:2, roster,
      scopeId:"diagnostic:scope", roomId:"diagnostic:room", releaseId:"diagnostic-release"},
    rosterSha256:sha256(roster),
    providerBinding:{capabilityFingerprint:"a".repeat(64), indexProfileDigest:"b".repeat(64),
      contractVersion:"context-retrieval.v2", profileId: "locator-v2-full-"+"b".repeat(64),
      rankingPolicy:"weighted_rrf_canonical_preferences.v1",
      requiredProviderLanes:["postgres_keyword","qdrant_dense"], serviceRevision:"test-revision"},
    questions,
    connections:{artifactRoot, artifactKeyPath:"/missing-test-key",
      topologyKeyPath:"/missing-test-topology", postgresUrlPath:"/missing-test-pg",
      infinityTokenPath:"/missing-test-infinity", runtimeTokenPath:"/missing-test-runtime",
      infinityBaseUrl:"http://127.0.0.1:1", runtimeAddress:"127.0.0.1:1",
      expectedRuntimeLauncherSha256:"c".repeat(64)},
  };
}

describe("diagnostic input preflight", () => {
  it.each([{model: "gpt-5.6-sol", reasoningEffort: "medium"},
    {model: "gpt-5.6-terra", reasoningEffort: "medium"},
    {model: "gpt-5.6-terra", reasoningEffort: "low", serviceTier: "fast"}])(
    "rejects stale or substituted memory profile before effects: %j", profile => {
      expect(() => decodeDiagnosticManifest({...manifestFixture("/test-artifacts"),
        ...profile})).toThrow();
    });
  it.each([null, [], {}, {roster:null}, {roster:{humans:"human", automation:[]}},
    {roster:{humans:[1], automation:[]}}, {roster:{humans:["human"], automation:["human"]}},
    {transcriptVersion:"2"}, {snapshotSha256:null}, {scopeId:"production"}])(
    "rejects malformed frozen evidence before report creation: %j", async malformed => {
      const root = await mkdtemp(join(tmpdir(),"diagnostic-preflight-"));
      try {
        const manifest = manifestFixture(join(root,"artifacts"));
        const frozen = malformed !== null && !Array.isArray(malformed) && Object.keys(malformed).length > 0
          ? {...manifest.frozen, ...malformed} : malformed;
        const input = {...manifest,frozen};
        expect(()=>decodeDiagnosticManifest(input)).toThrow();
        const manifestPath=join(root,"manifest.json"), reportPath=join(root,"report.json");
        await writeFile(manifestPath,JSON.stringify(input));
        expect(await runDiagnosticCli(["diagnostic-run",manifestPath,reportPath])).toBe(1);
        await expect(access(reportPath)).rejects.toThrow();
      } finally {await rm(root,{recursive:true,force:true});}
    });
  it("copies and freezes the validated roster", () => {
    const input=manifestFixture("/test-artifacts");
    const decoded=decodeDiagnosticManifest(input);
    input.frozen.roster.humans.push("foreign");
    input.frozen.meetingId="foreign";
    expect(decoded.frozen.roster.humans).toEqual(["human"]);
    expect(decoded.frozen.meetingId).toBe("test-meeting");
    expect(Object.isFrozen(decoded.frozen)).toBe(true);
    expect(Object.isFrozen(decoded.frozen.roster)).toBe(true);
    expect(Object.isFrozen(decoded.frozen.roster.humans)).toBe(true);
  });
  it("rejects normalized, equal and symlinked report destinations before effects", async () => {
    const root=await mkdtemp(join(tmpdir(),"diagnostic-paths-"));
    try {
      const artifacts=join(root,"artifacts");
      await mkdir(artifacts);
      await mkdir(join(root,"outside","nested"),{recursive:true});
      await symlink(join(root,"outside","nested"),join(root,"hop"));
      await symlink(artifacts,join(root,"alias"));
      const invalidPaths=[
        {artifactRoot:join(root,"hop")+"/..",report:join(root,"report.json")},
        {artifactRoot:join(root,"outside"),report:join(root,"hop")+"/../report.json"},
        {artifactRoot:artifacts+"/",report:join(artifacts,"report.json")},
        {artifactRoot:artifacts,report:artifacts},
        {artifactRoot:artifacts,report:join(root,"outside")+"/../artifacts/report.json"},
        {artifactRoot:join(root,"alias"),report:join(artifacts,"report.json")},
        {artifactRoot:artifacts,report:join(root,"alias","report.json")},
        {artifactRoot:artifacts,report:join(root,"alias","new","report.json")},
      ];
      for(const [index,variant] of invalidPaths.entries()) {
        await expect(resolveDiagnosticReportPath(variant.report,variant.artifactRoot)).rejects.toThrow();
        const manifestPath=join(root,`manifest-${index}.json`);
        await writeFile(manifestPath,JSON.stringify(manifestFixture(variant.artifactRoot)));
        expect(await runDiagnosticCli(["diagnostic-run",manifestPath,variant.report])).toBe(1);
      }
      await expect(access(join(artifacts,"report.json"))).rejects.toThrow();
      await expect(access(join(root,"report.json"))).rejects.toThrow();
      expect(await resolveDiagnosticReportPath(join(root,"outside","report.json"),artifacts))
        .toBe(join(root,"outside","report.json"));
      expect(await resolveDiagnosticReportPath(join(root,"artifacts-sibling","report.json"),artifacts))
        .toBe(join(root,"artifacts-sibling","report.json"));
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
