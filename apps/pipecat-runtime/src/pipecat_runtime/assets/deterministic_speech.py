"""Small captured Russian speech PCM fixture for deterministic Pipecat tests."""

from __future__ import annotations

from base64 import b64decode

_CAPTURED_RUSSIAN_PCM = (
    "yOi86LXoruin6J/ol+iQ6IvoieiN6JXoneij6KrotejH6Nvo8OgF6R3pOOla"
    "6YLpr+nf6Q/qQOp36rbq/OpD64rr1Osn7ITs5OxE7abtD+5+7vHuZ+/l72nw8P"
    "B08fjxhvIi88bzZvT/9Jv1QPbq9pD3MPjV+IX5Ofrm+oj7K/zb/JP9SP7y/pX/"
    "PQDqAJYBPQLiAoYDKgTLBGkFBwalBj0HzQdZCOgIewkMCpYKGgubCxwMmQwRDYU"
    "N+w1yDuMO"
)
_FIXTURE_FRAME_BYTES = 192


def deterministic_russian_speech_pcm() -> bytes:
    """Return repeated real 48 kHz mono PCM captured for providerless pipeline tests."""
    fixture = b64decode(_CAPTURED_RUSSIAN_PCM, validate=True)
    if len(fixture) != _FIXTURE_FRAME_BYTES:
        raise RuntimeError("deterministic speech fixture must remain 48 kHz mono PCM")
    return fixture * 120
