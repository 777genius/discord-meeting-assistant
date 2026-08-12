import { describe, expect, it } from "vitest";

import {
  bindHostedClockRunV2,
  deriveHostedClockPreflightReceiptV2,
  hostedClockPreflightReceiptV2Schema,
  hostedClockRunSkewBoundMs,
} from "../src/hosted-clock-proof-v2.js";

describe("hosted bracketed clock V2 proof", () => {
  it("derives RTT, skew, raw evidence digests, validity and a stable proof ID", () => {
    const receipt = deriveHostedClockPreflightReceiptV2(exchange());
    const expectedSkewBoundMs = Math.max(
      Math.abs(1_005 - 1_000), Math.abs(1_007 - 1_000), Math.abs(1_008 - 1_000),
      Math.abs(1_005 - 1_010), Math.abs(1_007 - 1_010), Math.abs(1_008 - 1_010),
    );

    expect(receipt).toMatchObject({
      clockSkewBoundMs: expectedSkewBoundMs,
      method: "ssh-bracketed-clock-v2",
      qualifiedAtEpochMs: 1_010,
      roundTripTimeMs: 10,
      schemaVersion: 2,
      validFromEpochMs: 1_000,
      validUntilEpochMs: 61_010,
    });
    expect(receipt.observerEvidenceSha256).toMatch(/^[a-f\d]{64}$/u);
    expect(receipt.sourceEvidenceSha256).toMatch(/^[a-f\d]{64}$/u);
    expect(deriveHostedClockPreflightReceiptV2(exchange())).toEqual(receipt);
  });

  it("does not accept arbitrary V1 preflight content as V2", () => {
    expect(hostedClockPreflightReceiptV2Schema.safeParse({
      artifactId: "a".repeat(64), clockSkewBoundMs: 0, schemaVersion: 1,
    }).success).toBe(false);
  });

  it.each([
    ["observer reboot", { observerAfterBootId: "observer-boot-2" }, "boot identity changed"],
    ["source reboot", { sourceSampleBootId: "source-boot-2" }, "boot identity changed"],
    ["observer monotonic rollback", { observerAfterMonotonicNs: "999000000" }, "moved backwards"],
    ["source epoch rollback", { sourceAfterEpochMs: 1_004 }, "moved backwards"],
    ["observer wall step", { observerAfterEpochMs: 1_020 }, "wall clock stepped"],
    ["source wall step", { sourceAfterEpochMs: 1_020 }, "wall clock stepped"],
  ])("rejects %s inside a raw bracket", (_label, overrides, message) => {
    expect(() => deriveHostedClockPreflightReceiptV2(exchange(overrides))).toThrow(message);
  });

  it("rejects tampered derived values and raw evidence under an old proof ID", () => {
    const receipt = deriveHostedClockPreflightReceiptV2(exchange());
    expect(hostedClockPreflightReceiptV2Schema.safeParse({
      ...receipt, clockSkewBoundMs: receipt.clockSkewBoundMs + 1,
    }).success).toBe(false);
    expect(hostedClockPreflightReceiptV2Schema.safeParse({
      ...receipt,
      raw: { ...receipt.raw, observerClockId: "other-observer" },
    }).success).toBe(false);
  });

  it("binds admission to a later post-call run, meeting and recording proof", () => {
    const admission = deriveHostedClockPreflightReceiptV2(exchange());
    const binding = bindHostedClockRunV2({
      admission, completion: exchange({ baseEpochMs: 11_000, baseMonotonicNs: 11_000_000_000n }),
      meetingId: "meeting-1", recordingId: "recording-1", runId: "run-1",
    });

    expect(binding).toMatchObject({
      meetingId: "meeting-1", method: "ssh-bracketed-clock-v2",
      recordingId: "recording-1", runId: "run-1", schemaVersion: 2,
    });
    expect(hostedClockRunSkewBoundMs(binding)).toBe(Math.max(
      binding.admission.clockSkewBoundMs, binding.completion.clockSkewBoundMs,
    ));
  });

  it("rejects boot changes and wall-clock steps between admission and completion", () => {
    const admission = deriveHostedClockPreflightReceiptV2(exchange());
    expect(() => bindHostedClockRunV2({
      admission, completion: exchange({ baseEpochMs: 11_000, baseMonotonicNs: 11_000_000_000n,
        observerBeforeBootId: "observer-boot-2" }),
      meetingId: "meeting-1", recordingId: "recording-1", runId: "run-1",
    })).toThrow("boot identity changed");
    expect(() => bindHostedClockRunV2({
      admission, completion: exchange({ baseEpochMs: 12_000, baseMonotonicNs: 11_000_000_000n }),
      meetingId: "meeting-1", recordingId: "recording-1", runId: "run-1",
    })).toThrow("wall clock stepped");
  });

  it("produces distinct proof IDs when run binding identity changes", () => {
    const admission = deriveHostedClockPreflightReceiptV2(exchange());
    const completion = exchange({ baseEpochMs: 11_000, baseMonotonicNs: 11_000_000_000n });
    const left = bindHostedClockRunV2({
      admission, completion, meetingId: "meeting-1", recordingId: "recording-1", runId: "run-1",
    });
    const right = bindHostedClockRunV2({
      admission, completion, meetingId: "meeting-1", recordingId: "recording-1", runId: "run-2",
    });
    expect(left.proofId).not.toBe(right.proofId);
  });
});

interface ExchangeOverrides {
  readonly baseEpochMs?: number;
  readonly baseMonotonicNs?: bigint;
  readonly observerAfterBootId?: string;
  readonly observerAfterEpochMs?: number;
  readonly observerAfterMonotonicNs?: string;
  readonly observerBeforeBootId?: string;
  readonly sourceAfterEpochMs?: number;
  readonly sourceSampleBootId?: string;
}

function exchange(overrides: ExchangeOverrides = {}) {
  const epoch = overrides.baseEpochMs ?? 1_000;
  const monotonic = overrides.baseMonotonicNs ?? 1_000_000_000n;
  const observerBootId = overrides.observerBeforeBootId ?? "observer-boot-1";
  return {
    observer: {
      after: {
        bootId: overrides.observerAfterBootId ?? observerBootId,
        epochMs: overrides.observerAfterEpochMs ?? epoch + 10,
        monotonicNs: overrides.observerAfterMonotonicNs ?? String(monotonic + 10_000_000n),
      },
      before: { bootId: observerBootId, epochMs: epoch, monotonicNs: String(monotonic) },
    },
    observerClockId: "observer-clock",
    source: {
      after: {
        bootId: "source-boot-1", epochMs: overrides.sourceAfterEpochMs ?? epoch + 8,
        monotonicNs: String(monotonic + 8_000_000n),
      },
      before: { bootId: "source-boot-1", epochMs: epoch + 5, monotonicNs: String(monotonic + 5_000_000n) },
      sample: {
        bootId: overrides.sourceSampleBootId ?? "source-boot-1",
        epochMs: epoch + 7, monotonicNs: String(monotonic + 7_000_000n),
      },
    },
    sourceClockId: "source-clock",
    target: {
      environment: "private-test-guild" as const,
      host: "codex-workers-eu-01" as const,
      project: "discord-meeting-assistant" as const,
    },
  };
}
