from __future__ import annotations

from pathlib import Path

from agentfabric.demo import WORD_COUNT_SOURCE
from agentfabric.fabric import Fabric
from agentfabric.inspect import render_snapshot


def _crystallised_path(fabric: Fabric, info: dict[str, str]) -> Path:
    path = Path(info["path"])
    if not path.is_absolute():
        path = fabric.home / path
    return path


def test_missing_crystallised_resolver_degrades_on_reload(fabric: Fabric) -> None:
    info = fabric.crystallise("operator", "text.word_count", WORD_COUNT_SOURCE)
    _crystallised_path(fabric, info).unlink()

    reloaded = Fabric(fabric.home)
    view = reloaded.resolution_of("text.word_count")
    assert view.status == "unavailable"
    assert view.resolver == "local:text_word_count.py"
    assert view.detail is not None
    assert "missing" in view.detail
    assert "text_word_count.py" in view.detail

    snapshot = reloaded.snapshot()
    text = render_snapshot(snapshot)
    assert "unavailable" in text
    assert "missing" in text
    assert reloaded.resolution_of("text.normalize").status == "resolved"
    assert reloaded.resolution_of("blob.read").status == "resolved"
    normalize = reloaded.invoke("operator", "text.normalize", {"text": "  hello  "})
    assert normalize.ok
    assert normalize.output["text"] == "hello"

    result = reloaded.invoke("operator", "text.word_count", {"text": "one two three"})
    assert not result.ok
    assert result.error.code == "UNRESOLVED"
    assert "unavailable" in result.error.message
    assert "missing" in result.error.message
    opportunities = reloaded.snapshot()["opportunities"]
    assert any(
        item.get("capability") == "text.word_count" and "missing or broken" in item.get("summary", "")
        for item in opportunities
    )


def test_corrupt_crystallised_resolver_degrades_on_reload(fabric: Fabric) -> None:
    info = fabric.crystallise("operator", "text.word_count", WORD_COUNT_SOURCE)
    path = _crystallised_path(fabric, info)
    path.write_text("this is not valid python :\n", encoding="utf-8")

    reloaded = Fabric(fabric.home)
    view = reloaded.resolution_of("text.word_count")
    assert view.status == "unavailable"
    assert view.resolver == "local:text_word_count.py"
    assert view.detail is not None
    assert "failed to load" in view.detail

    assert reloaded.resolution_of("workspace.discover").status == "resolved"
    discovered = reloaded.invoke("operator", "workspace.discover", {})
    assert discovered.ok
    snapshot = reloaded.snapshot()
    assert any(cap["id"] == "text.word_count" and cap["status"] == "unavailable" for cap in snapshot["capabilities"])
    assert "failed to load" in render_snapshot(snapshot)

    result = reloaded.invoke("operator", "text.word_count", {"text": "one two"})
    assert not result.ok
    assert result.error.code == "UNRESOLVED"
    assert "unavailable" in result.error.message
    assert "failed to load" in result.error.message


def test_unreadable_crystallised_resolver_degrades_on_reload(fabric: Fabric) -> None:
    info = fabric.crystallise("operator", "text.word_count", WORD_COUNT_SOURCE)
    path = _crystallised_path(fabric, info)
    path.write_bytes(b"\xff\xfe\x00\x00")

    reloaded = Fabric(fabric.home)
    view = reloaded.resolution_of("text.word_count")
    assert view.status == "unavailable"
    assert view.detail is not None
    assert "not valid text" in view.detail
    assert reloaded.invoke("operator", "text.normalize", {"text": "ok"}).ok

    result = reloaded.invoke("operator", "text.word_count", {"text": "one"})
    assert not result.ok
    assert result.error.code == "UNRESOLVED"
    assert "not valid text" in result.error.message


def test_re_crystallise_repairs_unavailable_resolver(fabric: Fabric) -> None:
    info = fabric.crystallise("operator", "text.word_count", WORD_COUNT_SOURCE)
    _crystallised_path(fabric, info).unlink()
    reloaded = Fabric(fabric.home)
    assert reloaded.resolution_of("text.word_count").status == "unavailable"

    repaired = reloaded.crystallise("operator", "text.word_count", WORD_COUNT_SOURCE)
    assert repaired["capability"] == "text.word_count"
    view = reloaded.resolution_of("text.word_count")
    assert view.status == "resolved"
    assert view.detail is None
    result = reloaded.invoke("operator", "text.word_count", {"text": "one two three"})
    assert result.ok
    assert result.output["count"] == 3
