import { describe, expect, it } from "vitest";

import {
  createHostedRemoteReadinessV1,
  evaluateHostedRemoteAdmission,
  type HostedCampaignRemoteAdmissionProbe,
} from "../src/hosted-campaign-remote-admission.js";

const campaignId = "campaign-remote-admission";
const planSha256 = "a".repeat(64);
const nowEpochMs = Date.parse("2026-08-13T09:00:00.000Z");

describe("hosted campaign remote admission boundary", () => {
  it("fails closed without a trusted remote probe", async () => {
    await expect(evaluateHostedRemoteAdmission(undefined, { campaignId, planSha256 }, nowEpochMs))
      .resolves.toEqual({
        missingSections: ["deploymentSafety", "discordIdentity", "voicetextCanary", "clockPreflight"],
      });
  });

  it("admits an exact digest-bound, live receipt returned by the trusted probe", async () => {
    const readiness = validReadiness();
    const probe = fakeProbe(readiness);

    await expect(evaluateHostedRemoteAdmission(probe, { campaignId, planSha256 }, nowEpochMs))
      .resolves.toEqual({ missingSections: [], readiness });
  });

  it.each([
    ["campaign", { campaignId: "other-campaign" }],
    ["plan", { planSha256: "b".repeat(64) }],
  ])("rejects a receipt bound to another %s", async (_label, change) => {
    const probe = fakeProbe(validReadiness(change));
    await expect(evaluateHostedRemoteAdmission(probe, { campaignId, planSha256 }, nowEpochMs))
      .rejects.toThrow("exact campaign and plan");
  });

  it.each([
    ["expired", { expiresAt: "2026-08-13T09:00:00.000Z" }],
    ["future", { probedAt: "2026-08-13T09:00:01.000Z" }],
    ["reversed", { expiresAt: "2026-08-13T08:59:00.000Z" }],
  ])("rejects %s readiness", async (_label, change) => {
    const probe = fakeProbe(validReadiness(change));
    await expect(evaluateHostedRemoteAdmission(probe, { campaignId, planSha256 }, nowEpochMs))
      .rejects.toThrow("stale, expired, or from the future");
  });

  it("rejects tampering and open-ended capability claims", async () => {
    const readiness = validReadiness();
    await expect(evaluateHostedRemoteAdmission(fakeProbe({
      ...readiness,
      capabilities: [{ name: "operator-says-ready" }],
    }), { campaignId, planSha256 }, nowEpochMs)).rejects.toThrow();
    await expect(evaluateHostedRemoteAdmission(fakeProbe({
      ...readiness,
      discordIdentity: { ...readiness.discordIdentity, receiptSha256: "b".repeat(64) },
    }), { campaignId, planSha256 }, nowEpochMs)).rejects.toThrow("digest is invalid");
  });
});

function fakeProbe(value: unknown): HostedCampaignRemoteAdmissionProbe {
  return { inspect: async () => value };
}

function validReadiness(change: Readonly<Record<string, unknown>> = {}) {
  return createHostedRemoteReadinessV1({
    campaignId,
    clockPreflight: { kind: "hosted-clock-preflight-receipt", proofId: "1".repeat(64), schemaVersion: 2 },
    deploymentSafety: reference("hosted-deployment-safety", "2"),
    discordIdentity: reference("hosted-discord-identity-receipt", "3"),
    expiresAt: "2026-08-13T09:05:00.000Z",
    kind: "hosted-remote-readiness",
    persistence: "create-only",
    planSha256,
    probedAt: "2026-08-13T08:59:00.000Z",
    schemaVersion: 1,
    voicetextCanary: reference("hosted-voicetext-semantic-canary-receipt", "4"),
    ...change,
  });
}

function reference<const Kind extends "hosted-deployment-safety" | "hosted-discord-identity-receipt" |
"hosted-voicetext-semantic-canary-receipt">(kind: Kind, digit: string) {
  return { kind, receiptSha256: digit.repeat(64), schemaVersion: 1 as const };
}
