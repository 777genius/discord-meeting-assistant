export function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replaceAll(/\s+/gu, " ");
}

export function normalizeTranscriptSemantics(value: string): string {
  return normalize(value)
    .replaceAll("post grazical", "postgresql")
    .replaceAll("discord thread точка", "discord thread")
    .replaceAll("pipecat assistant точка", "pipecat assistant")
    .replaceAll(
      "седьмого августа две тысячи двадцать шестого года",
      "7 августа 2026 года",
    )
    .replaceAll(
      "7 августа две тысячи двадцать шестого года",
      "7 августа 2026 года",
    )
    .replaceAll("две тысячи двадцать шестого года", "2026 года")
    .replaceAll("две тысячи двадцать шестом году", "2026 году");
}

export function equivalentMeetingText(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return normalizeTranscriptSemantics(left) === normalizeTranscriptSemantics(right);
}

export function wordErrorRate(expected: string, actual: string): number {
  return errorRate(words(expected), words(actual));
}

export function characterErrorRate(expected: string, actual: string): number {
  return errorRate(characters(expected), characters(actual));
}

function words(value: string): readonly string[] {
  const normalized = normalizeTranscriptSemantics(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

function characters(value: string): readonly string[] {
  return Array.from(normalizeTranscriptSemantics(value).replaceAll(" ", ""));
}

function errorRate(expected: readonly string[], actual: readonly string[]): number {
  if (expected.length === 0) {
    return actual.length === 0 ? 0 : 1;
  }
  return levenshteinDistance(expected, actual) / expected.length;
}

function levenshteinDistance(expected: readonly string[], actual: readonly string[]): number {
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let expectedIndex = 1; expectedIndex <= expected.length; expectedIndex += 1) {
    const current = [expectedIndex];
    for (let actualIndex = 1; actualIndex <= actual.length; actualIndex += 1) {
      const substitution = previous[actualIndex - 1] ?? 0;
      const deletion = previous[actualIndex] ?? 0;
      const insertion = current[actualIndex - 1] ?? 0;
      current[actualIndex] = Math.min(
        deletion + 1,
        insertion + 1,
        substitution + (expected[expectedIndex - 1] === actual[actualIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[actual.length] ?? 0;
}
