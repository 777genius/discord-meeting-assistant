import { createHash } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";

import type { HostedDeploymentSafetyExpectationV1 } from "./hosted-deployment-safety-receipt.js";
import { hostedDeploymentSafetyExpectationV1Schema } from "./hosted-deployment-safety-receipt.js";
import { runRemoteProbe } from "./ssh-deployment-probe-commands.js";
import {
  parseDockerContainerId,
  parseSshDeploymentProbeOptions,
  type SshDeploymentProbeOptions,
  type SshDeploymentProbeSettings,
} from "./ssh-deployment-probe-validation.js";
import type { SshDeploymentSafetyProbeRunner } from "./ssh-deployment-safety-probe.js";

const dockerContainerSchema = z.object({
  Config: z.object({
    Cmd: z.array(z.string()).nullable(),
    Entrypoint: z.array(z.string()).nullable(),
    Env: z.array(z.string()).nullable(),
    Labels: z.record(z.string(), z.string()).nullable(),
  }),
  Id: z.string(),
  Image: z.string(),
  Mounts: z.array(z.object({
    Destination: z.string(),
    RW: z.boolean(),
    Source: z.string(),
  }).loose()),
  NetworkSettings: z.object({
    Networks: z.record(z.string(), z.object({
      IPAddress: z.string(),
      NetworkID: z.string(),
    }).loose()),
    Ports: z.record(z.string(), z.array(z.object({
      HostIp: z.string(),
      HostPort: z.string(),
    })).nullable()),
  }),
  State: z.object({ StartedAt: z.iso.datetime() }),
}).loose();

const dockerNetworkSchema = z.object({
  Driver: z.literal("bridge"),
  Id: z.string().regex(/^[a-f\d]{64}$/u),
  Internal: z.literal(false),
  Name: z.string(),
  Options: z.record(z.string(), z.string()).nullable(),
}).loose();

const dockerImageSchema = z.object({
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }),
  Id: z.string(),
  RepoDigests: z.array(z.string()).nullable(),
}).loose();

const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);

export interface SshDeploymentSafetyCommands {
  readonly runRemote: typeof runRemoteProbe;
}

const defaultCommands: SshDeploymentSafetyCommands = { runRemote: runRemoteProbe };

const rootResolutionScript = [
  "set -eu",
  "path=$1",
  "test -d \"$path\"",
  "test ! -L \"$path\"",
  "readlink -e -- \"$path\"",
].join("\n");

const destinationStatScript = [
  "set -eu",
  "path=$1",
  "test -d \"$path\"",
  "resolved=$(readlink -e -- \"$path\")",
  "if test -L \"$path\" || test \"$resolved\" != \"$path\"; then link=true; else link=false; fi",
  "printf '%s|%s|%s\\n' \"$(stat -c %u -- \"$path\")\" \"$(stat -c %g -- \"$path\")\" \"$link\"",
].join("\n");

const symbolicLinkStatScript = [
  "set -eu",
  "path=$1",
  "test -d \"$path\"",
  "resolved=$(readlink -e -- \"$path\")",
  "if test -L \"$path\" || test \"$resolved\" != \"$path\"; then printf true; else printf false; fi",
].join("\n");

const campaignRootSnapshotScript = [
  "set -eu",
  "path=$1",
  "campaign_id=$2",
  "test -d \"$path\"",
  "test ! -L \"$path\"",
  "resolved=$(readlink -e -- \"$path\")",
  "test \"$resolved\" = \"$path\"",
  "entry=$path/$campaign_id",
  "test -d \"$entry\"",
  "test ! -L \"$entry\"",
  "printf '%s|%s|%s|%s|%s\\n' \"$(stat -c %u -- \"$path\")\" \"$(stat -c %g -- \"$path\")\" \"$(stat -c %a -- \"$path\")\" \"$(stat -c %h -- \"$path\")\" \"$resolved\"",
  "find \"$path\" -mindepth 1 -maxdepth 1 -printf '%f\\0' | LC_ALL=C sort -z | base64 -w0",
  "printf '\\n'",
].join("\n");

