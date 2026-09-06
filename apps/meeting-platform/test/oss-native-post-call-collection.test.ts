import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OssPostCallEvidence } from "../src/composition/oss-post-call-evidence.js";
import { collectNativePostCall, qualifyNativePostCall } from "../../discord-e2e-actors/src/oss-native-post-call-collection.js";

const revision = "a".repeat(40);
describe("native post-call collection through processing ports", () => {
  it("captures real invocation boundaries without request secrets and assembles stage times", async () => {
    const directory = mkdtempSync(join(tmpdir(), "oss-post-call-test-"));
    try {
      const journal = new OssPostCallEvidence(directory, revision);
      const called: string[] = [];
      const ports = journal.wrap({
        transcriber: { transcribe: async () => { called.push("transcription"); return {
          ok: true, value: { transcriptId: "transcript", version: 1, turns: [] },
        }; } },
        summarizer: { generate: async () => { called.push("summary"); return {
          ok: true, value: { summaryId: "summary", transcriptId: "transcript", version: 1,
            title: "title", overview: "overview", decisions: [], actionItems: [], topics: [], openQuestions: [] },
        }; } },
        publisher: { publish: async () => { called.push("publication"); return {
          ok: true, value: { externalPublicationId: "message" },
        }; } },
      });
      // Only meeting identity is read by the native tap; delegates stand in for external effects.
      const request = { meetingId: "meeting", token: "never-retain-token", url: "https://never-retain" };
      await ports.transcriber.transcribe(request as unknown as Parameters<typeof ports.transcriber.transcribe>[0]);
      await ports.summarizer.generate(request as unknown as Parameters<typeof ports.summarizer.generate>[0]);
      await ports.publisher.publish(request as unknown as Parameters<typeof ports.publisher.publish>[0]);
      journal.seal();
      const bytes = readFileSync(join(directory, "post-call-native.jsonl"));
      expect(bytes.toString()).not.toContain("never-retain");
      const capture = collectNativePostCall(bytes, revision);
      expect(capture.events.map((event) => event.type)).toEqual([
        "started", "succeeded", "started", "succeeded", "started", "succeeded",
      ]);
      expect(qualifyNativePostCall(capture, "meeting").map((stage) => stage.stage)).toEqual(called);
      expect(() => collectNativePostCall(bytes.subarray(0, -1), revision)).toThrow("truncated");
      expect(() => collectNativePostCall(Buffer.from(bytes.toString().replace('"attempt":1', '"attempt":2')), revision))
        .toThrow("integrity");
      expect(() => qualifyNativePostCall(capture, "missing")).toThrow();
    } finally { rmSync(directory, { recursive: true }); }
  });
  it.each([false, true])("retains failed results and throws (%s) without exception content", async (throws) => {
    const directory = mkdtempSync(join(tmpdir(), "oss-post-call-failure-"));
    try {
      const journal = new OssPostCallEvidence(directory, revision);
      const delegate = async () => {
        if (throws) throw new Error("never-retain-error-secret");
        return { ok: false as const, failure: { code: "failure", message: "never-retain-message", retryable: true } };
      };
      const ports = journal.wrap({ transcriber: { transcribe: delegate },
        summarizer: { generate: delegate }, publisher: { publish: delegate } });
      const operation = ports.transcriber.transcribe({ meetingId: "meeting" } as Parameters<typeof ports.transcriber.transcribe>[0]);
      if (throws) await expect(operation).rejects.toThrow(); else await expect(operation).resolves.toMatchObject({ ok: false });
      journal.seal();
      const bytes = readFileSync(join(directory, "post-call-native.jsonl"));
      expect(bytes.toString()).not.toContain("never-retain");
      const capture = collectNativePostCall(bytes, revision);
      expect(capture.events.at(-1)?.type).toBe(throws ? "threw" : "failed");
      expect(() => qualifyNativePostCall(capture, "meeting")).toThrow();
    } finally { rmSync(directory, { recursive: true }); }
  });
});
