import { z } from "zod";

const identifierSchema = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const dockerContainerIdSchema = z.string().regex(/^[a-f\d]{64}$/u);
const dockerImageIdSchema = z.string().regex(/^sha256:[a-f\d]{64}$/u);
const repositoryDigestSchema = z.string().regex(/^[^\s@]+@sha256:[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);

export const deploymentRevisionExpectationSchema = z.object({
  craig: sourceRevisionSchema,
  meetingPlatform: sourceRevisionSchema,
  pipecat: sourceRevisionSchema.optional(),
  subscriptionRuntime: sourceRevisionSchema.optional(),
}).strict();

const deployedServiceProvenanceSchema = z.object({
  composeConfigHash: sha256Schema,
  composeProject: identifierSchema,
  composeService: identifierSchema,
  containerId: dockerContainerIdSchema,
  containerStartedAt: z.iso.datetime(),
  imageId: dockerImageIdSchema,
  repositoryDigest: repositoryDigestSchema.nullable(),
  sourceRevision: sourceRevisionSchema,
});

export const historicalDeploymentProvenanceSchema = z.object({
  craig: deployedServiceProvenanceSchema,
  meetingPlatform: deployedServiceProvenanceSchema,
});

export const runtimeDeploymentProvenanceSchema = historicalDeploymentProvenanceSchema.extend({
  subscriptionRuntime: deployedServiceProvenanceSchema,
});

export const currentDeploymentProvenanceSchema = runtimeDeploymentProvenanceSchema.extend({
  pipecat: deployedServiceProvenanceSchema.optional(),
});
