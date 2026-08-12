import { z } from "zod";

import { serviceLevelEvidenceDigest } from "./service-level-attestation-integrity.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-coordinator.js";

const HOSTED_CLOCK_METHOD_V2 = "ssh-bracketed-clock-v2" as const;
const admissionValidityMs = 60_000;
const wallClockResolutionMs = 2;
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const safeNonnegativeInteger = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 0,
  "Expected a nonnegative safe integer",
);
const monotonicNanoseconds = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const targetSchema = z.object({
  environment: z.literal(HOSTED_CAMPAIGN_TARGET.environment),
  host: z.literal(HOSTED_CAMPAIGN_TARGET.host),
  project: z.literal(HOSTED_CAMPAIGN_TARGET.project),
}).strict();
const sampleSchema = z.object({
  bootId: identifier,
  epochMs: safeNonnegativeInteger,
  monotonicNs: monotonicNanoseconds,
}).strict();
const exchangeSchema = z.object({
  observer: z.object({ after: sampleSchema, before: sampleSchema }).strict(),
  observerClockId: identifier,
  source: z.object({ after: sampleSchema, before: sampleSchema, sample: sampleSchema }).strict(),
  sourceClockId: identifier,
  target: targetSchema,
}).strict();

export type HostedClockExchangeV2 = z.infer<typeof exchangeSchema>;

const derivedExchangeShape = {
  clockSkewBoundMs: safeNonnegativeInteger,
  observerEvidenceSha256: sha256,
  raw: exchangeSchema,
  roundTripTimeMs: safeNonnegativeInteger,
  sourceEvidenceSha256: sha256,
};

export const hostedClockPreflightReceiptV2Schema = z.object({
  ...derivedExchangeShape,
  kind: z.literal("hosted-clock-preflight-receipt"),
  method: z.literal(HOSTED_CLOCK_METHOD_V2),
  proofId: sha256,
  qualifiedAtEpochMs: safeNonnegativeInteger,
  schemaVersion: z.literal(2),
  validFromEpochMs: safeNonnegativeInteger,
  validUntilEpochMs: safeNonnegativeInteger,
}).strict().superRefine((receipt, context) => {
  addDerivationIssues(receipt, deriveExchange(receipt.raw), context);
  if (receipt.qualifiedAtEpochMs !== receipt.raw.observer.after.epochMs ||
    receipt.validFromEpochMs !== receipt.raw.observer.before.epochMs ||
    receipt.validUntilEpochMs !== receipt.qualifiedAtEpochMs + admissionValidityMs) {
    context.addIssue({ code: "custom", message: "Clock preflight validity is not derived from raw samples" });
  }
  const { proofId: omitted, ...content } = receipt;
  void omitted;
  if (receipt.proofId !== serviceLevelEvidenceDigest(content)) {
    context.addIssue({ code: "custom", message: "Clock preflight proof digest is invalid" });
  }
});

export type HostedClockPreflightReceiptV2 = z.infer<typeof hostedClockPreflightReceiptV2Schema>;

const completionExchangeSchema = z.object({
  ...derivedExchangeShape,
  proofId: sha256,
}).strict().superRefine((proof, context) => {
  addDerivationIssues(proof, deriveExchange(proof.raw), context);
  const { proofId: omitted, ...content } = proof;
  void omitted;
  if (proof.proofId !== serviceLevelEvidenceDigest(content)) {
    context.addIssue({ code: "custom", message: "Completion clock proof digest is invalid" });
  }
});

export const hostedClockRunBindingV2Schema = z.object({
  admission: hostedClockPreflightReceiptV2Schema,
  completion: completionExchangeSchema,
  kind: z.literal("hosted-clock-run-binding"),
  meetingId: identifier,
  method: z.literal(HOSTED_CLOCK_METHOD_V2),
  proofId: sha256,
  recordingId: identifier,
  runId: identifier,
  schemaVersion: z.literal(2),
}).strict().superRefine((binding, context) => {
  if (!sameClockAcrossRun(binding.admission.raw, binding.completion.raw)) {
    context.addIssue({ code: "custom", message: "Clock or boot identity changed during the hosted run" });
  } else {
    for (const side of ["observer", "source"] as const) {
      addWallClockContinuityIssue(
        lastSample(binding.admission.raw, side), firstSample(binding.completion.raw, side), context,
      );
    }
  }
  const { proofId: omitted, ...content } = binding;
  void omitted;
  if (binding.proofId !== serviceLevelEvidenceDigest(content)) {
    context.addIssue({ code: "custom", message: "Clock run binding digest is invalid" });
  }
});

export type HostedClockRunBindingV2 = z.infer<typeof hostedClockRunBindingV2Schema>;

export function deriveHostedClockPreflightReceiptV2(rawValue: unknown): HostedClockPreflightReceiptV2 {
  const raw = exchangeSchema.parse(rawValue);
  const derived = deriveExchange(raw);
  const content = {
    ...derived, kind: "hosted-clock-preflight-receipt" as const, method: HOSTED_CLOCK_METHOD_V2,
    qualifiedAtEpochMs: raw.observer.after.epochMs, raw, schemaVersion: 2 as const,
    validFromEpochMs: raw.observer.before.epochMs,
    validUntilEpochMs: raw.observer.after.epochMs + admissionValidityMs,
  };
  return hostedClockPreflightReceiptV2Schema.parse({
    ...content, proofId: serviceLevelEvidenceDigest(content),
  });
}

