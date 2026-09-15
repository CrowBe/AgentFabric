from __future__ import annotations

from pathlib import Path

import pytest

from agentfabric.errors import Denied
from agentfabric.fabric import Fabric
from agentfabric.resources import ResourceRegistry


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
    assert result.error.code == "INVALID_REF"


def test_create_label_cannot_escape_workspace(fabric: Fabric) -> None:
    result = fabric.invoke(
        "operator",
        "blob.create",
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


def _resource_by_label(fabric: Fabric, label: str) -> dict[str, str]:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    return next(item["resource"] for item in discovered["resources"] if item["label"] == label)


def test_create_with_colliding_label_does_not_replace(fabric: Fabric) -> None:
    notes = _resource_by_label(fabric, "notes.md")
    record = fabric.resources.get(notes["ref"])
    original_kind = record.kind
    original_text = Path(record.locator).read_text(encoding="utf-8")
    original_locator = record.locator

    created = fabric.invoke(
        "operator",
        "blob.create",
        {
            "label": "notes.md",
            "text": "should not clobber notes",
            "kind": "journal",
        },
    )
    assert created.ok
    new_resource = created.output["resource"]
    assert new_resource["ref"] != notes["ref"]
    assert new_resource["kind"] == "journal"

    preserved = fabric.resources.get(notes["ref"])
    assert preserved.kind == original_kind == "blob"
    assert preserved.locator == original_locator
    assert Path(preserved.locator).read_text(encoding="utf-8") == original_text
    assert Path(fabric.resources.get(new_resource["ref"]).locator).read_text(
        encoding="utf-8"
    ) == "should not clobber notes"


def test_create_does_not_mutate_journal_via_label(fabric: Fabric) -> None:
    journal = _resource_by_label(fabric, "journal.md")
    record = fabric.resources.get(journal["ref"])
    original_text = Path(record.locator).read_text(encoding="utf-8")

    created = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "journal.md", "text": "clobber", "kind": "blob"},
    )
    assert created.ok
    assert created.output["resource"]["ref"] != journal["ref"]
    assert created.output["resource"]["kind"] == "blob"

    preserved = fabric.resources.get(journal["ref"])
    assert preserved.kind == "journal"
    assert Path(preserved.locator).read_text(encoding="utf-8") == original_text


def test_replace_mutates_existing_blob_in_place(fabric: Fabric) -> None:
    notes = _resource_by_label(fabric, "notes.md")
    original = fabric.resources.get(notes["ref"])
    replaced = fabric.invoke(
        "operator",
        "blob.replace",
        {"resource": notes, "text": "replaced notes"},
    )
    assert replaced.ok
    assert replaced.output["resource"] == notes
    updated = fabric.resources.get(notes["ref"])
    assert updated.kind == original.kind
    assert updated.locator == original.locator
    assert Path(updated.locator).read_text(encoding="utf-8") == "replaced notes"


def test_delete_is_ref_scoped_and_immediately_unknown(fabric: Fabric) -> None:
    created = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "ephemeral.md", "text": "bye"},
    ).output["resource"]
    locator = Path(fabric.resources.get(created["ref"]).locator)
    assert locator.is_file()
    deleted = fabric.invoke("operator", "blob.delete", {"resource": created})
    assert deleted.ok
    assert deleted.output == {"deleted": True}
    assert not locator.exists()
    reread = fabric.invoke("operator", "blob.read", {"resource": created})
    assert not reread.ok
    assert reread.error.code == "UNKNOWN_RESOURCE"
    rediscover = fabric.invoke("operator", "workspace.discover", {}).output
    labels = {item["label"] for item in rediscover["resources"]}
    assert "ephemeral.md" not in labels
    again = fabric.invoke("operator", "blob.delete", {"resource": created})
    assert not again.ok
    assert again.error.code == "UNKNOWN_RESOURCE"


def test_delete_rejects_journal_kind(fabric: Fabric) -> None:
    journal = _resource_by_label(fabric, "journal.md")
    result = fabric.invoke("operator", "blob.delete", {"resource": journal})
    assert not result.ok
    assert result.error.code == "KIND_MISMATCH"
    assert Path(fabric.resources.get(journal["ref"]).locator).is_file()


def test_delete_rejects_smuggled_locator(fabric: Fabric) -> None:
    notes = _resource_by_label(fabric, "notes.md")
    result = fabric.invoke(
        "operator",
        "blob.delete",
        {"resource": {**notes, "path": "/etc/passwd"}},
    )
    assert not result.ok
    assert result.error.code == "INVALID_REF"
    assert fabric.resources.get(notes["ref"]).kind == "blob"


def test_replace_rejects_journal_kind(fabric: Fabric) -> None:
    journal = _resource_by_label(fabric, "journal.md")
    result = fabric.invoke(
        "operator",
        "blob.replace",
        {"resource": journal, "text": "nope"},
    )
    assert not result.ok
    assert result.error.code == "KIND_MISMATCH"
    assert Path(fabric.resources.get(journal["ref"]).locator).read_text(
        encoding="utf-8"
    ).startswith("# Journal")


def test_replace_rejects_smuggled_locator(fabric: Fabric) -> None:
    notes = _resource_by_label(fabric, "notes.md")
    result = fabric.invoke(
        "operator",
        "blob.replace",
        {"resource": {**notes, "path": "/etc/passwd"}, "text": "nope"},
    )
    assert not result.ok
    assert result.error.code == "INVALID_REF"


def test_issue_does_not_restamp_kind_or_identity(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    path = workspace / "notes.md"
    path.write_text("keep me", encoding="utf-8")
    registry = ResourceRegistry(tmp_path / "resources.json", workspace)
    first = registry.issue(
        kind="blob", label="notes.md", locator=path, created_by="operator"
    )
    second = registry.issue(
        kind="journal", label="renamed", locator=path, created_by="guest"
    )
    assert second.ref == first.ref
    assert second.kind == "blob"
    assert second.label == "notes.md"
    assert second.created_by == "operator"


def test_create_refuses_existing_locator(tmp_path: Path) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    path = workspace / "a.md"
    path.write_text("keep", encoding="utf-8")
    registry = ResourceRegistry(tmp_path / "resources.json", workspace)
    first = registry.create(
        kind="blob", label="a.md", locator=path, created_by="operator"
    )
    with pytest.raises(Denied):
        registry.create(kind="journal", label="a.md", locator=path, created_by="operator")
    assert registry.get(first.ref).kind == "blob"
    assert Path(first.locator).read_text(encoding="utf-8") == "keep"
