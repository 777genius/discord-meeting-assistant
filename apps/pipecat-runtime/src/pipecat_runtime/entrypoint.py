"""Executable entrypoint for the isolated Pipecat runtime sidecar."""

from __future__ import annotations

import asyncio

from pipecat_runtime.composition.bootstrap import serve
from pipecat_runtime.composition.settings import RuntimeSettings


def main() -> None:
    """Load fail-closed configuration and run the private gRPC server."""
    asyncio.run(serve(RuntimeSettings.from_environment()))
