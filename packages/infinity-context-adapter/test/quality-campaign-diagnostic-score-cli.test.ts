import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoricalIndexPlanV1 } from "@discord-meeting/meeting-core/meeting-knowledge";
import type { DiagnosticManifest, DiagnosticManifestV2 } from "../src/quality-campaign/diagnostic-manifest.js";
import type { DiagnosticOutcome } from "../src/quality-campaign/diagnostic-run.js";
import { sha256 } from "../src/quality-campaign/canonical.js";

const paths = { manifest: "/test/manifest.json", report: "/test/report.json", gold: "/test/gold.json",
  output: "/test/score.json", key: "/test/artifact.key" } as const;
const moduleBytes = Buffer.from("synthetic installed diagnostic runner");
const sdkBytes = Buffer.from("synthetic installed V1 SDK entrypoint");

const mocked = vi.hoisted(() => ({
  manifest: undefined as unknown,
  report: undefined as unknown,
  sealed: undefined as unknown,
  plan: undefined as unknown,
  outcomes: [] as unknown[],
  installedSdk: undefined as unknown,
  sdkFailure: undefined as Error | undefined,
  reads: [] as string[],
  writes: [] as { path: string; data: string; options: unknown }[],
  custodyBinding: "",
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async (path: string | URL) => {
    const name = typeof path === "string" ? path : path.href;
    mocked.reads.push(name);
    if (name === paths.manifest) { return JSON.stringify(mocked.manifest); }
    if (name === paths.report) { return JSON.stringify(mocked.report); }
    if (name === paths.gold) { return JSON.stringify(gold()); }
    if (name === paths.key) { return Buffer.alloc(32, 1).toString("base64"); }
    if (name.endsWith("/diagnostic-run.js")) { return moduleBytes; }
    if (path instanceof URL) { return sdkBytes; }
    throw new Error(`unexpected provisional read: ${name}`);
  }),
  writeFile: vi.fn(async (path: string, data: string, options: unknown) => {
    mocked.writes.push({ path, data, options });
  }),
}));
vi.mock("../src/quality-campaign/diagnostic-manifest.js", () => ({
  decodeVersionedDiagnosticManifest: vi.fn(() => mocked.manifest),
}));
vi.mock("../src/quality-campaign/diagnostic-run.js", () => ({
  verifyInstalledDiagnosticSdk: vi.fn(async () => {
    if (mocked.sdkFailure !== undefined) { throw mocked.sdkFailure; }
    return mocked.installedSdk;
  }),
}));
vi.mock("../src/quality-campaign/diagnostic-custody.js", () => ({
  DiagnosticCustody: class {
    public constructor(_root: string, _key: Uint8Array, binding: string) { mocked.custodyBinding = binding; }
    public async recover(id: string): Promise<unknown> {
      if (id === "execution-complete") { return mocked.sealed; }
      if (id === "frozen-plan") { return mocked.plan; }
      if (id.startsWith("question-")) { return mocked.outcomes.shift() ?? null; }
      throw new Error(`unexpected provisional custody read: ${id}`);
    }
  },
}));

import { runDiagnosticScoreCli } from "../src/quality-campaign/diagnostic-score-cli.js";

const questions = () => Array.from({ length: 40 }, (_, index) => ({
  locale: "en" as const, questionId: `q${index}`, questionText: `synthetic question ${index}`,
  scopeTopologyReference: `scope-${index}`,
}));
const outcomes = (): DiagnosticOutcome[] => Array.from({ length: 40 }, (_, index) => ({
  questionId: `q${index}`, status: index === 0 ? "answered" : "failed", reason: null,
  citations: [], claims: [], retrievedLocators: index === 0 ? ["b1"] : [],
  citationValidity: { valid: 0, total: 0 },
  latencyMs: { retrieval: null, postgres: null, answer: null, endToEnd: 1 },
  bytes: { evidence: 0, originalPrompt: 0, repairPrompt: 0 },
}));
const plan = { documents: [{ manifest: { candidateLocator: "b1", turnIds: ["t1"] } }] } as unknown as HistoricalIndexPlanV1;
const gold = () => Array.from({ length: 40 }, (_, index) => ({
  questionId: `q${index}`, expectedDisposition: "answerable" as const, relevantTurnIds: ["t1"],
}));
const connections = { artifactKeyPath: paths.key, artifactRoot: "/test/custody" };
const v1Manifest = () => ({ schemaVersion: "meeting_knowledge.real40_diagnostic.v1",
  questions: questions(), connections }) as unknown as DiagnosticManifest;
