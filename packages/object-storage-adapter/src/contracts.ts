export interface BinaryArtifactExpectation {
  readonly checksumSha256?: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
}

export interface BinaryArtifactReadRequest {
  readonly expected?: BinaryArtifactExpectation;
  readonly locator: string;
  readonly signal?: AbortSignal;
}

export interface BinaryArtifactReadResult {
  /**
   * The stream validates its byte count and SHA-256 digest before completing.
   * A consumer must fully drain it before treating the artifact as verified.
   */
  readonly body: AsyncIterable<Uint8Array>;
  readonly checksumSha256: string;
  readonly contentType: string;
  readonly eTag?: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly sizeBytes: number;
  readonly versionId?: string;
}

export interface BinaryArtifactReader {
  read(request: BinaryArtifactReadRequest): Promise<BinaryArtifactReadResult>;
}

export interface BinaryArtifactWriteRequest {
  readonly body: AsyncIterable<Uint8Array> | Uint8Array;
  readonly checksumSha256: string;
  readonly contentType: string;
  readonly locator: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly sizeBytes: number;
}

export interface BinaryArtifactWriteReceipt {
  readonly checksumSha256: string;
  readonly eTag?: string;
  readonly locator: string;
  readonly sizeBytes: number;
  readonly versionId?: string;
}

export interface BinaryArtifactWriter {
  write(request: BinaryArtifactWriteRequest): Promise<BinaryArtifactWriteReceipt>;
}
