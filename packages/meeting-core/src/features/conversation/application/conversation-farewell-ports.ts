export interface ConversationFarewellTurn {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

export interface ConversationFarewellClassificationInput {
  readonly meetingId: string;
  readonly participantIds: readonly string[];
  readonly participantNames: Readonly<Record<string, string>>;
  readonly revision: number;
  readonly turns: readonly ConversationFarewellTurn[];
}

export interface ConversationFarewellClassifier {
  classify(
    input: ConversationFarewellClassificationInput,
  ): Promise<"en" | "reject" | "ru">;
}

export interface ConversationFarewellCue {
  readonly cueId: string;
  readonly pcmChunks: readonly Uint8Array[];
  readonly playbackAttemptId: string;
}

export interface ConversationFarewellCueRegistry {
  select(input: {
    readonly locale: "en" | "ru";
    readonly meetingId: string;
    readonly voiceProfileId: string;
  }): ConversationFarewellCue | null;
}
