"""Incremental decoder for the exact conversation answer JSON shape."""

from __future__ import annotations

from enum import StrEnum
from typing import Never


class _State(StrEnum):
    OBJECT = "object"
    KEY_START = "key-start"
    KEY = "key"
    COLON = "colon"
    VALUE_START = "value-start"
    VALUE = "value"
    AFTER_VALUE = "after-value"
    DONE = "done"


class StructuredAnswerStreamDecoder:
    """Expose only decoded `answer` text while the final RPC result remains authoritative."""

    def __init__(self, *, maximum_raw_characters: int = 16_000) -> None:
        self._state = _State.OBJECT
        self._maximum_raw_characters = maximum_raw_characters
        self._raw_characters = 0
        self._answer_characters = 0
        self._key = ""
        self._escape_pending = False
        self._unicode_digits = ""
        self._high_surrogate: int | None = None

    def feed(self, text: str) -> tuple[str, ...]:
        """Consume one raw provider delta and return newly decoded answer fragments."""
        if not text:
            return ()
        self._raw_characters += len(text)
        if self._raw_characters > self._maximum_raw_characters:
            self._fail()
        output: list[str] = []
        plain: list[str] = []

        def flush_plain() -> None:
            if plain:
                output.append("".join(plain))
                plain.clear()

        for character in text:
            if self._state is _State.VALUE:
                decoded = self._consume_value_character(character)
                if decoded is not None:
                    plain.append(decoded)
                    self._answer_characters += len(decoded)
                    if self._answer_characters > 2_000:
                        self._fail()
                elif self._state is not _State.VALUE:
                    flush_plain()
                continue
            flush_plain()
            self._consume_structure_character(character)
        flush_plain()
        return tuple(output)

    def finish(self) -> None:
        """Require one complete object and no truncated escape or surrogate."""
        if (
            self._state is not _State.DONE
            or self._escape_pending
            or self._unicode_digits
            or self._high_surrogate is not None
            or self._answer_characters < 1
        ):
            self._fail()

    def _consume_structure_character(self, character: str) -> None:
        if self._state is _State.OBJECT:
            if character.isspace():
                return
            if character != "{":
                self._fail()
            self._state = _State.KEY_START
            return
        if self._state is _State.KEY_START:
            if character.isspace():
                return
            if character != '"':
                self._fail()
            self._state = _State.KEY
            return
        if self._state is _State.KEY:
            if character == '"':
                if self._key != "answer":
                    self._fail()
                self._state = _State.COLON
                return
            if character == "\\" or ord(character) < 0x20:
                self._fail()
            self._key += character
            if len(self._key) > len("answer"):
                self._fail()
            return
        if self._state is _State.COLON:
            if character.isspace():
                return
            if character != ":":
                self._fail()
            self._state = _State.VALUE_START
            return
        if self._state is _State.VALUE_START:
            if character.isspace():
                return
            if character != '"':
                self._fail()
            self._state = _State.VALUE
            return
        if self._state is _State.AFTER_VALUE:
            if character.isspace():
                return
            if character != "}":
                self._fail()
            self._state = _State.DONE
            return
        if self._state is _State.DONE:
            if not character.isspace():
                self._fail()
            return
        self._fail()

    def _consume_value_character(self, character: str) -> str | None:
        if self._unicode_digits:
            if character not in "0123456789abcdefABCDEF":
                self._fail()
            self._unicode_digits += character
            if len(self._unicode_digits) < 5:
                return None
            value = int(self._unicode_digits[1:], 16)
            self._unicode_digits = ""
            return self._decode_unicode_value(value)
        if self._escape_pending:
            self._escape_pending = False
            if character == "u":
                self._unicode_digits = "u"
                return None
            escapes = {
                '"': '"',
                "\\": "\\",
                "/": "/",
                "b": "\b",
                "f": "\f",
                "n": "\n",
                "r": "\r",
                "t": "\t",
            }
            if character not in escapes:
                self._fail()
            return escapes[character]
        if character == "\\":
            self._escape_pending = True
            return None
        if character == '"':
            if self._high_surrogate is not None:
                self._fail()
            self._state = _State.AFTER_VALUE
            return None
        if ord(character) < 0x20:
            self._fail()
        return character

    def _decode_unicode_value(self, value: int) -> str | None:
        if 0xD800 <= value <= 0xDBFF:
            if self._high_surrogate is not None:
                self._fail()
            self._high_surrogate = value
            return None
        if 0xDC00 <= value <= 0xDFFF:
            if self._high_surrogate is None:
                self._fail()
            high = self._high_surrogate
            self._high_surrogate = None
            return chr(0x10000 + ((high - 0xD800) << 10) + value - 0xDC00)
        if self._high_surrogate is not None:
            self._fail()
        return chr(value)

    @staticmethod
    def _fail() -> Never:
        raise ValueError("structured answer stream is invalid")
