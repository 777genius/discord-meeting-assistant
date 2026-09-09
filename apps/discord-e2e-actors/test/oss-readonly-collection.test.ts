import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { campaignFixture } from "./oss-campaign-fixture.js";
import { collectOssReadonlySnapshot, type OssReadCommand } from "../src/oss-readonly-collection.js";
import { sha256 } from "../src/oss-campaign-artifacts.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "oss-readonly-test-"));
  const fixture = await campaignFixture(root);
  const run = fixture.runs[0]!;
  const calls: readonly string[][] = [];
  const mutableCalls = calls as string[][];
  let admitted = true;
  const command: OssReadCommand = async (args) => {
    mutableCalls.push([...args]);
    if (args[0] === "ps") { return args.includes("label=com.docker.compose.service=postgres") ? "b".repeat(12) : "a".repeat(12); }
    if (args[0] === "inspect") {
      if (args[2] === "{{.State.Health.Status}}") { return "healthy"; }
      if (args[2] === "{{.Image}}") { return `sha256:${"a".repeat(64)}`; }
      return JSON.stringify({
        composeProject: fixture.plan.target.project,
        composeService: args.at(-1) === "b".repeat(12) ? "postgres" : "meeting-platform", testOnly: String(admitted)
      });
    }
    if (args[0] === "image") { return JSON.stringify({ sourceRevision: fixture.plan.target.platformRevision }); }
    const query = args.at(-1)!;
    if (query.startsWith("BEGIN READ ONLY")) {
      if (query.includes("clock_timestamp")) { return "1000000"; }
      if (query.includes("WITH target AS")) { return JSON.stringify(fixture.files.get(run.databasePath)!.value); }
      if (query.includes("live_meeting_turns")) { return JSON.stringify(run.liveTurns); }
      if (query.includes("FROM meeting_core.meetings")) { return JSON.stringify(fixture.runs.map((entry) => entry.recordingId)); }
    }
    if (args.includes("-e") && args.some((arg) => arg.includes("completed-v1"))) {
      return JSON.stringify([fixture.files.get(run.completionPath)!.value]);
    }
    if (args.includes("-e") && args.some((arg) => arg.includes("GetObjectCommand"))) {
      const paths = [run.manifestPath, ...run.tracks.map((track) => track.path)];
      return JSON.stringify(paths.map((path) => {
        const value = fixture.files.get(path)!.value;
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
        return {
          locator: path, revision: "offline-version-1", sizeBytes: bytes.length,
          checksumSha256: sha256(bytes), base64: bytes.toString("base64")
        };
      }));
    }
    throw new Error("Unexpected source command");
  };
  return { root, fixture, run, calls, command, deny: () => { admitted = false; } };
}
describe("OSS read-only native source collection", () => {
  it("executes only admitted bounded reads and retains parsed native bytes", async () => {
    const test = await setup();
    try {
      const result = await collectOssReadonlySnapshot({
        plan: test.fixture.plan,
        recordingId: test.run.recordingId, command: test.command
      });
      expect(result.database).toEqual(test.fixture.files.get(test.run.databasePath)!.value);
      expect(result.liveTurns).toEqual(test.run.liveTurns);
      expect(result.objects).toHaveLength(3);
      const sqlCalls = test.calls.filter((call) => call.includes("oss-readonly"));
      expect(sqlCalls).toHaveLength(4);
      expect(sqlCalls.every((call) => call.at(-1)!.startsWith("BEGIN READ ONLY;"))).toBe(true);
      expect(sqlCalls.some((call) => call.at(-1)!.includes("turn->>'text'"))).toBe(true);
      expect(test.calls.flat().join(" ")).not.toMatch(/BullMQ|replayJob|INSERT|UPDATE|DELETE|collect:e2e/u);
    } finally { await rm(test.root, { recursive: true }); }
  });
  it("denies collection before any database call for a non-TEST source", async () => {
    const test = await setup();
    try {
      test.deny();
      await expect(collectOssReadonlySnapshot({
        plan: test.fixture.plan,
        recordingId: test.run.recordingId, command: test.command
      })).rejects.toThrow("TEST admission");
      expect(test.calls.some((call) => call[0] === "exec")).toBe(false);
    } finally { await rm(test.root, { recursive: true }); }
  });
});
