import {
  MeetingSourceConfiguration,
  type MeetingSourceConfigurationSnapshot,
} from "../domain/meeting-source-configuration.js";
import type {
  MeetingSourceConfigurationRepository,
  MeetingSourceConfigurationVerificationPort,
  MeetingSourceSetupFailure,
  MeetingSourceSetupPublisher,
} from "./ports.js";

export interface ConfigureMeetingSourceInput {
  readonly configuredByActorId: string;
  readonly publicationTargetId: string;
  readonly roomId: string;
  readonly sourceId: string;
}

export type ConfigureMeetingSourceResult =
  | {
      readonly configuration: MeetingSourceConfigurationSnapshot;
      readonly idempotencyKey: string;
      readonly status: "configured" | "reused";
    }
  | { readonly actualRevision: number; readonly status: "conflict" }
  | { readonly failure: MeetingSourceSetupFailure; readonly status: "rejected" };

export class ConfigureMeetingSource {
  public constructor(
    private readonly repository: MeetingSourceConfigurationRepository,
    private readonly verifier: MeetingSourceConfigurationVerificationPort,
    private readonly publisher: MeetingSourceSetupPublisher,
  ) {}

  public async execute(
    input: ConfigureMeetingSourceInput,
  ): Promise<ConfigureMeetingSourceResult> {
    const stored = await this.repository.findBySourceId(input.sourceId);
    const current = stored === null
      ? null
      : MeetingSourceConfiguration.restore(stored);
    const verification = await this.verifier.verify(input);
    if (!verification.ok) {
      return { failure: verification.failure, status: "rejected" };
    }
    if (
      current !== null &&
      current.matchesRoute(input.roomId, input.publicationTargetId)
    ) {
      const configuration = current.toSnapshot();
      return {
        configuration,
        idempotencyKey: setupIdempotencyKey(configuration),
        status: "reused",
      };
    }
    const next = current === null
      ? MeetingSourceConfiguration.configure(input)
      : current.reconfigure(input);
    const configuration = next.toSnapshot();
    const idempotencyKey = setupIdempotencyKey(configuration);
    const publication = await this.publisher.publish({
      ...input,
      configurationRevision: configuration.revision,
      idempotencyKey,
    });
    if (!publication.ok) {
      return { failure: publication.failure, status: "rejected" };
    }
    const saved = await this.repository.save(
      configuration,
      current?.revision ?? null,
    );
    if (saved.status === "conflict") {
      return saved;
    }
    return { configuration, idempotencyKey, status: "configured" };
  }
}

function setupIdempotencyKey(
  configuration: MeetingSourceConfigurationSnapshot,
): string {
  return [
    "meeting-source-setup:v1",
    configuration.sourceId,
    configuration.revision,
    configuration.roomId,
    configuration.publicationTargetId,
  ].map((part) => {
    const value = String(part);
    return `${value.length}:${value}`;
  }).join("|");
}
