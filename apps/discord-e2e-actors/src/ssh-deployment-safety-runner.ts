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
    Networks: z.record(z.string(), z.unknown()),
    Ports: z.record(z.string(), z.array(z.object({
      HostIp: z.string(),
      HostPort: z.string(),
    })).nullable()),
  }),
  State: z.object({ StartedAt: z.iso.datetime() }),
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
    const roots = {
      deploy: await this.#inspectRoot(this.#expectation.deployRoot, signal),
      source: await this.#inspectRoot(this.#expectation.sourceRoot, signal),
    };
    const inspected = await Promise.all(this.#expectation.services.map(async (service) =>
      this.#inspectService(service, signal)));
    const meetingPlatform = inspected.find(({ service }) => service.component === "meetingPlatform");
    if (meetingPlatform === undefined) {
      throw new Error("Deployment safety expectation has no Meeting Platform service");
    }
    return {
      greetingMount: await this.#inspectGreetingMount(meetingPlatform.container, signal),
      roots,
      services: inspected.map(({ snapshot }) => snapshot),
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
  return mounts.some(({ Source }) => hostPath === Source || hostPath.startsWith(`${Source}/`));
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
