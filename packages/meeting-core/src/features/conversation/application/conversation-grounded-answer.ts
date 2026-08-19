import type {
  ConversationStartRequest,
  GroundedKnowledgeAnswerRequest,
} from "./ports/conversation.js";

const maximumAnswerCharacters = 2_000;
const maximumCitations = 32;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export interface ValidatedGroundedKnowledgeAnswer {
  readonly citations: readonly { readonly turnId: string }[];
  readonly evidenceEpoch: string;
  readonly knowledgeEpoch: string;
  readonly plainText: string;
}

/**
 * Validates the complete, buffered answer before any literal-speech request is
 * constructed. Partial streams and provider objects have no speech path.
 */
export function validateCompleteGroundedKnowledgeAnswer(
  value: unknown,
): ValidatedGroundedKnowledgeAnswer | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "citations",
    "evidenceEpoch",
    "knowledgeEpoch",
    "plainText",
    "schemaVersion",
    "status",
  ])) {
    return null;
  }
  if (value.schemaVersion !== 1 || value.status !== "answered") {
    return null;
  }
  const plainText = normalizedSafeSpeech(value.plainText);
  const evidenceEpoch = boundedIdentifier(value.evidenceEpoch);
  const knowledgeEpoch = boundedIdentifier(value.knowledgeEpoch);
  if (
    plainText === null || evidenceEpoch === null || knowledgeEpoch === null ||
    !Array.isArray(value.citations) || value.citations.length === 0 ||
    value.citations.length > maximumCitations
  ) {
    return null;
  }
  const citations: { readonly turnId: string }[] = [];
  for (const candidate of value.citations) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["turnId"])) {
      return null;
    }
    const turnId = boundedIdentifier(candidate.turnId);
    if (turnId === null) {
      return null;
    }
    citations.push(Object.freeze({ turnId }));
  }
  if (new Set(citations.map(({ turnId }) => turnId)).size !== citations.length) {
    return null;
  }
  return Object.freeze({
    citations: Object.freeze(citations),
    evidenceEpoch,
    knowledgeEpoch,
    plainText,
  });
}

export function groundedLiteralSpeechRequest(
  request: ConversationStartRequest,
  groundedRequest: GroundedKnowledgeAnswerRequest,
  completeAnswer: unknown,
): ConversationStartRequest | null {
  if (
    request.meetingId !== groundedRequest.meetingId ||
    request.speakerId !== groundedRequest.participantId ||
    request.prompt !== groundedRequest.question ||
    request.locale !== groundedRequest.locale
  ) {
    return null;
  }
  const answer = validateCompleteGroundedKnowledgeAnswer(completeAnswer);
  return answer === null
    ? null
    : Object.freeze({ ...request, literalSpeech: answer.plainText });
}

function normalizedSafeSpeech(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.normalize("NFKC").trim();
  return normalized.length > 0 && normalized.length <= maximumAnswerCharacters &&
    !containsUnsafeSpeechCodePoint(normalized)
    ? normalized
    : null;
}

function containsUnsafeSpeechCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x08 || codePoint === 0x0B || codePoint === 0x0C ||
      (codePoint >= 0x0E && codePoint <= 0x1F) ||
      (codePoint >= 0x7F && codePoint <= 0x9F) ||
      (codePoint >= 0x202A && codePoint <= 0x202E) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" && identifierPattern.test(value)
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}