export function bindHostedClockRunV2(input: {
  readonly admission: unknown;
  readonly completion: unknown;
  readonly meetingId: string;
  readonly recordingId: string;
  readonly runId: string;
}): HostedClockRunBindingV2 {
  const admission = hostedClockPreflightReceiptV2Schema.parse(input.admission);
  const raw = exchangeSchema.parse(input.completion);
  const derived = deriveExchange(raw);
  const completionContent = { ...derived, raw };
  const completion = completionExchangeSchema.parse({
    ...completionContent, proofId: serviceLevelEvidenceDigest(completionContent),
  });
  const content = {
    admission, completion, kind: "hosted-clock-run-binding" as const,
    meetingId: input.meetingId, method: HOSTED_CLOCK_METHOD_V2,
    recordingId: input.recordingId, runId: input.runId, schemaVersion: 2 as const,
  };
  return hostedClockRunBindingV2Schema.parse({ ...content, proofId: serviceLevelEvidenceDigest(content) });
}

export function hostedClockRunSkewBoundMs(bindingValue: unknown): number {
  const binding = hostedClockRunBindingV2Schema.parse(bindingValue);
  return Math.max(binding.admission.clockSkewBoundMs, binding.completion.clockSkewBoundMs);
}

function deriveExchange(raw: HostedClockExchangeV2) {
  assertSampleSequence(raw.observer.before, raw.observer.after, "observer");
  assertSampleSequence(raw.source.before, raw.source.sample, "source");
  assertSampleSequence(raw.source.sample, raw.source.after, "source");
  const roundTripTimeMs = ceilNanosecondsToMilliseconds(
    BigInt(raw.observer.after.monotonicNs) - BigInt(raw.observer.before.monotonicNs),
  );
  const observerEpochs = [raw.observer.before.epochMs, raw.observer.after.epochMs];
  const sourceEpochs = [raw.source.before.epochMs, raw.source.sample.epochMs, raw.source.after.epochMs];
  const clockSkewBoundMs = Math.max(...observerEpochs.flatMap(
    (observerEpoch) => sourceEpochs.map((sourceEpoch) => Math.abs(sourceEpoch - observerEpoch)),
  ));
  return {
    clockSkewBoundMs,
    observerEvidenceSha256: serviceLevelEvidenceDigest(raw.observer),
    roundTripTimeMs,
    sourceEvidenceSha256: serviceLevelEvidenceDigest(raw.source),
  };
}

function assertSampleSequence(before: z.infer<typeof sampleSchema>, after: z.infer<typeof sampleSchema>, label: string) {
  if (before.bootId !== after.bootId) {
    throw new Error(`${label} boot identity changed inside a clock bracket`);
  }
  const monotonicDeltaNs = BigInt(after.monotonicNs) - BigInt(before.monotonicNs);
  if (monotonicDeltaNs < 0n || after.epochMs < before.epochMs) {
    throw new Error(`${label} clock moved backwards inside a clock bracket`);
  }
  const epochDeltaMs = after.epochMs - before.epochMs;
  const monotonicDeltaMs = Number(monotonicDeltaNs) / 1_000_000;
  if (Math.abs(epochDeltaMs - monotonicDeltaMs) > wallClockResolutionMs) {
    throw new Error(`${label} wall clock stepped relative to its monotonic clock`);
  }
}

function addDerivationIssues(actual: { readonly clockSkewBoundMs: number; readonly observerEvidenceSha256: string;
  readonly roundTripTimeMs: number; readonly sourceEvidenceSha256: string }, expected: ReturnType<typeof deriveExchange>,
context: z.RefinementCtx) {
  for (const key of ["clockSkewBoundMs", "observerEvidenceSha256", "roundTripTimeMs", "sourceEvidenceSha256"] as const) {
    if (actual[key] !== expected[key]) {
      context.addIssue({ code: "custom", message: `Clock ${key} is not derived from raw samples` });
    }
  }
}

function sameClockAcrossRun(admission: HostedClockExchangeV2, completion: HostedClockExchangeV2): boolean {
  return admission.observerClockId === completion.observerClockId &&
    admission.sourceClockId === completion.sourceClockId &&
    admission.observer.before.bootId === completion.observer.before.bootId &&
    admission.source.before.bootId === completion.source.before.bootId &&
    serviceLevelEvidenceDigest(admission.target) === serviceLevelEvidenceDigest(completion.target);
}

function firstSample(raw: HostedClockExchangeV2, side: "observer" | "source") {
  return side === "observer" ? raw.observer.before : raw.source.before;
}

function lastSample(raw: HostedClockExchangeV2, side: "observer" | "source") {
  return side === "observer" ? raw.observer.after : raw.source.after;
}

function addWallClockContinuityIssue(before: z.infer<typeof sampleSchema>, after: z.infer<typeof sampleSchema>,
context: z.RefinementCtx): void {
  try {
    assertSampleSequence(before, after, "run");
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Clock continuity failed" });
  }
}

function ceilNanosecondsToMilliseconds(nanoseconds: bigint): number {
  return Number((nanoseconds + 999_999n) / 1_000_000n);
}
