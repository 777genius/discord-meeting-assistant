import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createOssNativeEvidence } from "../src/composition/oss-native-evidence.js";
import { PlatformStartupCleanup } from "../src/composition/startup-cleanup.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "oss-composition-"));
  const cleanup = new PlatformStartupCleanup();
  const evidence = createOssNativeEvidence(cleanup, {
    OSS_STT_NATIVE_EVIDENCE_DIRECTORY: directory,
    OSS_STT_NATIVE_EVIDENCE_PROJECT: "vtoss-test-oss-8f49a06-r1",
    OSS_STT_NATIVE_EVIDENCE_REVISION: "a".repeat(40),
    E2E_TEST_ONLY_LABEL: "true",
    CONVERSATION_ENABLED: "false",
    SUMMARY_PROVIDER: "transcript-outline",
  })!;
  return { directory, cleanup, evidence };
}

describe("OSS composition durable cleanup", () => {
  it("waits for live close before sealing post-call evidence and completing close", async () => {
    const { directory, evidence } = fixture();
    const originalClose = evidence.live.close.bind(evidence.live);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = vi.fn();
    vi.spyOn(evidence.live, "close").mockImplementation(async (beforePublish) => {
      started();
      await gate;
      await originalClose(beforePublish);
    });
    let completed = false;
    const closing = evidence.close().then(() => { completed = true; return null; });
    try {
      await vi.waitFor(() => { expect(started).toHaveBeenCalledOnce(); });
      expect(completed).toBe(false);
      expect(readFileSync(join(directory, "post-call-native.jsonl"), "utf8")).not.toContain("capture_seal");
      release();
      await closing;
      for (const name of ["live-native.jsonl", "post-call-native.jsonl"]) {
        expect(readFileSync(join(directory, name), "utf8")).toContain("capture_seal");
      }
    } finally { release(); await closing; rmSync(directory, { recursive: true }); }
  });

  it("propagates a failed real journal and never seals post-call evidence", async () => {
    const { directory, cleanup, evidence } = fixture();
    // An unfinished admitted session makes the real writer fail closed.
    evidence.live.open();
    try {
      await expect(cleanup.close()).rejects.toThrow("startup cleanup was incomplete");
      await expect(evidence.close()).rejects.toThrow("capture failed");
      expect(existsSync(join(directory, "live-native.jsonl"))).toBe(false);
      expect(readFileSync(join(directory, "post-call-native.jsonl"), "utf8")).not.toContain("capture_seal");
    } finally { evidence.postCall.seal(); rmSync(directory, { recursive: true }); }
  });

  it("keeps a post-call seal failure sticky before live publication", async () => {
    const { directory, cleanup, evidence } = fixture();
    const seal = vi.spyOn(evidence.postCall, "seal").mockImplementation(() => {
      throw new Error("post-call durable seal failed");
    });
    try {
      await expect(evidence.close()).rejects.toThrow("cannot qualify");
      await expect(cleanup.close()).rejects.toThrow("startup cleanup was incomplete");
      await expect(evidence.close()).rejects.toThrow("cannot qualify");
      expect(seal).toHaveBeenCalledOnce();
      expect(existsSync(join(directory, "live-native.jsonl"))).toBe(false);
      expect(readFileSync(join(directory, "post-call-native.jsonl"), "utf8")).not.toContain("capture_seal");
    } finally {
      seal.mockRestore();
      evidence.postCall.seal();
      rmSync(directory, { recursive: true });
    }
  });
});

it("startup rollback cancels before close and cannot later qualify", async () => {
  const { directory, cleanup, evidence } = fixture();
  await expect(cleanup.close()).rejects.toThrow("startup cleanup was incomplete");
  await expect(evidence.close()).rejects.toThrow("cannot qualify");
  expect(existsSync(join(directory, "live-native.jsonl"))).toBe(false);
  expect(readFileSync(join(directory, "post-call-native.jsonl"), "utf8")).not.toContain("capture_seal");
  evidence.postCall.seal();
  rmSync(directory, { recursive: true });
});
