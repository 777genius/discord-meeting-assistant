import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { z } from "zod";

export const HOSTED_CAMPAIGN_CONTAINER_ROOT = "/run/e2e-campaign" as const;

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const nonceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/u);
const absolutePathSchema = z.string().refine(isSafeAbsolutePath, "Expected a normalized absolute path");

export const hostedCampaignSharedMountExpectationV1Schema = z.object({
  campaignId: identifierSchema,
  containerRoot: z.literal(HOSTED_CAMPAIGN_CONTAINER_ROOT),
  hostRoot: absolutePathSchema,
  maximumAgeMs: z.number().int().min(1_000).max(60_000),
  expectedGid: z.literal(10_001),
  expectedMode: z.literal(0o700),
  expectedUid: z.literal(10_001),
}).strict();

const rootObservationSchema = z.object({
  gid: z.number().int().nonnegative(),
  mode: z.number().int().min(0).max(0o777),
  requestedPath: absolutePathSchema,
  resolvedPath: absolutePathSchema,
  siblingAccessible: z.boolean(),
  symbolicLink: z.boolean(),
  uid: z.number().int().nonnegative(),
}).strict();

const receiptContentSchema = z.object({
  campaignId: identifierSchema,
  containerRoot: z.literal(HOSTED_CAMPAIGN_CONTAINER_ROOT),
  generatedAtEpochMs: z.number().int().nonnegative(),
  hostRoot: absolutePathSchema,
  kind: z.literal("hosted-campaign-shared-mount"),
  probeId: identifierSchema,
  roots: z.object({
    host: rootObservationSchema,
    meetingPlatform: rootObservationSchema,
    runner: rootObservationSchema,
  }).strict(),
  roundTrip: z.object({
    hostNonce: nonceSchema,
    hostObservedPlatformNonce: nonceSchema,
    hostObservedRunnerNonce: nonceSchema,
    platformNonce: nonceSchema,
    platformObservedHostNonce: nonceSchema,
    platformObservedRunnerNonce: nonceSchema,
    runnerNonce: nonceSchema,
    runnerObservedHostNonce: nonceSchema,
    runnerObservedPlatformNonce: nonceSchema,
  }).strict(),
  schemaVersion: z.literal(1),
}).strict();

const receiptSchema = receiptContentSchema.extend({ receiptSha256: z.string().regex(/^[a-f\d]{64}$/u) }).strict();

export type HostedCampaignSharedMountExpectationV1 = z.infer<
  typeof hostedCampaignSharedMountExpectationV1Schema
>;
export type HostedCampaignSharedMountReceiptV1 = z.infer<typeof receiptSchema>;
export type HostedCampaignSharedMountRootObservationV1 = z.infer<typeof rootObservationSchema>;

export interface HostedCampaignSharedMountProbePort {
  readonly inspectHostRoot: (path: string, signal?: AbortSignal) => Promise<unknown>;
  readonly inspectMeetingPlatformRoot: (path: string, signal?: AbortSignal) => Promise<unknown>;
  readonly inspectRunnerRoot: (path: string, signal?: AbortSignal) => Promise<unknown>;
  readonly exchangeNonces: (input: Readonly<{
    hostNonce: string;
    platformNonce: string;
    probeRoot: string;
    runnerNonce: string;
  }>, signal?: AbortSignal) => Promise<unknown>;
}

export interface HostedCampaignSharedMountProbeOptions {
  readonly expectation: HostedCampaignSharedMountExpectationV1;
  readonly generatedAtEpochMs: () => number;
  readonly hostNonce: string;
  readonly platformNonce: string;
  readonly probeId: string;
  readonly runnerNonce: string;
}

/** Coordinates the synthetic-testable contract; concrete Docker/SSH work stays behind the port. */
export class HostedCampaignSharedMountProbe {
  readonly #options: HostedCampaignSharedMountProbeOptions;
  readonly #port: HostedCampaignSharedMountProbePort;

  public constructor(options: HostedCampaignSharedMountProbeOptions, port: HostedCampaignSharedMountProbePort) {
    const expectation = hostedCampaignSharedMountExpectationV1Schema.parse(options.expectation);
    assertDistinct([options.hostNonce, options.platformNonce, options.runnerNonce], "mount probe nonces");
    identifierSchema.parse(options.probeId);
    for (const nonce of [options.hostNonce, options.platformNonce, options.runnerNonce]) {
      nonceSchema.parse(nonce);
    }
    this.#options = { ...options, expectation };
    this.#port = port;
  }

