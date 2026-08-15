import type { AnswerLocale } from "./answer-locale.js";
import {
  MeetingKnowledgeInvariantError,
  requireKnowledgeText,
} from "./errors.js";
import type { GroundingEvidence } from "./grounding-plan.js";

export type GroundedAnswerStatus =
  | "answered"
  | "insufficient_evidence"
  | "not_a_question";

export interface GroundedClaimCandidate {
  readonly evidenceIds: readonly string[];
  readonly text: string;
}

export interface GroundedAnswerCandidate {
  readonly claims: readonly GroundedClaimCandidate[];
  readonly locale: AnswerLocale;
  readonly status: GroundedAnswerStatus;
}

export interface GroundedClaim {
  readonly evidenceIds: readonly string[];
  readonly support: "complete_coverage_absence" | "cited_turns";
  readonly text: string;
}

type ValidatedGroundedAnswer = Omit<GroundedAnswerCandidate, "claims"> & {
  readonly claims: readonly GroundedClaim[];
};

export type FixedFinalReplyOutcome =
  | "insufficient_evidence"
  | "not_a_question"
  | "processing"
  | "unavailable"
  | "unsupported_size";

const unsafeOutput = /(?:<[@#][!&]?\d|@everyone|@here|\[[^\]]*\]\(|```|\u202A|\u202B|\u202D|\u202E|\u202C|\u2066|\u2067|\u2068|\u2069)/iu;
const unsafeLink = /(?:\b[a-z][a-z0-9+.-]{1,31}:\/\/|\bmailto:|\bwww\.|\bdiscord\.gg\/|\bdiscord(?:app)?\.com\/invite\/|\b[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,62}\.)+[a-z]{2,63}(?:[/?#][^\s]*)?)/iu;

function containsForbiddenControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 8 ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        codePoint === 127)
    ) {
      return true;
    }
  }
  return false;
}

function assertSafeClaim(text: string): void {
  if (
    unsafeOutput.test(text) ||
    unsafeLink.test(text) ||
    containsForbiddenControl(text)
  ) {
    throw new MeetingKnowledgeInvariantError(
      "UNSAFE_OUTPUT",
      "answer claim contains forbidden mentions, links, markup, or control text",
    );
  }
}

function quotedSpans(text: string): readonly string[] {
  const spans: string[] = [];
  const pattern = /"([^"\n]{1,300})"|“([^”\n]{1,300})”|«([^»\n]{1,300})»/gu;
  for (const match of text.matchAll(pattern)) {
    const span = match[1] ?? match[2] ?? match[3];
    if (span !== undefined) {
      spans.push(span);
    }
  }
  if (/["“”«»]/u.test(text.replace(pattern, ""))) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_PROVIDER_ANSWER",
      "answer claim contains an unvalidated quotation form",
    );
  }
  return spans;
}

export class GroundedAnswer {
  public readonly claims: readonly GroundedClaim[];
  public readonly locale: AnswerLocale;
  public readonly status: GroundedAnswerStatus;

  private constructor(candidate: ValidatedGroundedAnswer) {
    this.claims = Object.freeze(candidate.claims.map((claim) => Object.freeze({
      evidenceIds: Object.freeze([...claim.evidenceIds]),
      support: claim.support,
      text: claim.text,
    })));
    this.locale = candidate.locale;
    this.status = candidate.status;
    Object.freeze(this);
  }

  public static create(input: {
    readonly candidate: GroundedAnswerCandidate;
    readonly evidence: readonly GroundingEvidence[];
    readonly expectedLocale: AnswerLocale;
    readonly exhaustiveAbsenceProven?: boolean;
  }): GroundedAnswer {
    const { candidate } = input;
    const candidateLocale: unknown = candidate.locale;
    if (
      candidateLocale !== "en" &&
      candidateLocale !== "mixed" &&
      candidateLocale !== "ru"
    ) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_PROVIDER_ANSWER",
        "provider answer locale is unsupported",
      );
    }
    if (candidateLocale !== input.expectedLocale) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_PROVIDER_ANSWER",
        "provider answer locale does not match the persisted question policy",
      );
    }
    const candidateStatus: unknown = candidate.status;
    if (
      candidateStatus !== "answered" &&
      candidateStatus !== "insufficient_evidence" &&
      candidateStatus !== "not_a_question"
    ) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_PROVIDER_ANSWER",
        "provider answer status is unsupported",
      );
    }
    if (candidate.status !== "answered") {
      if (candidate.claims.length !== 0) {
        throw new MeetingKnowledgeInvariantError(
          "INVALID_PROVIDER_ANSWER",
          "non-answered provider results cannot contain claims",
        );
      }
      return new GroundedAnswer({ ...candidate, claims: [] });
    }
    if (candidate.claims.length < 1 || candidate.claims.length > 12) {
      throw new MeetingKnowledgeInvariantError(
        "INVALID_PROVIDER_ANSWER",
        "answered provider results require between one and twelve claims",
      );
    }
    const evidenceById = new Map(
      input.evidence.map((evidence) => [evidence.evidenceId, evidence]),
    );
    const admittedEvidence = new Set(evidenceById.keys());
    const normalizedClaims = candidate.claims.map((claim, claimIndex) => {
      const text = requireKnowledgeText(
        claim.text,
        `claims[${claimIndex}].text`,
        600,
      );
      assertSafeClaim(text);
      const uncitedAbsence = claim.evidenceIds.length === 0 &&
        input.exhaustiveAbsenceProven === true;
      if ((!uncitedAbsence && claim.evidenceIds.length < 1) || claim.evidenceIds.length > 8) {
        throw new MeetingKnowledgeInvariantError(
          "INVALID_PROVIDER_ANSWER",
          "each answer claim requires between one and eight citations",
        );
      }
      const evidenceIds = claim.evidenceIds.map((evidenceId) =>
        requireKnowledgeText(evidenceId, "claim.evidenceId", 64)
      );
      if (new Set(evidenceIds).size !== evidenceIds.length) {
        throw new MeetingKnowledgeInvariantError(
          "DUPLICATE_EVIDENCE",
          "a claim cannot repeat an evidence citation",
        );
      }
      if (evidenceIds.some((evidenceId) => !admittedEvidence.has(evidenceId))) {
        throw new MeetingKnowledgeInvariantError(
          "INVALID_PROVIDER_ANSWER",
          "a claim cites evidence outside the admitted grounding plan",
        );
      }
      const citedText = evidenceIds.map((evidenceId) =>
        evidenceById.get(evidenceId)?.text ?? ""
      );
      if (
        quotedSpans(text).some((quote) =>
          !citedText.some((canonicalText) => canonicalText.includes(quote))
        )
      ) {
        throw new MeetingKnowledgeInvariantError(
          "INVALID_PROVIDER_ANSWER",
          "an exact quote must occur in the locally rehydrated cited evidence",
        );
      }
      return Object.freeze({
        evidenceIds: Object.freeze(evidenceIds),
        support: uncitedAbsence
          ? "complete_coverage_absence" as const
          : "cited_turns" as const,
        text,
      });
    });
    return new GroundedAnswer({ ...candidate, claims: normalizedClaims });
  }

  public toSnapshot(): GroundedAnswerCandidate {
    return {
      claims: this.claims.map(({ evidenceIds, text }) => ({
        evidenceIds: [...evidenceIds],
        text,
      })),
      locale: this.locale,
      status: this.status,
    };
  }
}
