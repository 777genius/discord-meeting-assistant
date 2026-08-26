import { describe, expect, it } from "vitest";

import type {
  HostedCampaignBarrierAction,
  HostedCampaignInput,
} from "../src/hosted-campaign-coordinator.js";
import { campaignActions } from "../src/hosted-campaign-execution-graph.js";
import { digestCanonical } from "../src/hosted-campaign-local-admission.js";
import {
  createHostedCampaignPassReceiptV2,
  type HostedCampaignPassReceiptExpectation,
  verifyHostedCampaignPassReceiptV2,
} from "../src/hosted-campaign-pass-receipt.js";
import { HOSTED_CAMPAIGN_TARGET } from "../src/hosted-campaign-target.js";
import { writeCreateOnlyHostedCampaignReceipt } from "../src/run-hosted-campaign.js";

const digest = (character: string): string => character.repeat(64);
const mandatoryArtifactPaths = [
  "campaign-proof.json", "control/campaign-lease-receipt.json", "control/craig-stack-input.json",
  "control/craig-stack-mutation-start.json", "control/craig-stack-receipt.json",
  "greeting-ledger.json", "late-greeting.json",
  "historical-reply.json", "historical-reply-input.json", "live-memory.json", "private-coverage.json",
  "thin-remediation.json", "run-1/evidence.json", "run-2/evidence.json",
  "run-3/evidence.json",
  "run-3/recording-ready.json",
  "run-3/public-reply-effect.arm.json", "run-3/public-reply-effect.triggered.json",
  ...Array.from({ length: 6 }, (_, index) => `run-3/capture-${String(index + 1)}.json`),
];
const plan = (): HostedCampaignInput => ({
  children: [],
  runs: [
    { campaignId: "campaign-1", ordinal: 1, retainedCaptureCount: 0, runId: "run-1", scenario: "sequential" },
    { campaignId: "campaign-1", ordinal: 2, retainedCaptureCount: 0, runId: "run-2", scenario: "overlap" },
    { campaignId: "campaign-1", ordinal: 3, retainedCaptureCount: 6, runId: "run-3", scenario: "reconnect" },
  ],
  target: HOSTED_CAMPAIGN_TARGET,
  thresholds: { answerFirstPacketMilliseconds: 4_000 },
});
const expectation = (): HostedCampaignPassReceiptExpectation => ({
  admissionReceiptSha256: digest("1"),
  artifacts: mandatoryArtifactPaths.map((path) => ({
    byteLength: 1, path, sha256: digest("a"),
  })),
  bindingsSha256: digest("2"),
  campaignLease: { campaignRoot: "/private/evidence/campaigns/campaign-1", device: 1, inode: 2,
    leaseSha256: digest("7"), planSha256: digestCanonical(plan()), receiptSha256: digest("8") },
  craigStack: { projectName: "craig-e2e-1234567890abcdef1234", receiptSha256: digest("6") },
  definitionSha256: digest("3"),
  plan: plan(),
  release: {
    releaseBindingSha256: digest("4"),
    releaseId: "release-1",
    trustRootSha256: digest("5"),
  },
  revisions: {
    craig: "a".repeat(40),
    meetingPlatform: "b".repeat(40),
    pipecat: "c".repeat(40),
    subscriptionRuntime: "d".repeat(40),
  },
});

function evidenceFor(action: HostedCampaignBarrierAction): unknown {
  switch (action.kind) {
    case "provenance-before": case "provenance-after": return { digestSha256: digest("a") };
    case "run-verified": return { ordinal: action.ordinal, runId: action.runId, verified: true };
    case "observer-subscribed": return { authenticatedObserverBotId: "observer-1" };
    case "capture-retained": return { ordinal: action.ordinal, outputPath: "/private/evidence/capture", retained: true };
    case "reconnect-left": case "reconnect-ready": return { observedAtEpochMilliseconds: 1, participantId: "participant-1" };
    case "answer-intent": case "answer-observer-ready": return { observedAtEpochMilliseconds: 1, turnId: "turn-1" };
    case "answer-first-packet": return { answerLatencyMilliseconds: 100, observedAtEpochMilliseconds: 1, turnId: "turn-1" };
    case "service-levels-ready": return { measurementCount: 3, outputPath: "/private/evidence/sla", recordingId: "recording-1", runId: "run-3" };
    case "campaign-verified": return { campaignId: "campaign-1" };
    case "service-level-sources-ready": return { outputPath: "/private/evidence/sources", runId: "run-3", sourcesReady: true };
    case "actor-scenario-playback-completed": return { completed: true };
    case "actor-completed": case "conversation-observer-completed": case "playback-link-seen":
    case "greeting-ledger-ready": case "historical-reply-input-ready":
    case "historical-reply-ready": case "live-memory-ready": case "private-coverage-ready": case "remediation-bundle-ready":
    case "recording-ready": case "replay-attestation-ready": case "supplemental-completed":
      return { completed: true, ordinal: action.ordinal, runId: action.runId };
    default: throw new Error(`Unhandled action: ${JSON.stringify(action)}`);
  }
}

