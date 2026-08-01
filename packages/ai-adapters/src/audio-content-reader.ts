export interface AudioContent {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mediaType: string;
}

export interface AudioContentReader {
  read(audioLocator: string): Promise<AudioContent>;
}
