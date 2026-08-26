import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const containerIdSchema = z.string().regex(/^[a-f\d]{64}$/u);
const imageIdSchema = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const repositoryDigestSchema = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const safeIdentifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const base64Schema = z.string().regex(/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u);
const absolutePathSchema = z.string().refine(isSafeAbsolutePath, "Expected a normalized absolute path");
const linuxInterfaceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$/u);
const iptablesChainSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,27}$/u);
const ipv4Schema = z.string().refine((value) => {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet)
    && Number(octet) <= 255 && (octet === "0" || !octet.startsWith("0")));
}, "Expected a canonical IPv4 address");

const componentSchema = z.enum([
  "craig",
  "meetingPlatform",
  "pipecat",
  "subscriptionRuntime",
]);

const serviceSnapshotSchema = z.object({
  commandSha256: sha256Schema,
  component: componentSchema,
  composeConfigHash: sha256Schema,
  composeProject: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  composeService: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  containerId: containerIdSchema,
  containerStartedAt: z.iso.datetime(),
  imageId: imageIdSchema,
  networks: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/u)).min(1),
  publishedPorts: z.array(z.never()).max(0),
  repositoryDigest: repositoryDigestSchema,
  sourceRevision: sourceRevisionSchema,
  testOnly: z.literal("true"),
}).strict();

const rootResolutionSchema = z.object({
  kind: z.literal("directory"),
  requestedPath: absolutePathSchema,
  resolvedPath: absolutePathSchema,
  symbolicLink: z.literal(false),
}).strict();

const campaignRootSnapshotSchema = z.object({
  campaignEntryKind: z.literal("directory"),
  campaignEntrySymbolicLink: z.literal(false),
  entriesBase64: z.array(base64Schema).length(1),
  gid: z.number().int().nonnegative(),
  linkCount: z.number().int().min(2),
  mode: z.literal("0700"),
  requestedPath: absolutePathSchema,
  resolvedPath: absolutePathSchema,
  symbolicLink: z.literal(false),
  uid: z.number().int().nonnegative(),
}).strict();

const greetingMountSchema = z.object({
  containerGid: z.literal(10_001),
  containerUid: z.literal(10_001),
  destinationPath: absolutePathSchema,
  destinationSymbolicLink: z.literal(false),
  environmentRoot: absolutePathSchema,
  observerRoot: absolutePathSchema,
  readOnly: z.literal(false),
  runRoot: absolutePathSchema,
  sourcePath: absolutePathSchema,
  sourceSymbolicLink: z.literal(false),
}).strict();

const mountIsolationSchema = z.object({
  campaignSiblingAccessible: z.literal(false),
  campaignSiblingMounted: z.literal(false),
  campaignSiblingPath: absolutePathSchema,
  runSiblingAccessible: z.literal(true),
  runSiblingMounted: z.literal(false),
  runSiblingPath: absolutePathSchema,
}).strict();

const roundTripSchema = z.object({
  containerObservedHostNonce: safeIdentifierSchema,
  containerWrittenNonce: safeIdentifierSchema,
  hostObservedContainerNonce: safeIdentifierSchema,
  hostWrittenNonce: safeIdentifierSchema,
  probeRoot: absolutePathSchema,
}).strict();

const deploymentSafetyEvidenceSchema = z.object({
  campaignRoot: campaignRootSnapshotSchema,
  campaignRootAfter: campaignRootSnapshotSchema,
  greetingMountAfter: greetingMountSchema,
  greetingMount: greetingMountSchema,
  mountIsolation: mountIsolationSchema,
  mountIsolationAfter: mountIsolationSchema,
  roots: z.object({ deploy: rootResolutionSchema, source: rootResolutionSchema }).strict(),
  rootsAfter: z.object({ deploy: rootResolutionSchema, source: rootResolutionSchema }).strict(),
  roundTrip: roundTripSchema,
  craigNetworkAfter: z.lazy(() => craigNetworkProofSchema),
  craigNetworkBefore: z.lazy(() => craigNetworkProofSchema),
  servicesAfter: z.array(serviceSnapshotSchema).length(4),
  servicesBefore: z.array(serviceSnapshotSchema).length(4),
}).strict();

