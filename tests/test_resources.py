from __future__ import annotations

from pathlib import Path

from agentfabric.fabric import Fabric


def test_discover_issues_refs_not_paths(fabric: Fabric) -> None:
    result = fabric.invoke("operator", "workspace.discover", {})
    assert result.ok
    for item in result.output["resources"]:
        assert set(item) == {"resource", "label"}
        assert set(item["resource"]) == {"ref", "kind"}
        assert item["resource"]["ref"].startswith("rf_")
        assert "/" not in item["resource"]["ref"]
        assert ".." not in item["label"]


def test_unknown_ref_is_rejected(fabric: Fabric) -> None:
    result = fabric.invoke(
        "operator",
        "blob.read",
        {"resource": {"ref": "rf_deadbeefdead", "kind": "blob"}},
    )
    assert not result.ok
    assert result.error.code == "UNKNOWN_RESOURCE"


def test_cannot_smuggle_a_locator_in_a_ref(fabric: Fabric) -> None:
    result = fabric.invoke(
        "operator",
        "blob.read",
        {"resource": {"ref": "rf_deadbeefdead", "kind": "blob", "path": "/etc/passwd"}},
    )
    assert not result.ok
    assert result.error.code == "INVALID_INPUT"


def test_write_label_cannot_escape_workspace(fabric: Fabric) -> None:
    result = fabric.invoke(
        "operator",
        "blob.write",
        {"label": "../../etc/passwd", "text": "should not land on etc"},
    )
    assert result.ok
    ref = result.output["resource"]["ref"]
    record = fabric.resources.get(ref)
    path = Path(record.locator).resolve()
    assert path.is_relative_to(fabric.workspace.resolve())
    assert path.name == "passwd"
    assert path.read_text(encoding="utf-8") == "should not land on etc"


def test_inspect_hides_locators(fabric: Fabric) -> None:
    snapshot = fabric.snapshot()
    for resource in snapshot["resources"]:
        assert "locator" not in resource
        assert set(resource) == {"ref", "kind", "label"}