const hostToContainerNonceScript = [
  "set -eu",
  "container_id=$1",
  "host_root=$2",
  "container_root=$3",
  "nonce=$4",
  "file=$host_root/host-nonce",
  "cleanup() { rm -f -- \"$file\"; rmdir -- \"$host_root\" 2>/dev/null || true; }",
  "trap cleanup EXIT HUP INT TERM",
  "mkdir -m 733 -- \"$host_root\"",
  "test ! -L \"$host_root\"",
  "umask 022",
  "printf '%s' \"$nonce\" >\"$file\"",
  "docker exec -i \"$container_id\" sh -ceu 'cat -- \"$1/host-nonce\"' nonce-reader \"$container_root\"",
].join("\n");

const containerToHostNonceScript = [
  "set -eu",
  "container_id=$1",
  "host_root=$2",
  "container_root=$3",
  "nonce=$4",
  "file=$host_root/container-nonce",
  "cleanup() { rm -f -- \"$file\"; rmdir -- \"$host_root\" 2>/dev/null || true; }",
  "trap cleanup EXIT HUP INT TERM",
  "mkdir -m 733 -- \"$host_root\"",
  "test ! -L \"$host_root\"",
  "docker exec -i \"$container_id\" sh -ceu 'umask 022; printf %s \"$2\" >\"$1/container-nonce\"' nonce-writer \"$container_root\" \"$nonce\"",
  "cat -- \"$file\"",
].join("\n");

type ServiceExpectation = HostedDeploymentSafetyExpectationV1["services"][number];
type RawContainer = z.infer<typeof dockerContainerSchema>;

/** Concrete SSH adapter. It accepts only validated, test-scoped deployment settings. */
export class ConcreteSshDeploymentSafetyProbeRunner implements SshDeploymentSafetyProbeRunner {
  readonly #commands: SshDeploymentSafetyCommands;
  readonly #expectation: HostedDeploymentSafetyExpectationV1;
  readonly #settings: SshDeploymentProbeSettings;

  public constructor(
    options: SshDeploymentProbeOptions,
    expectation: HostedDeploymentSafetyExpectationV1,
    commands: SshDeploymentSafetyCommands = defaultCommands,
  ) {
    this.#settings = parseSshDeploymentProbeOptions(options);
    this.#expectation = hostedDeploymentSafetyExpectationV1Schema.parse(expectation);
    this.#commands = commands;
  }

