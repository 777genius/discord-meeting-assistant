import { describe, expect, it } from "vitest";

import { collectorEnvironmentSchema } from "../src/e2e-collector-environment.js";

const requiredEnvironment = {
  DISCORD_E2E_ACTOR_RUN_INPUT: "/evidence/actor-run.json",
  DISCORD_E2E_EVIDENCE_OUTPUT: "/evidence/retained.json",
  DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: "a".repeat(40),
  DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION: "b".repeat(40),
  DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION: "c".repeat(40),
  DISCORD_E2E_RECORDING_ID: "recording-1",
  DISCORD_E2E_RUN_ID: "run-1",
};
const conversationEnvironment = {
  DISCORD_E2E_BOTIK_SPEAKER_ID: "1534231284467896512",
  DISCORD_E2E_CONVERSATION_VOICE_INPUTS: JSON.stringify([
    "/evidence/greeting-ru.json",
    "/evidence/greeting-en.json",
    "/evidence/greeting-unknown.json",
    "/evidence/greeting-speaker-d.json",
    "/evidence/farewell.json",
    "/evidence/answer.json",
  ]),
  DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT: "/evidence/speaker-d.json",
};
const pipecatEnvironment = {
  DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: "d".repeat(40),
};

describe("collectorEnvironmentSchema", () => {
  it("accepts a post-call campaign without conversation evidence", () => {
    expect(collectorEnvironmentSchema.safeParse(requiredEnvironment).success).toBe(true);
  });

  it("accepts the complete retained V8 conversation input group", () => {
    const result = collectorEnvironmentSchema.safeParse({
      ...requiredEnvironment,
      ...conversationEnvironment,
      ...pipecatEnvironment,
    });

    expect(result.success).toBe(true);
  });

  it("rejects every partial retained V8 conversation input group", () => {
    const entries = Object.entries(conversationEnvironment);
    const partialGroups = Array.from({ length: 6 }, (_unused, mask) =>
      Object.fromEntries(entries.filter(
        (_entry, index) => ((mask + 1) & (1 << index)) !== 0,
      ))
    );

    expect(partialGroups.every((partial) =>
      !collectorEnvironmentSchema.safeParse({
        ...requiredEnvironment,
        ...pipecatEnvironment,
        ...partial,
      }).success
    )).toBe(true);
  });

  it("rejects retained V8 conversation input without exact Pipecat revision", () => {
    expect(collectorEnvironmentSchema.safeParse({
      ...requiredEnvironment,
      ...conversationEnvironment,
    }).success).toBe(false);
  });

  it("rejects a complete input group with fewer than six voice captures", () => {
    const result = collectorEnvironmentSchema.safeParse({
      ...requiredEnvironment,
      ...conversationEnvironment,
      ...pipecatEnvironment,
      DISCORD_E2E_CONVERSATION_VOICE_INPUTS: JSON.stringify([
        "/evidence/greeting-ru.json",
        "/evidence/greeting-en.json",
        "/evidence/greeting-unknown.json",
        "/evidence/farewell.json",
        "/evidence/answer.json",
      ]),
    });

    expect(result.success).toBe(false);
  });
});
