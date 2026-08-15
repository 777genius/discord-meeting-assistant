import { describe, expect, it } from "vitest";

import { collectorEnvironmentSchema } from "../src/e2e-collector-environment.js";

const requiredEnvironment = {
  DISCORD_E2E_ACTOR_RUN_INPUT: "/evidence/actor-run.json",
  DISCORD_E2E_EVIDENCE_OUTPUT: "/evidence/retained.json",
  DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: "a".repeat(40),
  DISCORD_E2E_EXPECTED_MEETING_PLATFORM_SOURCE_REVISION: "b".repeat(40),
  DISCORD_E2E_EXPECTED_SUBSCRIPTION_RUNTIME_SOURCE_REVISION: "c".repeat(40),
  DISCORD_E2E_HOSTED_RELEASE_BINDING_INPUT: "/evidence/release-binding.json",
  DISCORD_E2E_MUTATION_TARGET: "test-only",
  DISCORD_E2E_READY_RECEIPT_INPUT: "/evidence/recording-ready.json",
  DISCORD_E2E_RECORDING_PLAYBACK_READINESS: "already-ready",
  DISCORD_E2E_RECORDING_PLAYBACK_ORIGIN: "https://recordings.example.test",
  DISCORD_E2E_RECORDING_PLAYBACK_TEST_SCOPE: "private-test-deployment",
  DISCORD_E2E_REMOTE_ATTESTATION_FILE: "/tmp/discord-e2e-attestations/run-1.json",
  DISCORD_E2E_REMOTE_COMPOSE_FILE: "/srv/discord-meeting/compose.yaml",
  DISCORD_E2E_REMOTE_CRAIG_PROJECT: "craig-meeting-e2e",
  DISCORD_E2E_REMOTE_CRAIG_SERVICE: "bot",
  DISCORD_E2E_REMOTE_ENV_FILE: "/srv/discord-meeting/source.env",
  DISCORD_E2E_REMOTE_HOST: "test-e2e-host",
  DISCORD_E2E_REMOTE_PROJECT: "discord-meeting-assistant",
  DISCORD_E2E_REMOTE_SOURCE_ROOT: "/srv/discord-meeting/source",
  DISCORD_E2E_RUN_ID: "run-1",
  DISCORD_E2E_SERVICE_LEVEL_THRESHOLDS_INPUT: "/evidence/service-level-thresholds.json",
};
const conversationEnvironment = {
  DISCORD_E2E_BOTIK_SPEAKER_ID: "1534231284467896512",
  DISCORD_E2E_CONVERSATION_CAMPAIGN_PROOF_INPUT: "/evidence/campaign-proof.json",
  DISCORD_E2E_DISCORD_PLAYBACK_LINK_PROOF_INPUT: "/evidence/playback-link-proof.json",
  DISCORD_E2E_CONVERSATION_VOICE_INPUTS: JSON.stringify([
    "/evidence/greeting-ru.json",
    "/evidence/greeting-en.json",
    "/evidence/greeting-unknown.json",
    "/evidence/greeting-speaker-d.json",
    "/evidence/answer.json",
    "/evidence/farewell.json",
  ]),
  DISCORD_E2E_SERVICE_LEVELS_INPUT: "/evidence/service-levels.json",
  DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_INPUT: "/evidence/speaker-d.json",
};
const pipecatEnvironment = {
  DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: "d".repeat(40),
};

describe("collectorEnvironmentSchema", () => {
  it.each(Object.keys(requiredEnvironment).filter((name) =>
    name.startsWith("DISCORD_E2E_REMOTE_") || name === "DISCORD_E2E_MUTATION_TARGET"
  ))("rejects an omitted explicit target coordinate %s", (name) => {
    const unsafeDefaults = Object.fromEntries(
      Object.entries(requiredEnvironment).filter(([entryName]) => entryName !== name),
    );

    expect(collectorEnvironmentSchema.safeParse(unsafeDefaults).success).toBe(false);
  });

  it("rejects a non-allowlisted Compose project", () => {
    expect(collectorEnvironmentSchema.safeParse({
      ...requiredEnvironment,
      DISCORD_E2E_REMOTE_PROJECT: "production-meetings",
    }).success).toBe(false);
  });

  it.each([
    ["DISCORD_E2E_MUTATION_TARGET", "production"],
    ["DISCORD_E2E_REMOTE_CRAIG_PROJECT", "craig-production"],
    ["DISCORD_E2E_REMOTE_ATTESTATION_FILE", "/srv/e2e/attestation.json"],
  ])("rejects unsafe %s", (name, value) => {
    expect(collectorEnvironmentSchema.safeParse({
      ...requiredEnvironment,
      [name]: value,
    }).success).toBe(false);
  });

  it("accepts a post-call campaign without conversation evidence", () => {
    expect(collectorEnvironmentSchema.safeParse(requiredEnvironment).success).toBe(true);
  });

  it.each([
    ["too short", "abc"],
    ["uppercase", "A".repeat(40)],
    ["non-hex", "z".repeat(40)],
  ])("rejects an invalid source revision before collection: %s", (_description, revision) => {
    expect(collectorEnvironmentSchema.safeParse({
      ...requiredEnvironment,
      DISCORD_E2E_EXPECTED_CRAIG_SOURCE_REVISION: revision,
    }).success).toBe(false);
  });

  it("accepts the complete retained V10 conversation input group", () => {
    const result = collectorEnvironmentSchema.safeParse({
      ...requiredEnvironment,
      ...conversationEnvironment,
      ...pipecatEnvironment,
    });

    expect(result.success).toBe(true);
  });

  it("rejects every partial retained V10 conversation input group", () => {
    const entries = Object.entries(conversationEnvironment);
    const partialGroups = entries.map((_, omittedIndex) =>
      Object.fromEntries(entries.filter((_entry, index) => index !== omittedIndex))
    );

    expect(partialGroups.every((partial) =>
      !collectorEnvironmentSchema.safeParse({
        ...requiredEnvironment,
        ...pipecatEnvironment,
        ...partial,
      }).success
    )).toBe(true);
  });

  it("rejects retained V10 conversation input without exact Pipecat revision", () => {
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
