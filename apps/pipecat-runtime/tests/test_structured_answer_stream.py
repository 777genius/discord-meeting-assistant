"""Deterministic validation for provisional structured answer deltas."""

from __future__ import annotations

import pytest

from pipecat_runtime.adapters.subscription_runtime.structured_answer_stream import (
    StructuredAnswerStreamDecoder,
)
from pipecat_runtime.application.text_chunking import SpeechPhraseChunker


def test_decoder_extracts_answer_across_json_and_unicode_escape_boundaries() -> None:
    decoder = StructuredAnswerStreamDecoder()

    chunks = [
        *decoder.feed(' {"ans'),
        *decoder.feed('wer":"Hello, \\nAlice \\uD83D'),
        *decoder.feed('\\uDE42!"'),
        *decoder.feed("} "),
    ]
    decoder.finish()

    assert "".join(chunks) == "Hello, \nAlice 🙂!"


@pytest.mark.parametrize(
    "payload",
    [
        '{"other":"нет"}',
        '{"answer":false}',
        '{"answer":"ok","extra":true}',
        'prefix {"answer":"ok"}',
    ],
)
def test_decoder_rejects_non_exact_provisional_shape(payload: str) -> None:
    with pytest.raises(ValueError, match="structured answer stream"):
        _decode_all(payload)


def test_phrase_chunker_prefers_natural_boundaries_and_preserves_exact_text() -> None:
    chunker = SpeechPhraseChunker(minimum_characters=12, maximum_characters=48)
    source = (
        "Да, это можно сделать. "
        "Сначала проверю быстрый вариант, затем предложу наиболее надёжный подход."
    )

    chunks = [
        *chunker.feed(source[:17]),
        *chunker.feed(source[17:51]),
        *chunker.feed(source[51:]),
        *chunker.finish(),
    ]

    assert "".join(chunks) == source
    assert chunks[0] == "Да, это можно сделать. "
    assert all(len(chunk) <= 48 for chunk in chunks)
    assert all(chunk.strip() for chunk in chunks)


def _decode_all(payload: str) -> None:
    decoder = StructuredAnswerStreamDecoder()
    decoder.feed(payload)
    decoder.finish()