const sdkIdentity = { packageName: "@infinity-context/sdk" as const, version: "0.3.1",
  sourceRevision: "b".repeat(40), tarballSha256: "c".repeat(64), manifestSha256: "d".repeat(64) };
const installedSdk = { ...sdkIdentity, loadedEntrypointSha256: "1".repeat(64) };

function outputRecord(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("expected diagnostic score object");
  }
  return Object.fromEntries(Object.entries(parsed));
}

function nestedRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected nested diagnostic score object");
  }
  return Object.fromEntries(Object.entries(value));
}
const v2Manifest = () => ({ schemaVersion: "meeting_knowledge.real40_diagnostic.v2",
  sourceRevision: sdkIdentity.sourceRevision, sdkIdentity, threadSelector: { mode: "any" },
  providerBinding: { contractVersion: "context-retrieval.v3" },
  frozen: { snapshotSha256: "a".repeat(64), transcriptSha256: "e".repeat(64) },
  rosterSha256: "f".repeat(64), questions: questions(), connections }) as unknown as DiagnosticManifestV2;

function v2Report(manifest: DiagnosticManifestV2, retainedOutcomes: readonly DiagnosticOutcome[]) {
  const loadedModuleSha256 = sha256(moduleBytes);
  return { schemaVersion: "meeting_knowledge.real40_diagnostic_report.v2", qualifying: false,
    rootBindingSha256: sha256({ manifest, loadedModuleSha256,
      loadedSdkSha256: installedSdk.loadedEntrypointSha256 }),
    declaredSourceRevision: manifest.sourceRevision, sourceRevisionAuthority: "owner_declared_unverified",
    loadedModuleSha256, loadedSdkSha256: installedSdk.loadedEntrypointSha256,
    snapshotSha256: manifest.frozen.snapshotSha256, transcriptSha256: manifest.frozen.transcriptSha256,
    rosterSha256: manifest.rosterSha256, planSha256: sha256(plan), questionDenominator: 40,
    indexPreparation: { status: "ready" },
    counts: { answered: 1, abstained: 0, failed: 39, unknown: 0 }, factualAccuracy: "UNMEASURED",
    recall: "UNMEASURED_REQUIRES_SEPARATE_GOLD_MAPPING",
    questions: retainedOutcomes.map(value => ({ questionId: value.questionId, status: value.status,
      retrievedCount: value.retrievedLocators.length })),
    executingModuleIdentity: { loadedModuleSha256 }, sdkIdentity, executingSdkIdentity: installedSdk,
    selectedContracts: { manifest: manifest.schemaVersion,
      report: "meeting_knowledge.real40_diagnostic_report.v2", retrieval: "context-retrieval.v3",
      threadSelector: { mode: "any" } },
  };
}

beforeEach(() => {
  mocked.sdkFailure = undefined; mocked.installedSdk = installedSdk; mocked.reads = []; mocked.writes = [];
  mocked.custodyBinding = ""; mocked.plan = plan;
});