export const hostedCraigNetworkPolicyV1Schema = z.object({
  bridgeInterface: linuxInterfaceSchema,
  chain: iptablesChainSchema,
  databaseIpv4: ipv4Schema,
  inputChain: iptablesChainSchema,
  networkName: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/u),
  projectName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
  tcpDestinationPort: z.literal(443),
  udpDestinationPorts: z.object({ end: z.number().int().min(1).max(65_535),
    start: z.number().int().min(1).max(65_535) }).strict()
    .refine(({ end, start }) => end >= start, "UDP destination port range is inverted"),
}).strict();

const craigNetworkProofSchema = hostedCraigNetworkPolicyV1Schema.extend({
  containerId: containerIdSchema,
  containerIpv4: ipv4Schema,
  networkId: sha256Schema,
  semanticPolicySha256: sha256Schema,
}).strict();

export const hostedDeploymentSafetyExpectationV1Schema = z.object({
  allowedNetworks: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/u)).min(1),
  campaignId: safeIdentifierSchema,
  campaignRoot: absolutePathSchema,
  campaignRootOwnerGid: z.literal(10_001),
  campaignRootOwnerUid: z.literal(10_001),
  craigNetworkPolicy: hostedCraigNetworkPolicyV1Schema,
  deployRoot: absolutePathSchema,
  greeting: z.object({
    campaignSiblingPath: absolutePathSchema,
    destinationPath: absolutePathSchema,
    environmentRoot: absolutePathSchema,
    observerRoot: absolutePathSchema,
    runRoot: absolutePathSchema,
    runSiblingPath: absolutePathSchema,
    sourcePath: absolutePathSchema,
  }).strict(),
  services: z.array(z.object({
    component: componentSchema,
    composeProject: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
    composeService: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u),
    containerId: containerIdSchema,
    imageId: imageIdSchema,
    repositoryDigest: repositoryDigestSchema,
    sourceRevision: sourceRevisionSchema,
  }).strict()).length(4),
  sourceRoot: absolutePathSchema,
}).strict();

const receiptContentSchema = z.object({
  campaignId: safeIdentifierSchema,
  deploymentFingerprint: sha256Schema,
  expectationSha256: sha256Schema,
  generatedAt: z.iso.datetime(),
  kind: z.literal("hosted-deployment-safety"),
  schemaVersion: z.literal(2),
}).strict();

const hostedDeploymentSafetyReceiptV1Schema = receiptContentSchema.extend({
  receiptSha256: sha256Schema,
}).strict();

export type HostedDeploymentSafetyExpectationV1 = z.infer<
  typeof hostedDeploymentSafetyExpectationV1Schema
>;
export type HostedDeploymentSafetyReceiptV1 = z.infer<typeof hostedDeploymentSafetyReceiptV1Schema>;

export interface CreateHostedDeploymentSafetyReceiptV1Input {
  readonly evidence: unknown;
  readonly expectation: unknown;
  readonly generatedAt: string;
}

export function createHostedDeploymentSafetyReceiptV1(
  input: CreateHostedDeploymentSafetyReceiptV1Input,
): HostedDeploymentSafetyReceiptV1 {
  const expectation = hostedDeploymentSafetyExpectationV1Schema.parse(input.expectation);
  const evidence = deploymentSafetyEvidenceSchema.parse(input.evidence);
  assertUniqueComponents(expectation.services, "expectation");
  assertUniqueComponents(evidence.servicesBefore, "before snapshot");
  assertUniqueComponents(evidence.servicesAfter, "after snapshot");
  assertCampaignRoot(evidence, expectation);
  assertCraigNetwork(evidence, expectation);
  assertRoots(evidence, expectation);
  assertServices(evidence, expectation);
  assertGreetingMount(evidence, expectation);
  assertRoundTrip(evidence, expectation);
  const deploymentFingerprint = digestCanonical({
    campaignRoot: evidence.campaignRoot,
    craigNetwork: evidence.craigNetworkAfter,
    greetingMount: evidence.greetingMount,
    mountIsolation: evidence.mountIsolation,
    roots: evidence.roots,
    services: sortByComponent(evidence.servicesAfter),
  });
  const content = receiptContentSchema.parse({
    campaignId: expectation.campaignId,
    deploymentFingerprint,
    expectationSha256: digestCanonical(expectation),
    generatedAt: input.generatedAt,
    kind: "hosted-deployment-safety",
    schemaVersion: 2,
  });
  return Object.freeze({ ...content, receiptSha256: digestCanonical(content) });
}

