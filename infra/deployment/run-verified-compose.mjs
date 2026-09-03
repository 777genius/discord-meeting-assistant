/// <reference types="node" />

import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deploymentIdentityFromEnvFile } from "./generate-build-provenance.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const buildRoot = join(repositoryRoot, ".build");
const contextPath = join(buildRoot, "docker-context");
const provenancePath = join(buildRoot, "meeting-platform-build-provenance.json");
const identityEnvironmentNames = new Set([
  "COMPOSE_ENV_FILES",
  "COMPOSE_FILE",
  "COMPOSE_PATH_SEPARATOR",
  "COMPOSE_PROFILES",
  "COMPOSE_PROJECT_NAME",
  "DISCORD_APPLICATION_ID",
  "DISCORD_BOTIK_APPLICATION_ID",
  "DISCORD_CRAIG_APPLICATION_ID",
  "DISCORD_PUBLICATION_APPLICATION_ID",
  "MEETING_PLATFORM_SOURCE_REVISION",
  "MEETING_PLATFORM_SOURCE_TREE",
  "SUBSCRIPTION_RUNTIME_SOURCE_REVISION",
]);

function execute(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout) => {
      if (error === null) {resolve(stdout);}
      else {reject(error);}
    });
  });
}

export function sanitizedComposeEnvironment(environment, sourceTree) {
  const sanitized = Object.fromEntries(Object.entries(environment).filter(
    ([name]) => !identityEnvironmentNames.has(name),
  ));
  return { ...sanitized, MEETING_PLATFORM_SOURCE_TREE: sourceTree };
}

function requiredRecord(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`rendered Compose ${label} is missing`);
  }
  return value;
}