  public async inspectDeployment(signal?: AbortSignal): Promise<unknown> {
    const campaignRoot = await this.#inspectCampaignRoot(signal);
    const roots = {
      deploy: await this.#inspectRoot(this.#expectation.deployRoot, signal),
      source: await this.#inspectRoot(this.#expectation.sourceRoot, signal),
    };
    const inspected = await Promise.all(this.#expectation.services.map(async (service) =>
      this.#inspectService(service, signal)));
    const meetingPlatform = inspected.find(({ service }) => service.component === "meetingPlatform");
    const craig = inspected.find(({ service }) => service.component === "craig");
    if (meetingPlatform === undefined) {
      throw new Error("Deployment safety expectation has no Meeting Platform service");
    }
    if (craig === undefined) {
      throw new Error("Deployment safety expectation has no Craig service");
    }
    return {
      campaignRoot,
      craigNetwork: await this.#inspectCraigNetwork(craig.container, signal),
      greetingMount: await this.#inspectGreetingMount(meetingPlatform.container, signal),
      roots,
      services: inspected.map(({ snapshot }) => snapshot),
    };
  }

  async #inspectCraigNetwork(container: RawContainer, signal?: AbortSignal): Promise<unknown> {
    const policy = this.#expectation.craigNetworkPolicy;
    if (container.Id !== this.#requiredService("craig").containerId) {
      throw new Error("Craig network proof selected the wrong container");
    }
    const attachment = container.NetworkSettings.Networks[policy.networkName];
    if (attachment === undefined || !/^[a-f\d]{64}$/u.test(attachment.NetworkID)) {
      throw new Error("Craig is not attached to the compiled network policy");
    }
    const network = parseExactDockerInspection(dockerNetworkSchema, JSON.parse(
      await this.#commands.runRemote(this.#settings, [
        "docker", "network", "inspect", attachment.NetworkID,
      ], signal),
    ));
    const bridgeInterface = network.Options?.["com.docker.network.bridge.name"]
      ?? `br-${network.Id.slice(0, 12)}`;
    if (network.Id !== attachment.NetworkID || network.Name !== policy.networkName
      || bridgeInterface !== policy.bridgeInterface) {
      throw new Error("Craig bridge identity does not match the compiled network policy");
    }
    const firewall = await this.#commands.runRemote(this.#settings, [
      "iptables-save", "-c", "-t", "filter",
    ], signal);
    return proveCraigFirewallPolicy({
      bridgeInterface,
      containerId: container.Id,
      containerIpv4: attachment.IPAddress,
      firewall,
      networkId: network.Id,
      policy,
    });
  }

  async #inspectCampaignRoot(signal?: AbortSignal): Promise<unknown> {
    const output = await this.#commands.runRemote(this.#settings, [
      "sh", "-ceu", campaignRootSnapshotScript, "deployment-safety-campaign-root",
      this.#expectation.campaignRoot, this.#expectation.campaignId,
    ], signal);
    const separator = output.indexOf("\n");
    const metadata = separator < 0 ? [] : output.slice(0, separator).split("|");
    const encodedEntries = separator < 0 ? "" : output.slice(separator + 1).replace(/\n$/u, "");
    const entriesBase64 = decodeNullDelimitedBase64(encodedEntries);
    if (metadata.length !== 5) {
      throw new Error("Hosted campaign root inspection returned invalid metadata");
    }
    const [uid, gid, mode, linkCount, resolvedPath] = metadata;
    return {
      campaignEntryKind: "directory",
      campaignEntrySymbolicLink: false,
      entriesBase64,
      gid: Number(gid),
      linkCount: Number(linkCount),
      mode: `0${mode}`,
      requestedPath: this.#expectation.campaignRoot,
      resolvedPath,
      symbolicLink: false,
      uid: Number(uid),
    };
  }

  public async inspectMountIsolation(
    sourcePath: string,
    campaignSiblingPath: string,
    runSiblingPath: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const meeting = this.#requiredService("meetingPlatform");
    const { container } = await this.#inspectContainer(meeting, signal);
    return {
      campaignSiblingAccessible: isExposedByMount(container.Mounts, campaignSiblingPath),
      campaignSiblingMounted: container.Mounts.some(({ Source }) => Source === campaignSiblingPath),
      campaignSiblingPath,
      runSiblingAccessible: isExposedByMount(container.Mounts, runSiblingPath),
      runSiblingMounted: container.Mounts.some(({ Source }) => Source === runSiblingPath),
      runSiblingPath,
      ...(container.Mounts.some(({ Source }) => Source === sourcePath)
        ? {}
        : fail("Pinned greeting source is not mounted in Meeting Platform")),
    };
  }

  public async observeHostNonceInContainer(probeRoot: string, nonce: string, signal?: AbortSignal): Promise<string> {
    const containerId = await this.#meetingContainerId(signal);
    return (await this.#commands.runRemote(this.#settings, [
      "sh", "-ceu", hostToContainerNonceScript, "deployment-safety-host-nonce",
      containerId, probeRoot, this.#containerProbeRoot(probeRoot), nonce,
    ], signal)).trim();
  }

  public async observeContainerNonceOnHost(probeRoot: string, nonce: string, signal?: AbortSignal): Promise<string> {
    const containerId = await this.#meetingContainerId(signal);
    return (await this.#commands.runRemote(this.#settings, [
      "sh", "-ceu", containerToHostNonceScript, "deployment-safety-container-nonce",
      containerId, probeRoot, this.#containerProbeRoot(probeRoot), nonce,
    ], signal)).trim();
  }

  async #inspectRoot(path: string, signal?: AbortSignal): Promise<unknown> {
    const resolvedPath = (await this.#commands.runRemote(this.#settings, [
      "sh", "-ceu", rootResolutionScript, "deployment-safety-root", path,
    ], signal)).trim();
    return { kind: "directory", requestedPath: path, resolvedPath, symbolicLink: false };
  }

  async #inspectService(service: ServiceExpectation, signal?: AbortSignal) {
    const { container, image } = await this.#inspectContainer(service, signal);
    const labels = container.Config.Labels ?? {};
    const revision = sourceRevisionSchema.parse(
      image.Config.Labels?.["org.opencontainers.image.revision"],
    );
    const repositoryDigest = image.RepoDigests?.find((value) =>
      value === service.repositoryDigest) ?? image.RepoDigests?.toSorted()[0];
    if (repositoryDigest === undefined) {
      throw new Error(`Hosted ${service.component} image has no repository digest`);
    }
    return {
      container,
      service,
      snapshot: {
        commandSha256: digest({ cmd: container.Config.Cmd, entrypoint: container.Config.Entrypoint }),
        component: service.component,
        composeConfigHash: labels["com.docker.compose.config-hash"],
        composeProject: labels["com.docker.compose.project"],
        composeService: labels["com.docker.compose.service"],
        containerId: container.Id,
        containerStartedAt: container.State.StartedAt,
        imageId: container.Image,
        networks: Object.keys(container.NetworkSettings.Networks).toSorted(),
        publishedPorts: publishedPorts(container),
        repositoryDigest,
        sourceRevision: revision,
        testOnly: labels["e2e.test-only"] === "true"
          ? "true"
          : "false",
      },
    };
  }

  async #inspectContainer(service: ServiceExpectation, signal?: AbortSignal) {
    const ids = (await this.#commands.runRemote(this.#settings, [
      "docker", "ps", "--no-trunc", "--quiet",
      "--filter", `label=com.docker.compose.project=${service.composeProject}`,
      "--filter", `label=com.docker.compose.service=${service.composeService}`,
    ], signal)).trim().split("\n").filter(Boolean);
    if (ids.length !== 1) {
      throw new Error(`Expected exactly one ${service.component} test container, found ${ids.length}`);
    }
    const containerId = parseDockerContainerId(ids[0]);
    const container = parseExactDockerInspection(dockerContainerSchema, JSON.parse(
      await this.#commands.runRemote(this.#settings, ["docker", "inspect", "--type", "container", containerId], signal),
    ));
    const image = parseExactDockerInspection(dockerImageSchema, JSON.parse(
      await this.#commands.runRemote(this.#settings, ["docker", "image", "inspect", container.Image], signal),
    ));
    if (container.Id !== containerId || image.Id !== container.Image) {
      throw new Error(`Hosted ${service.component} immutable Docker identity changed during inspection`);
    }
    return { container, image };
  }

  async #inspectGreetingMount(container: RawContainer, signal?: AbortSignal): Promise<unknown> {
    const expected = this.#expectation.greeting;
    const mount = container.Mounts.filter(({ Destination }) => Destination === expected.destinationPath);
    if (mount.length !== 1 || mount[0] === undefined) {
      throw new Error("Meeting Platform must have exactly one pinned greeting mount");
    }
    const [uid, gid, destinationSymbolicLink] = (await this.#commands.runRemote(this.#settings, [
      "docker", "exec", "-i", container.Id,
      "sh", "-ceu", destinationStatScript, "deployment-safety-destination", expected.destinationPath,
    ], signal)).trim().split("|");
    const sourceSymbolicLink = (await this.#commands.runRemote(this.#settings, [
      "sh", "-ceu", symbolicLinkStatScript, "deployment-safety-source", mount[0].Source,
    ], signal)).trim() === "true";
    return {
      containerGid: Number(gid),
      containerUid: Number(uid),
      destinationPath: mount[0].Destination,
      destinationSymbolicLink: destinationSymbolicLink === "true",
      environmentRoot: environmentValue(
        container.Config.Env,
        "CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT",
      ),
      observerRoot: expected.observerRoot,
      readOnly: !mount[0].RW,
      runRoot: expected.runRoot,
      sourcePath: mount[0].Source,
      sourceSymbolicLink,
    };
  }

  #containerProbeRoot(hostProbeRoot: string): string {
    const relative = posix.relative(this.#expectation.greeting.sourcePath, hostProbeRoot);
    if (relative.startsWith("..") || posix.isAbsolute(relative)) {
      throw new Error("Deployment nonce probe escaped the pinned greeting source");
    }
    return posix.join(this.#expectation.greeting.destinationPath, relative);
  }

  #requiredService(component: ServiceExpectation["component"]): ServiceExpectation {
    const service = this.#expectation.services.find((candidate) => candidate.component === component);
    if (service === undefined) {
      throw new Error(`Deployment safety expectation has no ${component} service`);
    }
    return service;
  }

  async #meetingContainerId(signal?: AbortSignal): Promise<string> {
    return (await this.#inspectContainer(this.#requiredService("meetingPlatform"), signal)).container.Id;
  }
}