function assertCraigNetwork(
  evidence: z.infer<typeof deploymentSafetyEvidenceSchema>,
  expectation: HostedDeploymentSafetyExpectationV1,
): void {
  if (digestCanonical(evidence.craigNetworkBefore)
    !== digestCanonical(evidence.craigNetworkAfter)) {
    throw new Error("Hosted Craig network policy changed while safety evidence was collected");
  }
  const craig = expectation.services.find(({ component }) => component === "craig");
  if (craig === undefined) {
    throw new Error("Hosted deployment expectation has no Craig service");
  }
  const actual = evidence.craigNetworkAfter;
  const expected = expectation.craigNetworkPolicy;
  if (actual.containerId !== craig.containerId
    || actual.bridgeInterface !== expected.bridgeInterface
    || actual.chain !== expected.chain
    || actual.databaseIpv4 !== expected.databaseIpv4
    || actual.networkName !== expected.networkName
    || actual.projectName !== expected.projectName
    || actual.udpDestinationPorts.start !== expected.udpDestinationPorts.start
    || actual.udpDestinationPorts.end !== expected.udpDestinationPorts.end) {
    throw new Error("Hosted Craig network proof does not match the exact release policy");
  }
}

function assertCampaignRoot(
  evidence: z.infer<typeof deploymentSafetyEvidenceSchema>,
  expectation: HostedDeploymentSafetyExpectationV1,
): void {
  if (digestCanonical(evidence.campaignRoot) !== digestCanonical(evidence.campaignRootAfter)) {
    throw new Error("Hosted campaign root changed while safety evidence was collected");
  }
  const root = evidence.campaignRoot;
  if (root.requestedPath !== expectation.campaignRoot
    || root.resolvedPath !== expectation.campaignRoot
    || root.uid !== expectation.campaignRootOwnerUid
    || root.gid !== expectation.campaignRootOwnerGid
    || root.linkCount !== 3
    || root.entriesBase64[0] !== Buffer.from(expectation.campaignId).toString("base64")) {
    throw new Error("Hosted campaign root is not the exact private single-campaign wrapper");
  }
}

export function verifyHostedDeploymentSafetyReceiptV1(
  value: unknown,
): HostedDeploymentSafetyReceiptV1 {
  const receipt = hostedDeploymentSafetyReceiptV1Schema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestCanonical(content) !== receiptSha256) {
    throw new Error("Hosted deployment safety receipt digest is invalid");
  }
  return Object.freeze(receipt);
}

export function assertHostedDeploymentSafetyRevalidatedV1(
  admittedValue: unknown,
  revalidatedValue: unknown,
): HostedDeploymentSafetyReceiptV1 {
  const admitted = verifyHostedDeploymentSafetyReceiptV1(admittedValue);
  const revalidated = verifyHostedDeploymentSafetyReceiptV1(revalidatedValue);
  if (admitted.campaignId !== revalidated.campaignId
    || admitted.deploymentFingerprint !== revalidated.deploymentFingerprint) {
    throw new Error("Hosted deployment changed after safety admission");
  }
  return revalidated;
}

function assertRoots(
  evidence: z.infer<typeof deploymentSafetyEvidenceSchema>,
  expectation: HostedDeploymentSafetyExpectationV1,
): void {
  if (digestCanonical(evidence.roots) !== digestCanonical(evidence.rootsAfter)) {
    throw new Error("Hosted deployment roots changed while safety evidence was collected");
  }
  for (const [name, root, expectedPath] of [
    ["deploy", evidence.roots.deploy, expectation.deployRoot],
    ["source", evidence.roots.source, expectation.sourceRoot],
  ] as const) {
    if (root.requestedPath !== expectedPath || root.resolvedPath !== expectedPath) {
      throw new Error(`Hosted ${name} root does not resolve to the pinned path`);
    }
  }
  if (!isInside(expectation.deployRoot, expectation.sourceRoot)) {
    throw new Error("Hosted source root must be inside the pinned deploy root");
  }
}