describe("diagnostic-score CLI authentication and version dispatch", () => {
  it("preserves V1 scoring and create-only output", async () => {
    mocked.manifest = v1Manifest(); mocked.report = { schemaVersion: "meeting_knowledge.real40_diagnostic_report.v1" };
    mocked.sealed = mocked.report; mocked.outcomes = outcomes();
    const code = await runDiagnosticScoreCli(["diagnostic-score", paths.manifest, paths.report, paths.gold, paths.output]);
    expect(code).toBe(0);
    expect(mocked.reads).toContain(paths.gold);
    expect(mocked.writes).toHaveLength(1);
    expect(mocked.writes[0]!.options).toEqual({ flag: "wx", mode: 0o600 });
    expect(outputRecord(mocked.writes[0]!.data).schemaVersion)
      .toBe("meeting_knowledge.real40_diagnostic_score.v1");
  });

  it("authenticates and dispatches V2 scoring before reading gold", async () => {
    const manifest = v2Manifest(), retainedOutcomes = outcomes();
    const report = v2Report(manifest, retainedOutcomes);
    mocked.manifest = manifest; mocked.report = report;
    mocked.sealed = mocked.report; mocked.outcomes = [...retainedOutcomes];
    expect(await runDiagnosticScoreCli(["diagnostic-score", paths.manifest, paths.report, paths.gold, paths.output])).toBe(0);
    expect(mocked.reads.indexOf(paths.gold)).toBeGreaterThan(mocked.reads.indexOf(paths.report));
    const written = outputRecord(mocked.writes[0]!.data);
    const overall = nestedRecord(written.overall);
    expect(written.schemaVersion).toBe("meeting_knowledge.real40_diagnostic_score.v2");
    expect(overall.counts).toEqual({ answered: 1, abstained: 0, failed: 39, unknown: 0 });
    expect(overall.microBlockRecallAt5).toEqual({ numerator: 1, denominator: 40 });
    expect(mocked.custodyBinding).toBe(report.rootBindingSha256);
  });

  it("refuses a foreign installed SDK package without opening gold or output", async () => {
    const manifest = v2Manifest(); mocked.manifest = manifest; mocked.report = v2Report(manifest, outcomes());
    mocked.sealed = mocked.report; mocked.outcomes = outcomes(); mocked.sdkFailure = new Error("foreign package");
    expect(await runDiagnosticScoreCli(["diagnostic-score", paths.manifest, paths.report, paths.gold, paths.output])).toBe(1);
    expect(mocked.reads).not.toContain(paths.gold); expect(mocked.writes).toEqual([]);
  });

  it.each([
    ["module", (report: ReturnType<typeof v2Report>) => { report.loadedModuleSha256 = "8".repeat(64); }],
    ["root", (report: ReturnType<typeof v2Report>) => { report.rootBindingSha256 = "7".repeat(64); }],
    ["contracts", (report: ReturnType<typeof v2Report>) => { report.selectedContracts.retrieval = "context-retrieval.v2"; }],
  ])("refuses foreign %s report authentication before gold or output", async (_name, mutate) => {
    const manifest = v2Manifest(), retainedOutcomes = outcomes(), report = v2Report(manifest, retainedOutcomes);
    mutate(report); mocked.manifest = manifest; mocked.report = report; mocked.sealed = report;
    mocked.outcomes = [...retainedOutcomes];
    expect(await runDiagnosticScoreCli(["diagnostic-score", paths.manifest, paths.report, paths.gold, paths.output])).toBe(1);
    expect(mocked.reads).not.toContain(paths.gold); expect(mocked.writes).toEqual([]);
  });

  it("refuses a foreign sealed report before gold or output", async () => {
    const manifest = v2Manifest(); mocked.manifest = manifest; mocked.report = v2Report(manifest, outcomes());
    mocked.sealed = { ...mocked.report as object, rootBindingSha256: "6".repeat(64) }; mocked.outcomes = outcomes();
    expect(await runDiagnosticScoreCli(["diagnostic-score", paths.manifest, paths.report, paths.gold, paths.output])).toBe(1);
    expect(mocked.reads).not.toContain(paths.gold); expect(mocked.writes).toEqual([]);
  });

  it("refuses a foreign retained outcome before gold or output", async () => {
    const manifest = v2Manifest(), reportedOutcomes = outcomes(), retainedOutcomes = outcomes();
    retainedOutcomes[0] = { ...retainedOutcomes[0]!, status: "outcome_unknown" };
    mocked.manifest = manifest; mocked.report = v2Report(manifest, reportedOutcomes);
    mocked.sealed = mocked.report; mocked.outcomes = retainedOutcomes;
    expect(await runDiagnosticScoreCli(["diagnostic-score", paths.manifest, paths.report, paths.gold, paths.output])).toBe(1);
    expect(mocked.reads).not.toContain(paths.gold); expect(mocked.writes).toEqual([]);
  });
});