function decodeNullDelimitedBase64(value: string): readonly string[] {
  if (!/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)) {
    throw new Error("Hosted campaign root inspection returned invalid entry framing");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.at(-1) !== 0) {
    throw new Error("Hosted campaign root inspection returned incomplete entry framing");
  }
  const entries: string[] = [];
  let start = 0;
  for (let index = 0; index < decoded.length; index += 1) {
    if (decoded[index] === 0) {
      entries.push(decoded.subarray(start, index).toString("base64"));
      start = index + 1;
    }
  }
  return entries;
}

function environmentValue(environment: readonly string[] | null, name: string): string | undefined {
  return environment?.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1);
}

function publishedPorts(container: RawContainer): readonly number[] {
  return Object.entries(container.NetworkSettings.Ports).flatMap(([port, bindings]) => {
    const containerPort = port.split("/")[0];
    return bindings === null || bindings.length === 0 || containerPort === undefined
      ? []
      : [Number(containerPort)];
  });
}

function isExposedByMount(mounts: RawContainer["Mounts"], hostPath: string): boolean {
  return mounts.some(({ Source }) =>
    Source === "/" || hostPath === Source || hostPath.startsWith(`${Source}/`));
}

interface FirewallRule {
  readonly chain: string;
  readonly destination?: string;
  readonly destinationPort?: string;
  readonly input?: string;
  readonly output?: string;
  readonly protocol?: string;
  readonly source?: string;
  readonly states?: readonly string[];
  readonly target?: string;
  readonly unsupported?: readonly string[];
}

