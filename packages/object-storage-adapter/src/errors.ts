export type InvalidArtifactLocatorReason =
  | "bucket-not-allowed"
  | "invalid-bucket"
  | "invalid-key"
  | "invalid-scheme"
  | "key-outside-prefix"
  | "non-canonical-locator";

export class InvalidArtifactLocatorError extends Error {
  public readonly code = "INVALID_ARTIFACT_LOCATOR";

  public constructor(public readonly reason: InvalidArtifactLocatorReason) {
    super(`artifact locator rejected: ${reason}`);
    this.name = "InvalidArtifactLocatorError";
  }
}

export type ArtifactIntegrityFailure =
  | "checksum-mismatch"
  | "invalid-metadata"
  | "missing-body"
  | "missing-checksum"
  | "missing-content-type"
  | "missing-size"
  | "size-mismatch"
  | "unsupported-body";

export class ArtifactIntegrityError extends Error {
  public readonly code = "ARTIFACT_INTEGRITY_FAILURE";

  public constructor(
    public readonly failure: ArtifactIntegrityFailure,
    options?: ErrorOptions,
  ) {
    super(`artifact integrity validation failed: ${failure}`, options);
    this.name = "ArtifactIntegrityError";
  }
}

export class ArtifactNotFoundError extends Error {
  public readonly code = "ARTIFACT_NOT_FOUND";

  public constructor(options?: ErrorOptions) {
    super("artifact was not found", options);
    this.name = "ArtifactNotFoundError";
  }
}

export class ArtifactOperationCancelledError extends Error {
  public readonly code = "ARTIFACT_OPERATION_CANCELLED";

  public constructor(options?: ErrorOptions) {
    super("artifact operation was cancelled", options);
    this.name = "ArtifactOperationCancelledError";
  }
}

export class ArtifactStorageOperationError extends Error {
  public readonly code = "ARTIFACT_STORAGE_OPERATION_FAILED";

  public constructor(
    public readonly operation: "read" | "write",
    options: ErrorOptions,
  ) {
    super(`artifact ${operation} failed`, options);
    this.name = "ArtifactStorageOperationError";
  }
}
