"""Bearer authentication for the private conversation-runtime boundary."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from secrets import compare_digest


@dataclass(frozen=True, slots=True)
class BearerTokenAuthenticator:
    """Validate one configured bearer token without exposing the secret."""

    token: str

    def __post_init__(self) -> None:
        if not self.token.strip():
            raise ValueError("bearer token must not be empty")

    def is_authorized(self, metadata: Iterable[tuple[str, str | bytes]] | None) -> bool:
        """Return whether request metadata contains the configured bearer credential."""
        if metadata is None:
            return False
        expected = f"Bearer {self.token}"
        for key, value in metadata:
            if key.lower() == "authorization" and isinstance(value, str):
                if compare_digest(value, expected):
                    return True
        return False
