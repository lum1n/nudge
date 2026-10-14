"""Where a client keeps its token. `pair` stores the token it gets, and every request and
connection attempt reads it again, so a store may be changed from outside while a client runs."""

from __future__ import annotations

import os
import threading
from pathlib import Path

from nudge._ffi import TokenStore

__all__ = ["FileTokens", "MemoryTokens", "TokenStore"]


class MemoryTokens(TokenStore):
    """A token held in memory only, gone when the process ends."""

    def __init__(self, token: str | None = None) -> None:
        self._token = token
        self._lock = threading.Lock()

    def get(self) -> str | None:
        with self._lock:
            return self._token

    def set(self, token: str | None) -> None:
        with self._lock:
            self._token = token


class FileTokens(TokenStore):
    """A token in a file only its owner can read; `set(None)` deletes the file."""

    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path).expanduser()
        self._lock = threading.Lock()

    def get(self) -> str | None:
        with self._lock:
            try:
                token = self.path.read_text().strip()
            except FileNotFoundError:
                return None
            return token or None

    def set(self, token: str | None) -> None:
        with self._lock:
            if token is None:
                self.path.unlink(missing_ok=True)
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            partial = self.path.with_name(f".{self.path.name}.{os.getpid()}")
            fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as file:
                file.write(token)
            os.replace(partial, self.path)
