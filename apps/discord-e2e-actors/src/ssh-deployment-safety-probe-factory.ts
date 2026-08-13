import { z } from "zod";

import {
  hostedDeploymentSafetyExpectationV1Schema,
  type HostedDeploymentSafetyExpectationV1,
} from "./hosted-deployment-safety-receipt.js";
import {
  ConcreteSshDeploymentSafetyProbeRunner,
  type SshDeploymentSafetyCommands,
} from "./ssh-deployment-safety-runner.js";
import {
  SshDeploymentSafetyProbe,
  type SshDeploymentSafetyProbeOptions,
} from "./ssh-deployment-safety-probe.js";
import type { SshDeploymentProbeOptions } from "./ssh-deployment-probe-validation.js";

const nonceSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);

export interface ConcreteSshDeploymentSafetyProbeOptions {
  readonly containerNonce: string;
  readonly expectation: HostedDeploymentSafetyExpectationV1;
  readonly generatedAt: () => string;
  readonly hostNonce: string;
  readonly ssh: SshDeploymentProbeOptions;
}

/** Composition factory for a future CLI. It performs no I/O until collect() is called. */
export function createConcreteSshDeploymentSafetyProbe(
  options: ConcreteSshDeploymentSafetyProbeOptions,
  commands?: SshDeploymentSafetyCommands,
): SshDeploymentSafetyProbe {
  const probeOptions: SshDeploymentSafetyProbeOptions = {
    containerNonce: nonceSchema.parse(options.containerNonce),
    expectation: hostedDeploymentSafetyExpectationV1Schema.parse(options.expectation),
    generatedAt: options.generatedAt,
    hostNonce: nonceSchema.parse(options.hostNonce),
  };
  return new SshDeploymentSafetyProbe(
    probeOptions,
    new ConcreteSshDeploymentSafetyProbeRunner(options.ssh, probeOptions.expectation, commands),
  );
}
