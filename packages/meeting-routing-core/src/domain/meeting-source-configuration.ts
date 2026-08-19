const maximumExternalIdLength = 256;

export type MeetingSourceConfigurationStatus = "active";

export interface MeetingSourceConfigurationSnapshot {
  readonly configuredByActorId: string;
  readonly publicationTargetId: string;
  readonly revision: number;
  readonly roomId: string;
  readonly sourceId: string;
  readonly status: MeetingSourceConfigurationStatus;
}

export interface ConfigureMeetingSourceRoute {
  readonly configuredByActorId: string;
  readonly publicationTargetId: string;
  readonly roomId: string;
  readonly sourceId: string;
}

export class InvalidMeetingSourceConfigurationError extends Error {
  public override readonly name = "InvalidMeetingSourceConfigurationError";
}

function requireExternalId(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumExternalIdLength
  ) {
    throw new InvalidMeetingSourceConfigurationError(
      `${field} must be a non-empty external identifier of at most ${maximumExternalIdLength} characters`,
    );
  }
  return value;
}

function requireRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidMeetingSourceConfigurationError(
      "revision must be a non-negative safe integer",
    );
  }
  return value;
}

function normalize(
  input: MeetingSourceConfigurationSnapshot,
): MeetingSourceConfigurationSnapshot {
  const rawStatus: unknown = input.status;
  if (rawStatus !== "active") {
    throw new InvalidMeetingSourceConfigurationError("status must be active");
  }
  return Object.freeze({
    configuredByActorId: requireExternalId(
      input.configuredByActorId,
      "configuredByActorId",
    ),
    publicationTargetId: requireExternalId(
      input.publicationTargetId,
      "publicationTargetId",
    ),
    revision: requireRevision(input.revision),
    roomId: requireExternalId(input.roomId, "roomId"),
    sourceId: requireExternalId(input.sourceId, "sourceId"),
    status: rawStatus,
  });
}

export class MeetingSourceConfiguration {
  private constructor(
    private readonly snapshot: MeetingSourceConfigurationSnapshot,
  ) {}

  public static configure(
    input: ConfigureMeetingSourceRoute,
  ): MeetingSourceConfiguration {
    return new MeetingSourceConfiguration(
      normalize({ ...input, revision: 0, status: "active" }),
    );
  }

  public static restore(
    snapshot: MeetingSourceConfigurationSnapshot,
  ): MeetingSourceConfiguration {
    return new MeetingSourceConfiguration(normalize(snapshot));
  }

  public get revision(): number {
    return this.snapshot.revision;
  }

  public get sourceId(): string {
    return this.snapshot.sourceId;
  }

  public matchesRoute(roomId: string, publicationTargetId: string): boolean {
    return this.snapshot.roomId === roomId &&
      this.snapshot.publicationTargetId === publicationTargetId;
  }

  public matchesRoom(roomId: string): boolean {
    return this.snapshot.roomId === roomId;
  }

  public reconfigure(
    input: ConfigureMeetingSourceRoute,
  ): MeetingSourceConfiguration {
    if (input.sourceId !== this.snapshot.sourceId) {
      throw new InvalidMeetingSourceConfigurationError(
        "source identity cannot change",
      );
    }
    requireExternalId(input.configuredByActorId, "configuredByActorId");
    requireExternalId(input.roomId, "roomId");
    requireExternalId(input.publicationTargetId, "publicationTargetId");
    if (this.matchesRoute(input.roomId, input.publicationTargetId)) {
      return this;
    }
    if (this.snapshot.revision === Number.MAX_SAFE_INTEGER) {
      throw new InvalidMeetingSourceConfigurationError(
        "revision cannot be incremented safely",
      );
    }
    return new MeetingSourceConfiguration(normalize({
      ...input,
      revision: this.snapshot.revision + 1,
      status: "active",
    }));
  }

  public toSnapshot(): MeetingSourceConfigurationSnapshot {
    return this.snapshot;
  }
}
