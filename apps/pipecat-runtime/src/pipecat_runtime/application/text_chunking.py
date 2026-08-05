"""Deterministic phrase chunking for natural low-latency speech."""

from __future__ import annotations


class SpeechPhraseChunker:
    """Prefer sentence boundaries, then clauses, while enforcing a hard chunk cap."""

    def __init__(self, *, minimum_characters: int = 16, maximum_characters: int = 120) -> None:
        if minimum_characters < 1 or maximum_characters < minimum_characters:
            raise ValueError("speech phrase chunk limits are invalid")
        self._minimum = minimum_characters
        self._maximum = maximum_characters
        self._buffer = ""

    def feed(self, text: str) -> tuple[str, ...]:
        """Append generated text and return every phrase that is ready for TTS."""
        self._buffer += text
        chunks: list[str] = []
        while split_at := self._next_split():
            chunks.append(self._buffer[:split_at])
            self._buffer = self._buffer[split_at:]
        return tuple(chunks)

    def finish(self) -> tuple[str, ...]:
        """Flush the final short phrase without changing the generated text."""
        if not self._buffer:
            return ()
        chunk = self._buffer
        self._buffer = ""
        return (chunk,)

    def _next_split(self) -> int | None:
        search_limit = min(len(self._buffer), self._maximum)
        for index, character in enumerate(self._buffer[:search_limit], start=1):
            if index < self._minimum:
                continue
            if character in ".!?…;\n":
                return self._include_following_whitespace(index)
            if character in ",:" and index >= self._minimum * 2:
                return self._include_following_whitespace(index)
        if len(self._buffer) <= self._maximum:
            return None
        whitespace = max(
            self._buffer.rfind(" ", self._minimum, self._maximum + 1),
            self._buffer.rfind("\n", self._minimum, self._maximum + 1),
            self._buffer.rfind("\t", self._minimum, self._maximum + 1),
        )
        return whitespace + 1 if whitespace >= self._minimum else self._maximum

    def _include_following_whitespace(self, index: int) -> int:
        while index < len(self._buffer) and self._buffer[index].isspace():
            if index >= self._maximum:
                break
            index += 1
        return index
