from __future__ import annotations

from pathlib import Path

from agentfabric.fabric import Fabric
from agentfabric.inspect import render_snapshot


def _break_audit(fabric: Fabric, monkeypatch, counter: dict[str, int] | None = None):
    def boom(entry) -> None:
        if counter is not None:
            counter["n"] = counter.get("n", 0) + 1
        raise OSError("disk full")

    monkeypatch.setattr(fabric.audit, "record", boom)


def test_audit_failure_does_not_erase_pure_success(fabric: Fabric, monkeypatch, capsys) -> None:
    _break_audit(fabric, monkeypatch)
    result = fabric.invoke("operator", "text.normalize", {"text": "  hello  "})
    assert result.ok
    assert result.output["text"] == "hello"
    health = fabric.snapshot()["audit"]
    assert health["ok"] is False
    assert "OSError" in health["error"]
    err = capsys.readouterr().err
    assert "audit recording failed" in err
    assert "Result is unchanged" in err
    text = render_snapshot(fabric.snapshot())
    assert "degraded" in text


def test_audit_failure_does_not_hide_committed_create(fabric: Fabric, monkeypatch) -> None:
    _break_audit(fabric, monkeypatch)
    result = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "kept.md", "text": "committed"},
    )
    assert result.ok
    record = fabric.resources.get(result.output["resource"]["ref"])
    assert Path(record.locator).read_text(encoding="utf-8") == "committed"


def test_audit_failure_does_not_hide_replace_or_append(fabric: Fabric, monkeypatch) -> None:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    notes = next(item["resource"] for item in discovered["resources"] if item["label"] == "notes.md")
    journal = next(
        item["resource"] for item in discovered["resources"] if item["resource"]["kind"] == "journal"
    )
    _break_audit(fabric, monkeypatch)
    replaced = fabric.invoke("operator", "blob.replace", {"resource": notes, "text": "replaced"})
    assert replaced.ok
    assert Path(fabric.resources.get(notes["ref"]).locator).read_text(encoding="utf-8") == "replaced"
    appended = fabric.invoke(
        "operator",
        "journal.append",
        {"resource": journal, "entry": "still happened"},
    )
    assert appended.ok
    assert "still happened" in Path(fabric.resources.get(journal["ref"]).locator).read_text(
        encoding="utf-8"
    )


def test_audit_failure_does_not_erase_semantic_failure(fabric: Fabric, monkeypatch) -> None:
    _break_audit(fabric, monkeypatch)
    result = fabric.invoke("operator", "no.such", {})
    assert not result.ok
    assert result.error.code == "UNKNOWN_CAPABILITY"
    assert fabric.snapshot()["audit"]["ok"] is False


def test_audit_failure_does_not_audit_itself(fabric: Fabric, monkeypatch) -> None:
    counter = {"n": 0}
    _break_audit(fabric, monkeypatch, counter)
    fabric.invoke("operator", "text.normalize", {"text": "a"})
    fabric.invoke("guest", "blob.create", {"label": "x.md", "text": "no"})
    assert counter["n"] == 2
