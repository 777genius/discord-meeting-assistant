import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReceipt, loadArchive } from "../src/oss-campaign-artifacts.js";
import { verifyOssCampaign } from "../src/oss-campaign-verification.js";
import { verifyOssQuality } from "../src/oss-campaign-quality.js";
import { fixtureManifestV1Schema } from "../src/e2e-fixture-manifest-schema.js";
import { campaignFixture } from "./oss-campaign-fixture.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp("/tmp/oss-campaign-test-"); roots.push(root);
  const fixture = await campaignFixture(root);
  return { ...fixture, root, verify: async () => {
    await fixture.save();
    return verifyOssCampaign(await loadArchive(fixture.planPath, root), fixture.manifestBytes);
  } };
}

describe("OSS campaign retained evidence", () => {
  it("qualifies three isolated scenarios and re-verifies a create-only receipt", async () => {
    const fixture = await setup();
    const receipt = await fixture.verify();
    expect(receipt.runs.map((run) => run.scenario)).toEqual(["sequential", "overlap", "reconnect"]);
    const path = join(fixture.root, "pass.json");
    await createReceipt(path, receipt);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(await fixture.verify());
    await expect(createReceipt(path, receipt)).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
  }, 60_000);
  const mutations: Array<[string, (fixture: Awaited<ReturnType<typeof setup>>) => void]> = [
    ["non-test target", (f) => { Object.assign(f.plan.target, { project: "production" }); }],
    ["wrong guild", (f) => { Object.assign(f.plan.target, { guildId: "other" }); }],
    ["duplicate scenario", (f) => { f.plan.runs[1]!.scenario = "sequential"; }],
    ["duplicate run", (f) => { f.plan.runs[1]!.runId = f.plan.runs[0]!.runId; }],
    ["run mismatch", (f) => { f.runs[0]!.runId = "another-run"; }],
    ["recording mismatch", (f) => { f.runs[0]!.recordingId = f.runs[1]!.recordingId; }],
    ["duplicate recording effect", (f) => { f.runs[0]!.settled[0]!.recordingIds.push("extra"); }],
    ["duplicate original", (f) => { f.runs[0]!.originals.push(f.runs[0]!.originals[0]!); }],
    ["missing completion receipt", (f) => { f.files.delete(f.runs[0]!.completionPath); }],
    ["missing original inventory", (f) => { f.files.delete(f.runs[0]!.originalInventoryPath); }],
    ["missing immutable manifest", (f) => { f.files.delete(f.runs[0]!.manifestPath); }],
    ["missing original", (f) => { f.files.delete(f.runs[0]!.originals[0]!); }],
    ["missing live sessions", (f) => { f.runs[0]!.sessions = []; }],
    ["missing live ledger", (f) => { f.runs[0]!.liveTurns = []; }],
    ["live failed with batch success", (f) => {
      Object.assign(f.wires[0]!.events.at(-2)!, { status: "timeout" });
    }],
    ["missing partial", (f) => { f.wires[0]!.events = f.wires[0]!.events.filter((e) => e.type !== "partial"); }],
    ["duplicate finalize", (f) => { f.wires[0]!.events.splice(-2, 0, f.wires[0]!.events.at(-3)!); }],
    ["missing finalize", (f) => { f.wires[0]!.events = f.wires[0]!.events.filter((e) => e.type !== "finalize"); }],
    ["missing terminal", (f) => { f.wires[0]!.events.pop(); }],
    ["bad packet", (f) => { f.files.get("recording-0.gateway-0.opus")!.value = Buffer.from([1, 2]); }],
    ["missing packet", (f) => { f.files.delete("recording-0.craig-0.opus"); }],
    ["unacknowledged audio", (f) => { f.wires[0]!.events = f.wires[0]!.events.filter((e) => e.type !== "ack"); }],
    ["stale source revision", (f) => { f.runs[0]!.sessions[0]!.sourceRevision = "d".repeat(40); }],
    ["wrong gateway endpoint", (f) => { f.wires[0]!.gatewayEndpoint = "wss://wrong.test"; }],
    ["transcript version mismatch", (f) => { f.runs[0]!.transcript.version = "2"; }],
    ["bad terminal timestamp", (f) => { f.runs[0]!.settled[1]!.terminalAtMs++; }],
    ["publication before summary", (f) => { f.runs[0]!.stages[2]!.startedAtMs = 0; }],
    ["missing transcript attachment", (f) => { f.files.delete("attachment-0.md"); }],
    ["bad quality", (f) => { f.runs[0]!.transcript.turns[0]!.text = "unrelated words"; }],
    ["bad timeline", (f) => { f.runs[0]!.transcript.turns[0]!.startMs += 4000; }],
    ["lost overlap", (f) => { f.runs[1]!.transcript.turns[0]!.endMs = 1700; }],
    ["duplicate actor playback", (f) => { f.actors[0]!.events.push(f.actors[0]!.events.at(-1)!); }],
    ["missing reconnect", (f) => { f.actors[2]!.events = f.actors[2]!.events.filter((e) => e.type !== "disconnected"); }],
    ["deployment changed", (f) => { f.deployment.targetAfter.craigRevision = "e".repeat(40); }],
    ["unknown schema fields", (f) => { Object.assign(f.runs[0]!, { passed: true }); }],
  ];
  it.each(mutations)("rejects %s even with a valid collector signature", async (_name, mutate) => {
    const fixture = await setup(); mutate(fixture);
    await expect(fixture.verify()).rejects.toThrow();
  }, 60_000);
  it.each(["text", "terms", "timeline", "overlap"])("rejects %s at the quality gate", async (kind) => {
    const f = await setup();
    const manifest = fixtureManifestV1Schema.parse(JSON.parse(f.manifestBytes.toString()));
    const run = f.runs[1]!;
    if (kind === "text") run.transcript.turns[0]!.text = "unrelated";
    if (kind === "terms") run.transcript.turns[0]!.text = run.transcript.turns[0]!.text.replaceAll("PostgreSQL", "database");
    if (kind === "timeline") run.transcript.turns[0]!.startMs += 4000;
    if (kind === "overlap") run.transcript.turns[0]!.endMs = 1700;
    expect(() => verifyOssQuality(run, manifest, f.actors[1])).toThrow();
  }, 60_000);
  it("rejects a different plan key and forged index contents", async () => {
    const f = await setup(); await f.save();
    const other = await setup();
    await writeFile(f.planPath, JSON.stringify({ ...f.plan, collectorPublicKeyPem: other.plan.collectorPublicKeyPem }));
    await expect(loadArchive(f.planPath, f.root)).rejects.toThrow(/signature/u);
    await f.save();
    const indexPath = join(f.root, "collection.json");
    const index: { capturedAtMs: number } = JSON.parse(await readFile(indexPath, "utf8"));
    index.capturedAtMs++;
    await writeFile(indexPath, JSON.stringify(index));
    await expect(loadArchive(f.planPath, f.root)).rejects.toThrow(/signature/u);
  }, 60_000);
  it("rejects forged signatures, altered checksums, missing artifacts and symlinks", async () => {
    const f = await setup(); await f.save();
    const signature = join(f.root, "collection.sig");
    await writeFile(signature, Buffer.alloc(64));
    await expect(loadArchive(f.planPath, f.root)).rejects.toThrow(/signature/u);
    await f.save();
    const original = join(f.root, "recording-0.original");
    await writeFile(original, "forged-original-0");
    await expect(loadArchive(f.planPath, f.root)).rejects.toThrow();
    await f.save(); await rm(original);
    await expect(loadArchive(f.planPath, f.root)).rejects.toThrow();
    await symlink(join(f.root, "operator-ca.pem"), original);
    await expect(loadArchive(f.planPath, f.root)).rejects.toThrow(/symlink/u);
  }, 60_000);
});
