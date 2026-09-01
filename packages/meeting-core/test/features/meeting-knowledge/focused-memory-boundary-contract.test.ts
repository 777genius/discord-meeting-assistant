import { decodeFocusedMemoryRetrievalResult } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { describe, expect, it } from "vitest";

import { authority, references } from "./local-final-reply-application-fixtures.test.js";

describe("focused-memory boundary contract", () => {
  const valid = {
    authorityGeneration: authority.memoryGeneration,
    candidates: references,
    schemaVersion: 1,
    status: "current",
  } as const;

  it("accepts only the versioned reference-only result shape", () => {
    expect(decodeFocusedMemoryRetrievalResult(valid)).toEqual(valid);
    expect(() => decodeFocusedMemoryRetrievalResult({ ...valid, schemaVersion: 2 }))
      .toThrow("version is unsupported");
    expect(() => decodeFocusedMemoryRetrievalResult({ ...valid,
      candidates: [{ ...references[0], text: "provider-owned transcript text" }] }))
      .toThrow("unknown field");
    expect(() => decodeFocusedMemoryRetrievalResult({ ...valid,
      candidates: [references[0], references[0]] })).toThrow("must be unique");
    expect(() => decodeFocusedMemoryRetrievalResult({ ...valid,
      candidates: [{ ...references[0], relevanceScore: 0.75 }] }))
      .toThrow("unknown field");
    const historical = { ...references[0], historicalSource: {
      candidateLocator: "candidate-1", indexGeneration: "generation-1",
      releaseId: "release-1" }, meetingId: "historical-meeting" };
    expect(decodeFocusedMemoryRetrievalResult({ ...valid, candidates: [historical] }))
      .toMatchObject({ candidates: [historical] });
    expect(() => decodeFocusedMemoryRetrievalResult({ ...valid, candidates: [{
      ...historical, historicalSource: { releaseId: "release-1" },
    }] })).toThrow();
  });
});
