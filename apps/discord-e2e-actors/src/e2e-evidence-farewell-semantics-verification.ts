import { normalizeTranscriptSemantics } from "./e2e-evidence-text-metrics.js";
import type {
  RetainedE2eEvidenceV8,
} from "./e2e-evidence-schema.js";
import type {
  VerificationFailureReporter,
} from "./e2e-evidence-verification-types.js";

interface BotikFarewellExpectation {
  readonly duplicateTerms: readonly string[];
  readonly endMs: number;
  readonly exactPhrases: readonly string[];
  readonly locale: "en" | "ru";
  readonly requiredTerms: readonly string[];
  readonly startMs: number;
}

export function verifyBotikFarewellTranscript(
  evidence: RetainedE2eEvidenceV8,
  expectation: BotikFarewellExpectation,
  fail: VerificationFailureReporter,
): void {
  const botikTurns = evidence.transcript.turns.filter(
    ({ speakerId }) => speakerId === evidence.conversation.botSpeakerId,
  );
  const captureTurns = botikTurns.filter((turn) =>
    turn.startMs >= expectation.startMs && turn.endMs <= expectation.endMs
  );
  const capturedFarewell = captureTurns[0];
  const hasCapturedSemanticFarewell = capturedFarewell !== undefined &&
    matchesExactPhrase(capturedFarewell.text, expectation.exactPhrases);
  if (
    expectation.requiredTerms.length === 0 || expectation.exactPhrases.length === 0 ||
    captureTurns.length !== 1 ||
    !hasCapturedSemanticFarewell
  ) {
    fail(
      "SUPPLEMENTAL_FAREWELL_SEMANTICS_MISSING",
      `audible ${expectation.locale} farewell must overlap exactly one semantic Botik transcript turn`,
    );
  }
  if (
    hasCapturedSemanticFarewell &&
    containsFarewellOutsideCapture(botikTurns, capturedFarewell, expectation)
  ) {
    fail(
      "SUPPLEMENTAL_FAREWELL_DUPLICATE",
      "a second farewell-shaped Botik turn exists outside the settled farewell capture",
    );
  }
}

function containsFarewellOutsideCapture(
  turns: readonly RetainedE2eEvidenceV8["transcript"]["turns"][number][],
  capturedFarewell: RetainedE2eEvidenceV8["transcript"]["turns"][number],
  expectation: BotikFarewellExpectation,
): boolean {
  const outside = turns.filter((turn) => turn !== capturedFarewell);
  for (let index = 0; index < outside.length; index += 1) {
    const current = outside[index]!;
    const adjacent = outside[index + 1];
    if (containsAnyWholeTerm(current.text, expectation.duplicateTerms)) {
      return true;
    }
    if (
      adjacent !== undefined &&
      containsAnyWholeTerm(`${current.text} ${adjacent.text}`, expectation.duplicateTerms)
    ) {
      return true;
    }
  }
  return false;
}

function matchesExactPhrase(text: string, phrases: readonly string[]): boolean {
  const normalized = normalizeTranscriptSemantics(text);
  return phrases.some((phrase) => normalized === normalizeTranscriptSemantics(phrase));
}

export function turnsContainingAnyTerms<T extends { readonly text: string }>(
  turns: readonly T[],
  terms: readonly string[],
): readonly T[] {
  return turns.filter(({ text }) => containsAnyWholeTerm(text, terms));
}

function containsAnyWholeTerm(text: string, terms: readonly string[]): boolean {
  const normalizedText = normalizeTranscriptSemantics(text);
  return terms.some((term) =>
    containsWholeTerm(normalizedText, normalizeTranscriptSemantics(term))
  );
}

function containsWholeTerm(normalizedText: string, normalizedTerm: string): boolean {
  return ` ${normalizedText} `.includes(` ${normalizedTerm} `);
}
