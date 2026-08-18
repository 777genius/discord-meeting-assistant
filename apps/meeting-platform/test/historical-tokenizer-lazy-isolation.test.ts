import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const tokenizerFailure = vi.hoisted(() => ({
  message: "tokenizer asset missing",
}));

vi.mock("@discord-meeting/infinity-context-adapter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@discord-meeting/infinity-context-adapter")
  >();
  return {
    ...actual,
    PinnedMultilingualMiniLmTokenizer: function PinnedMultilingualMiniLmTokenizer() {
      throw new Error(tokenizerFailure.message);
    },
  };
});

import { startDisposableInfinityHttpService } from
  "@discord-meeting/infinity-context-adapter/test-support";

import {
  requiredHistoricalRuntime,
} from "./meeting-knowledge-production-composition-fixtures.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("historical tokenizer lazy failure isolation", () => {
  it("does not construct the tokenizer for deletion-only composition", async () => {
    const pool = new Pool({
      connectionString: "postgresql://synthetic.invalid/never-connected",
    });
    const infinity = await startDisposableInfinityHttpService();
    const runtime = requiredHistoricalRuntime(pool, infinity, false, false);
    try {
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      expect(runtime.embeddingTokenizer()).toBeUndefined();
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.requestMeetingDeletion).toBeTypeOf("function");
    } finally {
      await runtime.close();
      await infinity.close();
      await pool.end();
    }
  });

  it.each([
    "tokenizer asset missing",
    "tokenizer asset checksum mismatch",
  ])("keeps external indexing closed after %s", async (message) => {
    tokenizerFailure.message = message;
    const pool = new Pool({
      connectionString: "postgresql://synthetic.invalid/never-connected",
    });
    const infinity = await startDisposableInfinityHttpService();
    const runtime = requiredHistoricalRuntime(pool, infinity, true, true);
    try {
      await expect(runtime.assertReady()).resolves.toBeUndefined();
      expect(runtime.embeddingTokenizer()).toBeUndefined();
      expect(runtime.searchEnabled()).toBe(false);
      expect(runtime.servingAuthorized()).toBe(false);
      expect(runtime.requestMeetingDeletion).toBeTypeOf("function");
    } finally {
      await runtime.close();
      await infinity.close();
      await pool.end();
    }
  });
});