function assertServices(
  evidence: z.infer<typeof deploymentSafetyEvidenceSchema>,
  expectation: HostedDeploymentSafetyExpectationV1,
): void {
  const before = sortByComponent(evidence.servicesBefore);
  const after = sortByComponent(evidence.servicesAfter);
  if (digestCanonical(before) !== digestCanonical(after)) {
    throw new Error("Hosted deployment changed while safety evidence was collected");
  }
  const expectedServices = new Map(expectation.services.map((service) => [service.component, service]));
  const allowedNetworks = new Set(expectation.allowedNetworks);
  for (const actual of after) {
    const expected = expectedServices.get(actual.component);
    if (expected === undefined || actual.composeProject !== expected.composeProject
      || actual.composeService !== expected.composeService
      || actual.containerId !== expected.containerId
      || actual.imageId !== expected.imageId
      || actual.repositoryDigest !== expected.repositoryDigest
      || actual.sourceRevision !== expected.sourceRevision) {
      throw new Error(`Hosted ${actual.component} service identity does not match the release plan`);
    }
    if (actual.networks.some((network) => !allowedNetworks.has(network))) {
      throw new Error(`Hosted ${actual.component} uses a network outside the test allowlist`);
    }
  }
}

function assertGreetingMount(
  evidence: z.infer<typeof deploymentSafetyEvidenceSchema>,
  expectation: HostedDeploymentSafetyExpectationV1,
): void {
  const expected = { ...expectation.greeting };
  const actual = evidence.greetingMount;
  if (digestCanonical(actual) !== digestCanonical(evidence.greetingMountAfter)) {
    throw new Error("Hosted greeting mount changed while safety evidence was collected");
  }
  if (digestCanonical(evidence.mountIsolation) !== digestCanonical(evidence.mountIsolationAfter)) {
    throw new Error("Hosted greeting mount isolation changed while safety evidence was collected");
  }
  if (actual.sourcePath !== expected.sourcePath
    || actual.destinationPath !== expected.destinationPath
    || actual.environmentRoot !== expected.environmentRoot
    || actual.runRoot !== expected.runRoot
    || actual.observerRoot !== expected.observerRoot) {
    throw new Error("Hosted greeting mount does not match the exact campaign bindings");
  }
  const mountNamespace = expectation.campaignRoot;
  const campaignOwnedRoot = join(mountNamespace, expectation.campaignId);
  if (actual.sourcePath !== mountNamespace
    || !isInside(campaignOwnedRoot, actual.runRoot)
    || !isInside(actual.runRoot, actual.observerRoot)
    || actual.environmentRoot !== join(
      actual.destinationPath,
      expectation.campaignId,
      actual.runRoot.slice(campaignOwnedRoot.length + 1),
      "greeting-handshakes",
    )) {
    throw new Error("Hosted greeting mount roots violate the pinned containment policy");
  }
  const isolation = evidence.mountIsolation;
  if (isolation.campaignSiblingPath !== expectation.greeting.campaignSiblingPath
    || isolation.runSiblingPath !== expectation.greeting.runSiblingPath
    || !isInside(dirname(mountNamespace), isolation.campaignSiblingPath)
    || isInside(mountNamespace, isolation.campaignSiblingPath)
    || !isInside(campaignOwnedRoot, isolation.runSiblingPath)) {
    throw new Error("Hosted greeting mount sibling isolation does not match the pinned paths");
  }
}

function assertRoundTrip(
  evidence: z.infer<typeof deploymentSafetyEvidenceSchema>,
  expectation: HostedDeploymentSafetyExpectationV1,
): void {
  const expectedRoot = join(expectation.greeting.runRoot, ".admission-probes");
  const proof = evidence.roundTrip;
  if (proof.probeRoot !== expectedRoot
    || proof.containerObservedHostNonce !== proof.hostWrittenNonce
    || proof.hostObservedContainerNonce !== proof.containerWrittenNonce
    || proof.hostWrittenNonce === proof.containerWrittenNonce) {
    throw new Error("Hosted greeting mount bidirectional nonce round-trip is invalid");
  }
}

function assertUniqueComponents(
  services: ReadonlyArray<{ readonly component: z.infer<typeof componentSchema> }>,
  source: string,
): void {
  if (new Set(services.map(({ component }) => component)).size !== componentSchema.options.length) {
    throw new Error(`Hosted deployment ${source} must contain each required service exactly once`);
  }
}

function sortByComponent<T extends { readonly component: string }>(services: readonly T[]): readonly T[] {
  return services.toSorted((left, right) => left.component.localeCompare(right.component));
}

function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function isSafeAbsolutePath(value: string): boolean {
  return isAbsolute(value) && !value.includes("\0") && normalize(value) === value && resolve(value) === value;
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalize);}
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
      left.localeCompare(right)).map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}
