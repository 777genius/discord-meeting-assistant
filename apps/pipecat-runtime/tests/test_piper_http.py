"""Bounded Piper HTTP response handling."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, cast

import aiohttp
import pytest

from pipecat_runtime.adapters.providers.piper_http import read_bounded_piper_response


class _ChunkedContent:
    async def iter_chunked(self, _size: int) -> AsyncIterator[bytes]:
        yield b"x" * (32 * 1024 * 1024 + 1)


class _OversizedResponse:
    content_length = None
    content = _ChunkedContent()

    def __init__(self) -> None:
        self.closed = False

    def close(self) -> None:
        self.closed = True


async def test_oversized_chunked_piper_response_is_closed() -> None:
    response = _OversizedResponse()

    with pytest.raises(ValueError, match="exceeds the byte limit"):
        await read_bounded_piper_response(cast(aiohttp.ClientResponse, cast(Any, response)))

    assert response.closed is True
