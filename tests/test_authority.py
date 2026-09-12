from __future__ import annotations

from agentfabric.fabric import Fabric


def test_operator_can_append_guest_cannot(fabric: Fabric) -> None:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    journal = next(item["resource"] for item in discovered["resources"] if item["resource"]["kind"] == "journal")
    ok = fabric.invoke(
        "operator",
        "journal.append",
        {"resource": journal, "entry": "operator was here"},
    )
    assert ok.ok
    denied = fabric.invoke(
        "guest",
        "journal.append",
        {"resource": journal, "entry": "guest was here"},
    )
    assert not denied.ok
    assert denied.error is not None
    assert denied.error.code == "DENIED"


def test_guest_may_read(fabric: Fabric) -> None:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    notes = next(item["resource"] for item in discovered["resources"] if item["resource"]["kind"] == "blob")
    result = fabric.invoke("guest", "blob.read", {"resource": notes})
    assert result.ok
    assert "ResourceRefs" in result.output["text"]


def test_unknown_principal_is_denied(fabric: Fabric) -> None:
    result = fabric.invoke("stranger", "text.normalize", {"text": "x"})
    assert not result.ok
    assert result.error.code == "DENIED"


def test_guest_cannot_write(fabric: Fabric) -> None:
    result = fabric.invoke("guest", "blob.write", {"label": "x.md", "text": "no"})
    assert not result.ok
    assert result.error.code == "DENIED"
