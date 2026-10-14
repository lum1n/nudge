"""A Nudge server on a faux model (`packages/server/scripts/faux-server.ts`, which runs the
built packages: `pnpm build` first): assistant "robin", players Ann (the admin) and Bo, and
their room "trip". Tests that need it are skipped, saying why, without node or the build."""

from __future__ import annotations

import json
import shutil
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


@dataclass
class FauxServer:
    url: str
    assistant: str
    ann: str
    bo: str


@pytest.fixture
def server() -> Iterator[FauxServer]:
    if not (ROOT / "packages/server/dist/index.js").exists():
        pytest.skip("no packages/server/dist; run `pnpm build` first")
    if shutil.which("node") is None:
        pytest.skip("no node")
    process = subprocess.Popen(
        ["node", str(ROOT / "packages/server/scripts/faux-server.ts")],
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout is not None
        started = json.loads(process.stdout.readline())
        yield FauxServer(
            url=started["url"],
            assistant=started["assistant"],
            ann=started["tokens"]["ann"],
            bo=started["tokens"]["bo"],
        )
    finally:
        process.kill()
        process.wait()