  public async collect(signal?: AbortSignal): Promise<HostedCampaignSharedMountReceiptV1> {
    signal?.throwIfAborted();
    const expected = this.#options.expectation;
    const [host, meetingPlatform, runner] = await Promise.all([
      this.#port.inspectHostRoot(expected.hostRoot, signal),
      this.#port.inspectMeetingPlatformRoot(expected.containerRoot, signal),
      this.#port.inspectRunnerRoot(expected.containerRoot, signal),
    ]);
    const probeRoot = join(expected.containerRoot, expected.campaignId, ".mount-probes", this.#options.probeId);
    const roundTrip = await this.#port.exchangeNonces({
      hostNonce: this.#options.hostNonce,
      platformNonce: this.#options.platformNonce,
      probeRoot,
      runnerNonce: this.#options.runnerNonce,
    }, signal);
    return createHostedCampaignSharedMountReceiptV1({
      expectation: expected,
      generatedAtEpochMs: this.#options.generatedAtEpochMs(),
      probeId: this.#options.probeId,
      roots: { host, meetingPlatform, runner },
      roundTrip,
    });
  }
}

export function createHostedCampaignSharedMountReceiptV1(input: Readonly<{
  expectation: unknown;
  generatedAtEpochMs: number;
  probeId: string;
  roots: Readonly<{ host: unknown; meetingPlatform: unknown; runner: unknown }>;
  roundTrip: unknown;
}>): HostedCampaignSharedMountReceiptV1 {
  const expectation = hostedCampaignSharedMountExpectationV1Schema.parse(input.expectation);
  const content = receiptContentSchema.parse({
    campaignId: expectation.campaignId,
    containerRoot: expectation.containerRoot,
    generatedAtEpochMs: input.generatedAtEpochMs,
    hostRoot: expectation.hostRoot,
    kind: "hosted-campaign-shared-mount",
    probeId: input.probeId,
    roots: input.roots,
    roundTrip: input.roundTrip,
    schemaVersion: 1,
  });
  assertRoot(content.roots.host, expectation.hostRoot, expectation);
  assertRoot(content.roots.meetingPlatform, expectation.containerRoot, expectation);
  assertRoot(content.roots.runner, expectation.containerRoot, expectation);
  assertRoundTrip(content.roundTrip);
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

export function verifyHostedCampaignSharedMountReceiptV1(
  value: unknown,
  expectationValue: unknown,
  nowEpochMs: number,
  expectedProbeId: string,
): HostedCampaignSharedMountReceiptV1 {
  const expectation = hostedCampaignSharedMountExpectationV1Schema.parse(expectationValue);
  const receipt = receiptSchema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Hosted campaign shared mount receipt digest is invalid");
  }
  if (receipt.campaignId !== expectation.campaignId || receipt.hostRoot !== expectation.hostRoot
    || receipt.probeId !== expectedProbeId) {
    throw new Error("Hosted campaign shared mount receipt is replayed or bound to another campaign");
  }
  if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < receipt.generatedAtEpochMs
    || nowEpochMs - receipt.generatedAtEpochMs > expectation.maximumAgeMs) {
    throw new Error("Hosted campaign shared mount receipt is stale or from the future");
  }
  assertRoot(receipt.roots.host, expectation.hostRoot, expectation);
  assertRoot(receipt.roots.meetingPlatform, expectation.containerRoot, expectation);
  assertRoot(receipt.roots.runner, expectation.containerRoot, expectation);
  assertRoundTrip(receipt.roundTrip);
  return Object.freeze(receipt);
}

function assertRoot(
  actual: HostedCampaignSharedMountRootObservationV1,
  expectedPath: string,
  expectation: HostedCampaignSharedMountExpectationV1,
): void {
  if (actual.requestedPath !== expectedPath || actual.resolvedPath !== expectedPath || actual.symbolicLink
    || actual.uid !== expectation.expectedUid || actual.gid !== expectation.expectedGid
    || actual.mode !== expectation.expectedMode || actual.siblingAccessible) {
    throw new Error("Hosted campaign shared mount root violates ownership, mode, or sibling isolation");
  }
}

function assertRoundTrip(value: z.infer<typeof receiptContentSchema>["roundTrip"]): void {
  assertDistinct([value.hostNonce, value.platformNonce, value.runnerNonce], "receipt nonces");
  if (value.platformObservedHostNonce !== value.hostNonce || value.runnerObservedHostNonce !== value.hostNonce
    || value.hostObservedPlatformNonce !== value.platformNonce || value.runnerObservedPlatformNonce !== value.platformNonce
    || value.hostObservedRunnerNonce !== value.runnerNonce || value.platformObservedRunnerNonce !== value.runnerNonce) {
    throw new Error("Hosted campaign shared mount nonce round-trip is invalid or stale");
  }
}

function assertDistinct(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Hosted campaign ${label} must be distinct`);
  }
}

function isSafeAbsolutePath(value: string): boolean {
  return isAbsolute(value) && !value.includes("\0") && normalize(value) === value && resolve(value) === value
    && value !== normalize("/");
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) { return value.map(canonicalize); }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}
