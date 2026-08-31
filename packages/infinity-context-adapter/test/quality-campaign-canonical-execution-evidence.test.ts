import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createProductionCanonicalExecutionEvidence } from
  "../src/quality-campaign/production-canonical-execution-evidence.js";

const attemptId = `sqv4-${"1".repeat(64)}`;
const rootBindingSha256 = "2".repeat(64);

describe("canonical execution evidence durability", () => {
  it("fsyncs a create-only reservation before a provider phase can continue", async () => {
    const fixture = await evidenceFixture();
    await fixture.evidence.journal.reserve({ attemptId, payloadSha256: "3".repeat(64),
      phase: "retrieval" });
    const reservation = JSON.parse(await readFile(join(fixture.retrievalJournalRoot,
      attemptId, "provider_reserved.json"), "utf8")) as Record<string, unknown>;
    expect(reservation).toMatchObject({ attemptId, phase: "retrieval",
      state: "provider_reserved" });
    await fixture.evidence.journal.terminal({ attemptId, payloadSha256: "4".repeat(64),
      phase: "retrieval", state: "succeeded" });
    await expect(readFile(join(fixture.retrievalJournalRoot, attemptId, "terminal.json"),
      "utf8")).resolves.toContain('"state":"succeeded"');
  });

  it("treats a crash-surviving reservation as terminal unknown and never fresh-retries", async () => {
    const fixture = await evidenceFixture();
    await fixture.evidence.journal.reserve({ attemptId, payloadSha256: "3".repeat(64),
      phase: "answer" });
    const reopened = createProductionCanonicalExecutionEvidence(fixture.input);
    await expect(reopened.journal.reserve({ attemptId, payloadSha256: "3".repeat(64),
      phase: "answer" })).rejects.toThrow("cannot be retried");
  });
});

async function evidenceFixture() {
  const root = await mkdtemp(join(tmpdir(), "canonical-execution-evidence-"));
  const answerJournalRoot = join(root, "answer-journal");
  const retrievalJournalRoot = join(root, "retrieval-journal");
  const input = { answerJournalRoot, artifactKey: new Uint8Array(32).fill(7),
    artifactKeyId: "artifact-key", artifactRoot: join(root, "artifacts"), attemptId,
    questionId: "q-1", repetition: 1 as const, retrievalJournalRoot, rootBindingSha256 };
  return { evidence: createProductionCanonicalExecutionEvidence(input), input,
    retrievalJournalRoot };
}
