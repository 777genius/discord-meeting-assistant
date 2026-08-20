export interface FocusedEvidenceSelectionCandidateV1 {
  readonly candidateId: string;
  readonly endMs: number;
  readonly snippet: string;
  readonly speakerReference: string;
  readonly startMs: number;
}

export type FocusedEvidenceSelectionResultV1 =
  | {
      readonly selectedCandidateIds: readonly string[];
      readonly schemaVersion: 1;
      readonly status: "selected";
    }
  | {
      readonly selectedCandidateIds: readonly [];
      readonly schemaVersion: 1;
      readonly status: "insufficient_evidence";
    };

export interface FocusedEvidenceSelectorPort {
  readonly profile: string;
  select(input: {
    readonly attemptId: string;
    readonly candidates: readonly FocusedEvidenceSelectionCandidateV1[];
    readonly question: string;
    readonly signal?: AbortSignal;
  }): Promise<FocusedEvidenceSelectionResultV1>;
}
