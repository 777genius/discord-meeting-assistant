import type { DeployedServiceProvenance } from "./e2e-evidence.js";
import { parseLastJsonLine } from "./ssh-deployment-probe-commands.js";
import {
  containerProvenanceFormat,
  imageProvenanceFormat,
} from "./ssh-deployment-probe-scripts.js";
import {
  containerProvenanceOutputSchema,
  imageProvenanceOutputSchema,
} from "./ssh-deployment-probe-validation.js";

export async function collectServiceProvenance(input: Readonly<{
  findContainerId: (projectName: string, serviceName: string) => Promise<string>;
  projectName: string;
  runRemote: (arguments_: readonly string[]) => Promise<string>;
  serviceName: string;
}>): Promise<DeployedServiceProvenance> {
  const containerId = await input.findContainerId(input.projectName, input.serviceName);
  const container = containerProvenanceOutputSchema.parse(parseLastJsonLine(
    await input.runRemote([
      "docker", "inspect", "--format", containerProvenanceFormat, containerId,
    ]),
  ));
  if (container.composeProject !== input.projectName ||
    container.composeService !== input.serviceName) {
    throw new Error("Docker container provenance does not match the requested Compose service");
  }
  const image = imageProvenanceOutputSchema.parse(parseLastJsonLine(
    await input.runRemote([
      "docker", "image", "inspect", "--format", imageProvenanceFormat, container.imageId,
    ]),
  ));
  if (image.imageId !== container.imageId) {
    throw new Error("Running container image differs from inspected immutable image ID");
  }
  return {
    ...container,
    repositoryDigest: (image.repositoryDigests ?? []).toSorted()[0] ?? null,
    sourceRevision: image.sourceRevision,
  };
}
