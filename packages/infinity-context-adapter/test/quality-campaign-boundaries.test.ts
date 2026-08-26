import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { artifactAttemptIdentity, attemptIdentity, CampaignEncryptedArtifactStore, canonicalJson,
  runQualityCampaignOperatorCli } from "../src/index.js";

const d = (character: string) => character.repeat(64);

describe("production quality campaign boundaries", () => {
  it("uses a closed artifact-kind call map before storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-artifacts-"));
    const answer = attemptIdentity({ callKind: "answer", callOrdinal: 0, campaignRootSha256: d("1"),
      questionDigestSha256: d("2"), questionId: "q-1", releaseRootSha256: d("3"), repetition: 1,
      spendReservationSha256: d("4") });
    const store = new CampaignEncryptedArtifactStore(directory, 100_000);
    const base = { artifactKind: "retrieval_request" as const, campaignRootSha256: d("1"),
      key: Buffer.alloc(32, 7), keyId: "key-1", plaintext: Buffer.from("secret"),
      releaseRootSha256: d("3"), spendReservationSha256: d("4") };
    await expect(store.seal({ ...base, identity: answer })).rejects.toThrow(/call semantics/u);
    expect(await readdir(directory)).toEqual([]);
    const retrieval = artifactAttemptIdentity(answer, "retrieval_request");
    expect((await store.seal({ ...base, identity: retrieval })).attemptId).toBe(retrieval.attemptId);
  });

  it("keeps public operator status closed without echoing handler text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "quality-cli-"));
    const phase = join(directory, "phase.json"); const status = join(directory, "status.json");
    await writeFile(phase, canonicalJson({ payload: {}, schemaVersion: "phase.v1" }));
    const secret = "SYNTHETIC_PRIVATE_HANDLER_TEXT"; const lines: string[] = [];
    expect(await runQualityCampaignOperatorCli({ argv: ["execute", phase], handlers: {
      run: async ({ command }) => ({ blockers: ["authorization_missing"], command,
        receipt: { counters: {}, digests: {}, errorCode: null }, status: secret as never }) },
    statusReceiptPath: status, writeSafeLine: (line) => {lines.push(line);} })).toBe(1);
    expect(lines.join("\n")).not.toContain(secret);
    await expect(readFile(status, "utf8")).rejects.toThrow();
  });
});
