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

export function validateQualificationExecutionPacket(value: unknown):
import("./execute-admitted-qualification-question.js").QualificationExecutionPacket {
  const record = exactObject(value, ["locale", "questionId", "questionText",
    "scopeTopologyReference", "source"], "qualification execution packet");
  if ((record.locale !== "en" && record.locale !== "mixed" && record.locale !== "ru") ||
    (record.source !== "automatic" && record.source !== "independent_review") ||
    !safeText(record.questionId, 128) || !safeText(record.questionText, 4_096) ||
    !safeText(record.scopeTopologyReference, 512)) {
    throw new Error("qualification execution packet is invalid");
  }
  return Object.freeze(record as unknown as
    import("./execute-admitted-qualification-question.js").QualificationExecutionPacket);
}

export function validateQualificationGoldPacket(value: unknown): QualificationGoldPacket {
  const record = exactObject(value, ["abstentionAuthority", "evidenceLocators",
    "expectedClaims", "forbiddenClaims", "questionId", "speakerTimeAuthority"],
  "qualification gold packet");
  if ((record.abstentionAuthority !== "answerable" &&
      record.abstentionAuthority !== "must_abstain") ||
    !safeText(record.questionId, 128) || !stringArray(record.evidenceLocators) ||
    !stringArray(record.expectedClaims) || !stringArray(record.forbiddenClaims) ||
    !Array.isArray(record.speakerTimeAuthority)) {
    throw new Error("qualification gold packet is invalid");
  }
  const speakerTimeAuthority = record.speakerTimeAuthority.map((authorityValue) => {
    const authority = exactObject(authorityValue, ["endMs", "speakerId", "startMs"],
      "speaker/time authority");
    if (!Number.isSafeInteger(authority.startMs) || !Number.isSafeInteger(authority.endMs) ||
      Number(authority.startMs) < 0 || Number(authority.endMs) <= Number(authority.startMs) ||
      !safeText(authority.speakerId, 128)) {
      throw new Error("qualification speaker/time authority is invalid");
    }
    return Object.freeze(authority as unknown as
      QualificationGoldPacket["speakerTimeAuthority"][number]);
  });
  return Object.freeze({ ...record, evidenceLocators: Object.freeze([...record.evidenceLocators]),
    expectedClaims: Object.freeze([...record.expectedClaims]),
    forbiddenClaims: Object.freeze([...record.forbiddenClaims]),
    speakerTimeAuthority: Object.freeze(speakerTimeAuthority) } as QualificationGoldPacket);
}

function exactObject(value: unknown, keys: readonly string[], label: string):
Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify([...keys].toSorted())) {
    throw new Error(`${label} has an invalid shape`);
  }
  return value as Record<string, unknown>;
}

function safeText(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximumLength;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => safeText(item, 4_096));
}
