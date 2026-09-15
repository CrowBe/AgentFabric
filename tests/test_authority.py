from __future__ import annotations

from pathlib import Path

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


def test_guest_cannot_create(fabric: Fabric) -> None:
    result = fabric.invoke("guest", "blob.create", {"label": "x.md", "text": "no"})
    assert not result.ok
    assert result.error.code == "DENIED"


def test_guest_cannot_replace(fabric: Fabric) -> None:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    notes = next(item["resource"] for item in discovered["resources"] if item["resource"]["kind"] == "blob")
    result = fabric.invoke("guest", "blob.replace", {"resource": notes, "text": "no"})
    assert not result.ok
    assert result.error.code == "DENIED"
    record = fabric.resources.get(notes["ref"])
    assert "ResourceRefs" in Path(record.locator).read_text(encoding="utf-8")


def test_create_authority_cannot_mutate_existing_resource(fabric: Fabric) -> None:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    notes = next(item["resource"] for item in discovered["resources"] if item["label"] == "notes.md")
    journal = next(item["resource"] for item in discovered["resources"] if item["resource"]["kind"] == "journal")
    notes_text = Path(fabric.resources.get(notes["ref"]).locator).read_text(encoding="utf-8")
    journal_text = Path(fabric.resources.get(journal["ref"]).locator).read_text(encoding="utf-8")

    fabric.add_principal("creator")
    fabric.authority.add(
        principal="creator",
        capability="blob.create",
        resource="*",
        effects=["create"],
    )
    created = fabric.invoke(
        "creator",
        "blob.create",
        {"label": "notes.md", "text": "creator should not clobber"},
    )
    assert created.ok
    assert created.output["resource"]["ref"] != notes["ref"]

    denied_replace = fabric.invoke(
        "creator", "blob.replace", {"resource": notes, "text": "nope"}
    )
    assert not denied_replace.ok
    assert denied_replace.error.code == "DENIED"

    denied_append = fabric.invoke(
        "creator",
        "journal.append",
        {"resource": journal, "entry": "creator was not granted this"},
    )
    assert not denied_append.ok
    assert denied_append.error.code == "DENIED"

    assert Path(fabric.resources.get(notes["ref"]).locator).read_text(encoding="utf-8") == notes_text
    assert Path(fabric.resources.get(journal["ref"]).locator).read_text(encoding="utf-8") == journal_text


def test_replace_is_resource_scoped(fabric: Fabric) -> None:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    notes = next(item["resource"] for item in discovered["resources"] if item["label"] == "notes.md")
    other = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "other.md", "text": "other"},
    ).output["resource"]

    fabric.add_principal("editor")
    fabric.authority.add(
        principal="editor",
        capability="blob.replace",
        resource=notes["ref"],
        effects=["write"],
    )

    ok = fabric.invoke("editor", "blob.replace", {"resource": notes, "text": "edited notes"})
    assert ok.ok
    denied = fabric.invoke("editor", "blob.replace", {"resource": other, "text": "nope"})
    assert not denied.ok
    assert denied.error.code == "DENIED"
    assert Path(fabric.resources.get(notes["ref"]).locator).read_text(encoding="utf-8") == "edited notes"
    assert Path(fabric.resources.get(other["ref"]).locator).read_text(encoding="utf-8") == "other"


def test_guest_cannot_delete(fabric: Fabric) -> None:
    created = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "scratch.md", "text": "temp"},
    ).output["resource"]
    result = fabric.invoke("guest", "blob.delete", {"resource": created})
    assert not result.ok
    assert result.error.code == "DENIED"
    assert fabric.resources.get(created["ref"]).kind == "blob"


def test_create_and_write_cannot_delete(fabric: Fabric) -> None:
    created = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "owned.md", "text": "keep"},
    ).output["resource"]
    fabric.add_principal("writer")
    fabric.authority.add(
        principal="writer",
        capability="blob.create",
        resource="*",
        effects=["create"],
    )
    fabric.authority.add(
        principal="writer",
        capability="blob.replace",
        resource=created["ref"],
        effects=["write"],
    )
    denied = fabric.invoke("writer", "blob.delete", {"resource": created})
    assert not denied.ok
    assert denied.error.code == "DENIED"
    assert Path(fabric.resources.get(created["ref"]).locator).read_text(encoding="utf-8") == "keep"

