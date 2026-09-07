import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeDiagnosticQuestions } from "../src/quality-campaign/diagnostic-manifest.js";
import { runDiagnosticSchedule } from "../src/quality-campaign/diagnostic-run.js";
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