function receipt() {
  const exactPlan = plan();
  return createHostedCampaignPassReceiptV2({
    actionEvidence: campaignActions(exactPlan).map(({ action }) => ({ action, evidence: evidenceFor(action) })),
    campaignId: "campaign-1",
    runIds: ["run-1", "run-2", "run-3"],
    schemaVersion: 1,
    teardownComplete: true,
  }, { ...expectation(), plan: exactPlan });
}

describe("hosted campaign pass receipt", () => {
  it("binds a passing campaign to its exact admission, inputs, revisions, release, actions, and teardown", () => {
    const value = receipt();
    expect(verifyHostedCampaignPassReceiptV2(value, expectation())).toEqual(value);
    expect(value).toMatchObject({
      admission: { receiptSha256: digest("1") },
      bindingsSha256: digest("2"),
      campaignLease: { device: 1, inode: 2, leaseSha256: digest("7") },
      definitionSha256: digest("3"),
      kind: "hosted-campaign-pass-receipt",
      planSha256: digestCanonical(plan()),
      release: { releaseBindingSha256: digest("4"), releaseId: "release-1", trustRootSha256: digest("5") },
      schemaVersion: 2,
      teardown: { campaignLeaseHeldAtVerification: true, childrenStopped: true,
        destructiveTeardownAuthorized: true },
    });
  });

  it("rejects content, evidence, and teardown tampering", () => {
    const value = receipt();
    expect(() => verifyHostedCampaignPassReceiptV2({ ...value, campaignId: "campaign-2" }))
      .toThrow(/digest/u);
    expect(() => verifyHostedCampaignPassReceiptV2({ ...value, teardown: { ...value.teardown, childrenStopped: false } }))
      .toThrow();
    const actionEvidence = value.actionEvidence.map((entry, index) => index === 0
      ? { ...(entry as object), evidence: { digestSha256: digest("b") } } : entry);
    const { receiptSha256: _receiptSha256, ...oldContent } = value;
    const content = { ...oldContent, actionEvidence };
    expect(() => verifyHostedCampaignPassReceiptV2({ ...content, receiptSha256: digestCanonical(content) }))
      .toThrow(/action evidence digest/u);
  });

  it("rejects a re-digested receipt bound to another invocation or an incomplete action graph", () => {
    const value = receipt();
    expect(() => verifyHostedCampaignPassReceiptV2(value, {
      ...expectation(), release: { ...expectation().release, releaseId: "release-2" },
    })).toThrow(/exact invocation/u);
    const { receiptSha256: _receiptSha256, ...oldContent } = value;
    const actionEvidence = value.actionEvidence.slice(0, -1);
    const content = { ...oldContent, actionEvidence, actionEvidenceSha256: digestCanonical(actionEvidence) };
    expect(() => verifyHostedCampaignPassReceiptV2({ ...content, receiptSha256: digestCanonical(content) }, expectation()))
      .toThrow(/every expected action/u);
  });

  it("publishes a verified receipt once without replacing prior evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-pass-receipt-"));
    const path = join(directory, "pass.json");
    const value = receipt();
    await writeCreateOnlyHostedCampaignReceipt(path, value);
    expect(verifyHostedCampaignPassReceiptV2(JSON.parse(await readFile(path, "utf8")), expectation()))
      .toEqual(value);
    await expect(writeCreateOnlyHostedCampaignReceipt(path, value)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
