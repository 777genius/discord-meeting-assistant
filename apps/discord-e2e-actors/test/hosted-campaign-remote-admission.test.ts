import { describe, expect, it } from "vitest";

import {
  createHostedRemoteReadinessV1,
  evaluateHostedRemoteAdmission,
  type HostedCampaignRemoteAdmissionProbe,
} from "../src/hosted-campaign-remote-admission.js";

const campaignId = "campaign-remote-admission";
const planSha256 = "a".repeat(64);
const meetingPlatformRevision = "b".repeat(40);
const expected = { campaignId, meetingPlatformRevision, planSha256 };
const nowEpochMs = Date.parse("2026-08-13T09:00:00.000Z");
const voicetextCanaryExpectation = {
  binding: {
    campaignId, containerId: "1", fixtureSha256: "1".repeat(64), host: "host",
    imageDigestSha256: "2".repeat(64), planSha256, sourceRevision: meetingPlatformRevision,
    transcriptExpectationSha256: "3".repeat(64),
  },
  endpoint: { batch: { origin: "https://voicetext.test", path: "/batch" },
    live: { origin: "wss://voicetext.test", path: "/live" } },
  maximumCharacterErrorRate: 0.15, maximumTimelineDeltaMs: 250, maximumWordErrorRate: 0.2,
  requiredTermCount: 1, requiredTermsExpectationSha256: "4".repeat(64),
} as const;

describe("hosted campaign remote admission boundary", () => {
  it("fails closed without a trusted remote probe", async () => {
    await expect(evaluateHostedRemoteAdmission(undefined, expected, () => nowEpochMs))
      .resolves.toEqual({
        missingSections: ["deploymentSafety", "discordIdentity", "voicetextCanary", "clockPreflight"],
      });
  });

  it("rejects a reference-only readiness claim even when returned by the trusted probe", async () => {
    const readiness = validReadiness();
    const probe = fakeProbe(readiness);

    await expect(evaluateHostedRemoteAdmission(probe, expected, () => nowEpochMs)).rejects.toThrow();
  });

  it.each([
    ["campaign", { campaignId: "other-campaign" }],
    ["plan", { planSha256: "b".repeat(64) }],
  ])("rejects a receipt bound to another %s", async (_label, change) => {
    const probe = fakeProbe(validReadiness(change));
    await expect(evaluateHostedRemoteAdmission(probe, expected, () => nowEpochMs)).rejects.toThrow();
  });

  it.each([
    ["expired", { expiresAt: "2026-08-13T09:00:00.000Z" }],
    ["future", { probedAt: "2026-08-13T09:00:01.000Z" }],
    ["reversed", { expiresAt: "2026-08-13T08:59:00.000Z" }],
  ])("rejects %s readiness", async (_label, change) => {
    const probe = fakeProbe(validReadiness(change));
    await expect(evaluateHostedRemoteAdmission(probe, expected, () => nowEpochMs)).rejects.toThrow();
  });

  it("rejects tampering and open-ended capability claims", async () => {
    const readiness = validReadiness();
    await expect(evaluateHostedRemoteAdmission(fakeProbe({
      ...readiness,
      capabilities: [{ name: "operator-says-ready" }],
    }), expected, () => nowEpochMs)).rejects.toThrow();
    await expect(evaluateHostedRemoteAdmission(fakeProbe({
      ...readiness,
      discordIdentity: { ...readiness.discordIdentity, receiptSha256: "b".repeat(64) },
    }), expected, () => nowEpochMs)).rejects.toThrow();
  });

  it("propagates cancellation to the trusted remote probe", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const reason = new Error("cancel remote readiness");
    const probe: HostedCampaignRemoteAdmissionProbe = {
      clockPreflightExpectation: { maximumClockSkewBoundMs: 250 },
      inspect: async (_request, signal) => {
        received = signal;
        controller.abort(reason);
        signal?.throwIfAborted();
      },
      voicetextCanaryExpectation,
    };
    await expect(evaluateHostedRemoteAdmission(probe, expected, () => nowEpochMs, controller.signal))
      .rejects.toBe(reason);
    expect(received).toBe(controller.signal);
  });
});

function fakeProbe(value: unknown): HostedCampaignRemoteAdmissionProbe {
  return { clockPreflightExpectation: { maximumClockSkewBoundMs: 250 },
    inspect: async () => value, voicetextCanaryExpectation };
}

function validReadiness(change: Readonly<Record<string, unknown>> = {}) {
  return createHostedRemoteReadinessV1({
    campaignId,
    clockPreflight: { kind: "hosted-clock-preflight-receipt", proofId: "1".repeat(64), schemaVersion: 2 },
    deploymentSafety: {
      ...reference("hosted-deployment-safety", "2"),
      revalidationBaseline: deploymentBaseline(),
    },
    discordIdentity: reference("hosted-discord-identity-receipt", "3"),
    expiresAt: "2026-08-13T09:05:00.000Z",
    kind: "hosted-remote-readiness",
    persistence: "create-only",
    planSha256,
    probedAt: "2026-08-13T08:59:00.000Z",
    schemaVersion: 1,
    voicetextCanary: { ...reference("hosted-voicetext-semantic-canary-receipt", "4"),
      admissionExpectationSha256: "7".repeat(64) },
    ...change,
  });
}

function deploymentBaseline() {
  return { campaignId, deploymentFingerprint: "5".repeat(64), expectationSha256: "6".repeat(64),
    kind: "hosted-deployment-revalidation-baseline" as const, schemaVersion: 1 as const };
}

function reference<const Kind extends "hosted-deployment-safety" | "hosted-discord-identity-receipt" |
"hosted-voicetext-semantic-canary-receipt">(kind: Kind, digit: string) {
  return { kind, receiptSha256: digit.repeat(64), schemaVersion: 1 as const };
}
