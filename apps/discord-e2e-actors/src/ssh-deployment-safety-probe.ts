import type {
  HostedDeploymentSafetyExpectationV1,
  HostedDeploymentSafetyReceiptV1,
} from "./hosted-deployment-safety-receipt.js";
import {
  createHostedDeploymentSafetyReceiptV1,
  hostedDeploymentSafetyExpectationV1Schema,
} from "./hosted-deployment-safety-receipt.js";

export interface SshDeploymentSafetyProbeRunner {
  readonly inspectDeployment: () => Promise<unknown>;
  readonly observeHostNonceInContainer: (probeRoot: string, nonce: string) => Promise<string>;
  readonly observeContainerNonceOnHost: (probeRoot: string, nonce: string) => Promise<string>;
}

export interface SshDeploymentSafetyProbeOptions {
  readonly expectation: HostedDeploymentSafetyExpectationV1;
  readonly generatedAt: () => string;
  readonly hostNonce: string;
  readonly containerNonce: string;
}

/**
 * Coordinates a bounded deployment probe. The concrete remote runner is injected so
 * unit/CI execution cannot accidentally contact a host.
 */
export class SshDeploymentSafetyProbe {
  readonly #options: SshDeploymentSafetyProbeOptions;
  readonly #runner: SshDeploymentSafetyProbeRunner;

  public constructor(
    options: SshDeploymentSafetyProbeOptions,
    runner: SshDeploymentSafetyProbeRunner,
  ) {
    const expectation = hostedDeploymentSafetyExpectationV1Schema.parse(options.expectation);
    if (options.hostNonce === options.containerNonce) {
      throw new Error("Deployment safety probe nonces must be distinct");
    }
    this.#options = { ...options, expectation };
    this.#runner = runner;
  }

  public async collect(): Promise<HostedDeploymentSafetyReceiptV1> {
    const before = await this.#runner.inspectDeployment();
    const probeRoot = `${this.#options.expectation.campaignRoot}/.admission-probes/${this.#options.expectation.campaignId}`;
    const containerObservedHostNonce = await this.#runner.observeHostNonceInContainer(
      probeRoot,
      this.#options.hostNonce,
    );
    const hostObservedContainerNonce = await this.#runner.observeContainerNonceOnHost(
      probeRoot,
      this.#options.containerNonce,
    );
    const after = await this.#runner.inspectDeployment();
    return createHostedDeploymentSafetyReceiptV1({
      evidence: mergeProbeEvidence(before, after, {
        containerObservedHostNonce,
        containerWrittenNonce: this.#options.containerNonce,
        hostObservedContainerNonce,
        hostWrittenNonce: this.#options.hostNonce,
        probeRoot,
      }),
      expectation: this.#options.expectation,
      generatedAt: this.#options.generatedAt(),
    });
  }
}

function mergeProbeEvidence(
  beforeValue: unknown,
  afterValue: unknown,
  roundTrip: Readonly<Record<string, string>>,
): unknown {
  if (!isRecord(beforeValue) || !isRecord(afterValue)) {
    throw new Error("Deployment safety probe returned an invalid snapshot");
  }
  return {
    greetingMountAfter: afterValue.greetingMount,
    greetingMount: beforeValue.greetingMount,
    roots: beforeValue.roots,
    rootsAfter: afterValue.roots,
    roundTrip,
    servicesAfter: afterValue.services,
    servicesBefore: beforeValue.services,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