export function proveCraigFirewallPolicy(input: Readonly<{
  bridgeInterface: string;
  containerId: string;
  containerIpv4: string;
  firewall: string;
  networkId: string;
  policy: HostedDeploymentSafetyExpectationV1["craigNetworkPolicy"];
}>): Readonly<Record<string, unknown>> {
  const address = canonicalIpv4(input.containerIpv4);
  if (input.bridgeInterface !== input.policy.bridgeInterface) {
    throw new Error("Craig firewall proof selected the wrong bridge");
  }
  const rules = parseFilterRules(input.firewall);
  const policyRules = rules.filter(({ chain }) => chain === input.policy.chain);
  if (policyRules.some(({ unsupported }) => unsupported !== undefined && unsupported.length > 0)) {
    throw new Error("Craig firewall policy chain contains an unsupported match");
  }
  const required = [
    { input: input.bridgeInterface, protocol: "tcp", source: `${address}/32`,
      destinationPort: String(input.policy.tcpDestinationPort), states: ["ESTABLISHED", "NEW"], target: "ACCEPT" },
    { input: input.bridgeInterface, protocol: "udp", source: `${address}/32`,
      destinationPort: `${input.policy.udpDestinationPorts.start}:${input.policy.udpDestinationPorts.end}`,
      states: ["ESTABLISHED", "NEW"], target: "ACCEPT" },
    { destination: `${address}/32`, output: input.bridgeInterface,
      states: ["ESTABLISHED", "RELATED"], target: "ACCEPT" },
  ] as const;
  const accepted = policyRules.filter(({ target }) => target === "ACCEPT");
  if (accepted.length !== required.length || required.some((expected) =>
    !accepted.some((actual) => sameMatch(actual, expected)))) {
    throw new Error("Craig firewall policy lacks the exact TCP 443, UDP, or established return rule");
  }
  if (policyRules.some((rule) => rule.target !== "ACCEPT" && rule.target !== "RETURN")) {
    throw new Error("Craig firewall policy chain contains an unreviewed semantic rule");
  }
  const returns = policyRules.filter(({ target }) => target === "RETURN");
  const returnIndex = returns.length === 1 ? policyRules.indexOf(returns[0]!) : -1;
  if (returns.length !== 1 || Object.keys(withoutUndefined(returns[0]!)).length !== 2
    || returnIndex < Math.max(...accepted.map((rule) => policyRules.indexOf(rule)))) {
    throw new Error("Craig firewall policy chain must have one terminal unconditional return");
  }
  const forward = rules.filter(({ chain }) => chain === "FORWARD");
  for (const direction of [
    { input: input.bridgeInterface, source: `${address}/32`, target: input.policy.chain },
    { destination: `${address}/32`, output: input.bridgeInterface, target: input.policy.chain },
  ] as const) {
    const dispatchIndex = forward.findIndex((rule) => sameMatch(rule, direction));
    if (dispatchIndex < 0) {
      throw new Error("Craig firewall policy is not reachable from the effective FORWARD chain");
    }
    const earlierEffectiveRule = forward.slice(0, dispatchIndex).find((rule) =>
      rule.target !== undefined && rule.target !== "LOG" && overlaps(rule, direction));
    if (earlierEffectiveRule?.target === "DROP" || earlierEffectiveRule?.target === "REJECT") {
      throw new Error("Craig firewall policy is shadowed by an earlier DROP or REJECT");
    }
    if (earlierEffectiveRule !== undefined) {
      throw new Error("Craig firewall policy is bypassed by an earlier effective rule");
    }
  }
  const semantics = required.map((rule) => withoutUndefined({ chain: input.policy.chain, ...rule }))
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const proof = {
    ...input.policy,
    containerId: input.containerId,
    containerIpv4: address,
    networkId: input.networkId,
  };
  return Object.freeze({
    ...proof,
    semanticPolicySha256: digest({ proof, semantics }),
  });
}

