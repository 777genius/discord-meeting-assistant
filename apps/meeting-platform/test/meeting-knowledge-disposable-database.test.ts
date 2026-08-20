import { describe, expect, it } from "vitest";

import { disposableExternalPostgresUrl } from
  "./meeting-knowledge-production-composition-diagnostics.js";

describe("Meeting Knowledge disposable PostgreSQL qualification", () => {
  it("rejects unsafe caller-supplied PostgreSQL targets", () => {
    expect(() => disposableExternalPostgresUrl({
      MEETING_KNOWLEDGE_E2E_DISPOSABLE_DATABASE: "meeting_knowledge_e2e_remote",
      MEETING_KNOWLEDGE_E2E_POSTGRES_URL:
        "postgresql://synthetic:secret@database.internal/meeting_knowledge_e2e_remote",
    })).toThrow(/loopback/u);
    expect(() => disposableExternalPostgresUrl({
      MEETING_KNOWLEDGE_E2E_DISPOSABLE_DATABASE: "production",
      MEETING_KNOWLEDGE_E2E_POSTGRES_URL:
        "postgresql://synthetic:secret@127.0.0.1/production",
    })).toThrow(/dedicated database/u);
    expect(() => disposableExternalPostgresUrl({
      MEETING_KNOWLEDGE_E2E_DISPOSABLE_DATABASE: "meeting_knowledge_e2e_other",
      MEETING_KNOWLEDGE_E2E_POSTGRES_URL:
        "postgresql://synthetic:secret@127.0.0.1/meeting_knowledge_e2e_worker_1",
    })).toThrow(/exact database/u);
    expect(disposableExternalPostgresUrl({
      MEETING_KNOWLEDGE_E2E_DISPOSABLE_DATABASE: "meeting_knowledge_e2e_worker_1",
      MEETING_KNOWLEDGE_E2E_POSTGRES_URL:
        "postgresql://synthetic:secret@127.0.0.1:54329/meeting_knowledge_e2e_worker_1",
    })).toBe(
      "postgresql://synthetic:secret@127.0.0.1:54329/meeting_knowledge_e2e_worker_1",
    );
  });
});
