import type { z } from "zod";

import type {
  actorRunEvidenceV1Schema,
  deploymentRevisionExpectationSchema,
  fixtureManifestV1Schema,
  retainedE2eEvidenceSchema,
  retainedE2eEvidenceV2Schema,
  retainedE2eEvidenceV3Schema,
  retainedE2eEvidenceV4Schema,
  retainedE2eEvidenceV5Schema,
  retainedE2eEvidenceV6Schema,
  retainedE2eEvidenceV7Schema,
  retainedE2eEvidenceV8Schema,
  unboundActorRunEvidenceV1Schema,
} from "./e2e-evidence-schema.js";

export type FixtureManifestV1 = z.infer<typeof fixtureManifestV1Schema>;
export type ActorRunEvidenceV1 = z.infer<typeof actorRunEvidenceV1Schema>;
export type UnboundActorRunEvidenceV1 = z.infer<typeof unboundActorRunEvidenceV1Schema>;
export type DeployedServiceProvenance =
  z.infer<typeof retainedE2eEvidenceV5Schema>["deployment"]["craig"];
export type CurrentDeploymentProvenance =
  z.infer<typeof retainedE2eEvidenceV5Schema>["deployment"];
export type DeploymentRevisionExpectation = z.infer<typeof deploymentRevisionExpectationSchema>;
export type ProcessingEvidence = z.infer<typeof retainedE2eEvidenceV4Schema>["processing"];
export type RetainedE2eEvidenceV2 = z.infer<typeof retainedE2eEvidenceV2Schema>;
export type RetainedE2eEvidenceV3 = z.infer<typeof retainedE2eEvidenceV3Schema>;
export type RetainedE2eEvidenceV4 = z.infer<typeof retainedE2eEvidenceV4Schema>;
export type RetainedE2eEvidenceV5 = z.infer<typeof retainedE2eEvidenceV5Schema>;
export type RetainedE2eEvidenceV6 = z.infer<typeof retainedE2eEvidenceV6Schema>;
export type RetainedE2eEvidenceV7 = z.infer<typeof retainedE2eEvidenceV7Schema>;
export type RetainedE2eEvidenceV8 = z.infer<typeof retainedE2eEvidenceV8Schema>;
export type RetainedE2eEvidence = z.infer<typeof retainedE2eEvidenceSchema>;