function parseFilterRules(value: string): readonly FirewallRule[] {
  if (!value.split("\n").some((line) => line.trim() === "*filter")
    || !value.split("\n").some((line) => line.trim() === "COMMIT")) {
    throw new Error("iptables-save did not return one complete filter table");
  }
  return value.split("\n").map((line) => line.trim()).filter((line) =>
    /^\[\d+:\d+\]\s+-A\s/u.test(line) || line.startsWith("-A ")).map((line) => {
    const tokens = shellTokens(line.replace(/^\[\d+:\d+\]\s+/u, ""));
    const chain = argument(tokens, "-A");
    if (chain === undefined) { throw new Error("iptables-save returned a rule without a chain"); }
    const states = argument(tokens, "--ctstate")?.split(",").toSorted();
    const supported = new Set(["-A", "-d", "--destination", "--destination-port", "--dport",
      "-i", "--in-interface", "-j", "--jump", "-m", "-o", "--out-interface", "-p",
      "--protocol", "-s", "--source", "--ctstate", "--comment"]);
    const unsupported = tokens.filter((token, index) => (token.startsWith("-")
      && !supported.has(token) && tokens[index - 1] !== "--comment") || token === "!");
    const modules = tokens.flatMap((token, index) => token === "-m" && tokens[index + 1] !== undefined
      ? [tokens[index + 1]!] : []);
    unsupported.push(...modules.filter((module) =>
      !["comment", "conntrack", "tcp", "udp"].includes(module)));
    return withoutUndefined({
      chain,
      destination: normalizedAddress(argument(tokens, "-d") ?? argument(tokens, "--destination")),
      destinationPort: argument(tokens, "--dport") ?? argument(tokens, "--destination-port"),
      input: argument(tokens, "-i") ?? argument(tokens, "--in-interface"),
      output: argument(tokens, "-o") ?? argument(tokens, "--out-interface"),
      protocol: argument(tokens, "-p") ?? argument(tokens, "--protocol"),
      source: normalizedAddress(argument(tokens, "-s") ?? argument(tokens, "--source")),
      states,
      target: argument(tokens, "-j") ?? argument(tokens, "--jump"),
      unsupported: unsupported.length === 0 ? undefined : unsupported,
    }) as FirewallRule;
  });
}

