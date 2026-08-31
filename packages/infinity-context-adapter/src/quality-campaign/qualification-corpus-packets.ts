export interface QualificationGoldPacket {
  readonly abstentionAuthority: "answerable" | "must_abstain";
  readonly evidenceLocators: readonly string[];
  readonly expectedClaims: readonly string[];
  readonly forbiddenClaims: readonly string[];
  readonly questionId: string;
  readonly speakerTimeAuthority: readonly {
    readonly endMs: number;
    readonly speakerId: string;
    readonly startMs: number;
  }[];
}

/** Gold is a scoring/adjudication boundary and is intentionally not imported by execute. */
export interface QualificationGoldScoringPort {
  admitAfterTerminal(input: QualificationGoldPacket,
    terminalOutcomeReference: string): Promise<void>;
}
