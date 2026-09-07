// Infinity a917: application/normalize.py and document_text.py, Python Unicode 15.
// Python whitespace includes U+001C..001F/U+0085 and excludes U+FEFF.
const pythonWhitespace = new Set([
  9, 10, 11, 12, 13, 28, 29, 30, 31, 32, 133, 160, 5760,
  8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
  8232, 8233, 8239, 8287, 12288,
]);
// Exhaustive four-context comparison against Python 15: differences in lower,
// Cased or Case_Ignorable. These are rejected only for inputs containing Sigma.
const sigmaContextDifferences: readonly (readonly [number, number])[] = [
  [0x295, 0x295],
  [0x897, 0x897],
  [0x1acf, 0x1add],
  [0x1ae0, 0x1aeb],
  [0x1c89, 0x1c8a],
  [0xa7cb, 0xa7cf],
  [0xa7d2, 0xa7d2],
  [0xa7d4, 0xa7d4],
  [0xa7da, 0xa7dc],
  [0xa7f1, 0xa7f1],
  [0x10d4e, 0x10d4e],
  [0x10d50, 0x10d65],
  [0x10d69, 0x10d6d],
  [0x10d6f, 0x10d85],
  [0x10ec5, 0x10ec5],
  [0x10efa, 0x10efc],
  [0x113bb, 0x113c0],
  [0x113ce, 0x113ce],
  [0x113d0, 0x113d0],
  [0x113d2, 0x113d2],
  [0x113e1, 0x113e2],
  [0x1171e, 0x1171e],
  [0x11b60, 0x11b60],
  [0x11b62, 0x11b64],
  [0x11b66, 0x11b66],
  [0x11dd9, 0x11dd9],
  [0x11f5a, 0x11f5a],
  [0x1611e, 0x16129],
  [0x1612d, 0x1612f],
  [0x16d40, 0x16d42],
  [0x16d6b, 0x16d6c],
  [0x16ea0, 0x16eb8],
  [0x16ebb, 0x16ed3],
  [0x16ff2, 0x16ff3],
  [0x1e5ee, 0x1e5ef],
  [0x1e6e3, 0x1e6e3],
  [0x1e6e6, 0x1e6e6],
  [0x1e6ee, 0x1e6ef],
  [0x1e6f5, 0x1e6f5],
  [0x1e6ff, 0x1e6ff],
];
const sigmaContextCodepoints = new Set(sigmaContextDifferences.flatMap(([first, last]) =>
  Array.from({ length: last - first + 1 }, (_, index) => first + index),
));
const opaqueTitle = /^mkevidence1\.[A-Za-z0-9_-]{43}$/u;

function assertSupportedUnicode(text: string): void {
  const hasSigma = text.includes("Σ");
  for (const character of text) {
    const point = character.codePointAt(0)!;
    // Exhaustively compared Python 3.12 (Unicode 15) with Node 24 (Unicode 17).
    // Reject newer lowercase mappings and lone surrogates instead of budgeting
    // different bytes. Sigma uses Python-compatible context properties; reject
    // only inputs containing codepoints where those properties differ.
    if (
      (hasSigma && sigmaContextCodepoints.has(point)) ||
      point === 0x1c89 ||
      [0xa7cb, 0xa7cc, 0xa7ce, 0xa7d2, 0xa7d4, 0xa7da, 0xa7dc].includes(point) ||
      (point >= 0x10d50 && point <= 0x10d65) ||
      (point >= 0x16ea0 && point <= 0x16eb8) ||
      (point >= 0xd800 && point <= 0xdfff)
    ) {
      throw new Error("Unsupported Unicode in Infinity embedding input");
    }
  }
}

function collapsePythonWhitespace(text: string): string {
  let result = "";
  let pendingSpace = false;
  for (const character of text) {
    if (pythonWhitespace.has(character.codePointAt(0)!)) {
      pendingSpace = result.length > 0;
    } else {
      if (pendingSpace) {
        result += " ";
      }
      result += character;
      pendingSpace = false;
    }
  }
  return result;
}

export function normalizeInfinityEmbeddingInput(text: string): string {
  assertSupportedUnicode(text);
  return collapsePythonWhitespace(text.toLowerCase());
}

// All non-ASCII Python 15 casefold mappings whose result consists of ASCII.
// Other folds cannot match any character of the strictly ASCII title.
const asciiFolds: Readonly<Record<string, string>> = {
  "ß": "ss", "ſ": "s", "ẞ": "ss", "K": "k", "ﬀ": "ff", "ﬁ": "fi",
  "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
};

/** Exact retrieval text for opaque titles and metadata without retrieval hints. */
export function infinityDocumentEmbeddingInput(title: string, body: string): string {
  if (title.length !== 55 || !opaqueTitle.test(title)) {
    throw new Error("Invalid Infinity evidence title");
  }
  const normalizedBody = normalizeInfinityEmbeddingInput(body);
  const foldedBody = collapsePythonWhitespace(
    Array.from(body, (character) => asciiFolds[character] ?? character.toLowerCase()).join(""),
  );
  return foldedBody.startsWith(title.toLowerCase())
    ? normalizedBody
    : normalizeInfinityEmbeddingInput(`${title}\n\n${body}`);
}