function requiredService(rendered, name) {
  const services = requiredRecord(rendered.services, "services");
  return requiredRecord(services[name], `${name} service`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {throw new Error(`rendered Compose ${label} does not match verified identity`);}
}

function assertLocalBuildContext(rendered, name, expectedContext, provenance) {
  const service = requiredService(rendered, name);
  const build = requiredRecord(service.build, `${name} build`);
  assertEqual(pathResolve(String(build.context)), expectedContext, `${name} build context`);
  if (provenance !== undefined) {
    assertEqual(build.labels?.["org.opencontainers.image.revision"], provenance.releaseRevision, `${name} build revision`);
    assertEqual(build.labels?.["org.opencontainers.image.source-tree"], provenance.sourceTree, `${name} source tree`);
    if (build.args?.SOURCE_REVISION !== undefined) {assertEqual(build.args.SOURCE_REVISION, provenance.releaseRevision, `${name} source argument`);}
    assertEqual(service.image?.split(":").at(-1), provenance.releaseRevision, `${name} image revision`);
  }
}


function assertRemotePin(rendered, serviceName, pin) {
  const service = requiredService(rendered, serviceName);
  const build = requiredRecord(service.build, `${serviceName} build`);
  const context = `${pin.gitUrl}?ref=${pin.gitRef}&checksum=${pin.revision}`;
  const source = pin.gitUrl.replace(/\.git$/u, "");
  assertEqual(build.context, context, `${serviceName} Git context`);
  assertEqual(build.labels?.["org.opencontainers.image.revision"], pin.revision, `${serviceName} build revision`);
  assertEqual(build.labels?.["org.opencontainers.image.source"], source, `${serviceName} build source`);
  assertEqual(service.labels?.["org.opencontainers.image.revision"], pin.revision, `${serviceName} runtime revision`);
  assertEqual(service.labels?.["org.opencontainers.image.source"], source, `${serviceName} runtime source`);
  assertEqual(service.image?.split(":").at(-1), pin.revision, `${serviceName} image revision`);
}

export function assertRenderedDeployment(input) {
  const platform = requiredService(input.rendered, "meeting-platform");
  const environment = requiredRecord(platform.environment, "meeting-platform environment");
  assertEqual(environment.DISCORD_APPLICATION_ID, input.identity.publicationApplicationId, "publication application");
  assertEqual(environment.DISCORD_BOTIK_APPLICATION_ID, input.identity.publicationApplicationId, "Botik application");
  assertEqual(environment.DISCORD_CRAIG_APPLICATION_ID, input.identity.craigApplicationId, "Craig application");
  assertEqual(platform.image, `discord-meeting/meeting-platform:${input.provenance.releaseRevision}`, "platform image revision");
  assertEqual(platform.build?.labels?.["org.opencontainers.image.revision"], input.provenance.releaseRevision, "platform build revision");
  assertEqual(platform.build?.labels?.["org.opencontainers.image.source-tree"], input.provenance.sourceTree, "platform source tree");
  for (const name of [
    "meeting-platform",
    "object-storage-bootstrap",
    "postgres-migrations",
    "subscription-runtime-sidecar",
    "pipecat-runtime",
  ]) {
    if (input.rendered.services?.[name] !== undefined) {assertLocalBuildContext(input.rendered, name, input.contextPath, input.provenance);}
  }
  if (input.rendered.services?.["recording-edge"] !== undefined) {assertLocalBuildContext(input.rendered, "recording-edge", input.contextPath);}
  if (input.rendered.services?.["voicetext-edge"] !== undefined) {assertLocalBuildContext(input.rendered, "voicetext-edge", input.contextPath);}
  if (input.rendered.services?.["craig-bot"] !== undefined) {
    assertEqual(requiredService(input.rendered, "craig-bot").environment?.DISCORD_APPLICATION_ID, input.identity.craigApplicationId, "Craig bot application");
    assertRemotePin(input.rendered, "craig-bot", input.pins.craigMeetingGateway);
  }
  if (input.rendered.services?.["craig-migrations"] !== undefined) {
    assertRemotePin(input.rendered, "craig-migrations", input.pins.craigMeetingGateway);
  }
  if (input.rendered.services?.["voicetext-gateway"] !== undefined) {
    assertRemotePin(input.rendered, "voicetext-gateway", input.pins.voiceTextGateway);
  }
}

function composeInvocation(arguments_) {
  const commandIndex = arguments_.findIndex((value) => value === "build" || value === "up");
  if (commandIndex < 0) {throw new Error("verified Compose wrapper requires build or up --build");}
  if (arguments_[commandIndex] === "up" && !arguments_.slice(commandIndex + 1).includes("--build")) {
    throw new Error("verified Compose up requires --build");
  }
  const globalArguments = arguments_.slice(0, commandIndex);
  if (globalArguments.some((value) => value === "--env-file" || value === "--project-directory")) {
    throw new Error("Compose environment and project directory are owned by the wrapper");
  }
  return { globalArguments };
}

async function createGitContext() {
  await mkdir(buildRoot, { recursive: true });
  const lock = await open(join(buildRoot, "docker-context.lock"), "wx", 0o600);
  const temporary = await mkdtemp(join(buildRoot, ".docker-context-"));
  try {
    const archive = join(temporary, "source.tar");
    const extracted = join(temporary, "context");
    await mkdir(extracted);
    await execute("git", ["archive", "--format=tar", `--output=${archive}`, "HEAD"], { cwd: repositoryRoot });
    await execute("tar", ["-xf", archive, "-C", extracted]);
    await mkdir(join(extracted, ".build"));
    await copyFile(provenancePath, join(extracted, ".build", "meeting-platform-build-provenance.json"));
    await rm(contextPath, { recursive: true, force: true });
    await rename(extracted, contextPath);
    return { lock, temporary };
  } catch (error) {
    await lock.close();
    await rm(join(buildRoot, "docker-context.lock"), { force: true });
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function main() {
  if (process.argv[2] !== "--env-file" || process.argv[4] !== "--" || process.argv[3] === undefined) {
    throw new Error("usage: run-verified-compose.mjs --env-file <deployment.env> -- <Compose build/up arguments>");
  }
  const environmentPath = resolve(process.argv[3]);
  const composeArguments = process.argv.slice(5);
  const invocation = composeInvocation(composeArguments);
  await execute(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "generate-build-provenance.mjs"), "--env-file", environmentPath], { cwd: repositoryRoot });
  const identity = await deploymentIdentityFromEnvFile(environmentPath);
  const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
  const pins = JSON.parse(await readFile(new URL("./source-pins.json", import.meta.url), "utf8"));
  const generated = await createGitContext();
  const childEnvironment = sanitizedComposeEnvironment(process.env, provenance.sourceTree);
  try {
    const prefix = ["compose", "--env-file", environmentPath, ...invocation.globalArguments];
    const renderedText = await execute("docker", [...prefix, "config", "--format", "json"], {
      cwd: repositoryRoot, encoding: "utf8", env: childEnvironment,
    });
    assertRenderedDeployment({ rendered: JSON.parse(renderedText), identity, provenance, pins, contextPath });
    await execute("docker", [...prefix, ...composeArguments.slice(invocation.globalArguments.length)], {
      cwd: repositoryRoot, env: childEnvironment,
    });
  } finally {
    await generated.lock.close();
    await rm(contextPath, { recursive: true, force: true });
    await rm(generated.temporary, { recursive: true, force: true });
    await rm(join(buildRoot, "docker-context.lock"), { force: true });
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {await main();}
