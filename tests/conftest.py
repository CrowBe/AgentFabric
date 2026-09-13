from __future__ import annotations

from pathlib import Path

import pytest

from agentfabric.fabric import Fabric


@pytest.fixture
def fabric(tmp_path: Path) -> Fabric:
    return Fabric.init(tmp_path / "fabric")