function shellTokens(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (const character of value) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== undefined) {
      if (character === quote) { quote = undefined; } else { current += character; }
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (/\s/u.test(character)) {
      if (current.length > 0) { tokens.push(current); current = ""; }
      continue;
    }
    current += character;
  }
  if (escaped || quote !== undefined) { throw new Error("iptables-save returned malformed quoting"); }
  if (current.length > 0) { tokens.push(current); }
  return tokens;
}

function argument(tokens: readonly string[], option: string): string | undefined {
  const index = tokens.indexOf(option);
  return index < 0 ? undefined : tokens[index + 1];
}

function canonicalIpv4(value: string): string {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet)
    || Number(octet) > 255 || (octet !== "0" && octet.startsWith("0")))) {
    throw new Error("Craig container has no canonical IPv4 address on the compiled bridge");
  }
  return value;
}

function normalizedAddress(value: string | undefined): string | undefined {
  if (value === undefined) { return undefined; }
  return /^\d+\.\d+\.\d+\.\d+$/u.test(value) ? `${value}/32` : value;
}

function sameMatch(actual: FirewallRule, expected: Omit<FirewallRule, "chain">): boolean {
  const { chain: _chain, ...actualMatch } = actual;
  return stableObject(withoutUndefined(actualMatch)) === stableObject(withoutUndefined(expected));
}

function overlaps(rule: FirewallRule, direction: Omit<FirewallRule, "chain">): boolean {
  if ((rule.input !== undefined && direction.output !== undefined && direction.input === undefined)
    || (rule.output !== undefined && direction.input !== undefined && direction.output === undefined)) {
    return false;
  }
  for (const key of ["destination", "input", "output", "protocol", "source"] as const) {
    if (rule[key] !== undefined && direction[key] !== undefined && rule[key] !== direction[key]) {
      return false;
    }
  }
  return true;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as T;
}

function stableObject(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right))));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function fail(message: string): never {
  throw new Error(message);
}

function parseExactDockerInspection<T>(schema: z.ZodType<T>, value: unknown): T {
  const values = z.array(schema).length(1).parse(value);
  const result = values[0];
  if (result === undefined) {
    throw new Error("Docker inspection returned no object");
  }
  return result;
}
