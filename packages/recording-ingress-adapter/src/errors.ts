export type RecordingIngressFailure =
  | "aborted"
  | "artifact-write-mismatch"
  | "conflicting-duplicate"
  | "corrupt-spool"
  | "invalid-input"
  | "invalid-state"
  | "limit-exceeded"
  | "path-policy"
  | "unsupported-event";

export class RecordingIngressError extends Error {
  public readonly code = "RECORDING_INGRESS_FAILURE";
  public readonly failure: RecordingIngressFailure;

  public constructor(
    failure: RecordingIngressFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RecordingIngressError";
    this.failure = failure;
  }
}

export class RecordingIngressAbortedError extends RecordingIngressError {
  public constructor(options?: ErrorOptions) {
    super("aborted", "recording ingress operation was aborted", options);
    this.name = "RecordingIngressAbortedError";
  }
}
