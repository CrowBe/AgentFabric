from __future__ import annotations

from agentfabric.errors import Denied
from agentfabric.fabric import Fabric


def test_fallback_is_not_an_agentsop_capability(fabric: Fabric) -> None:
    result = fabric.fallback_exec("operator", "python3 -c 'print(2+2)'")
    assert result["ok"]
    assert result["stdout"].strip() == "4"
    assert result["agentsop"] is None
    assert result["binding"] == "fallback.exec"
    assert "workspace.discover" in fabric.capabilities
    assert "fallback.exec" not in fabric.capabilities


def test_guest_cannot_use_fallback(fabric: Fabric) -> None:
    try:
        fabric.fallback_exec("guest", "echo hi")
    except Denied:
        return
    raise AssertionError("guest must not fallback")
