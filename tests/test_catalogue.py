from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agentfabric.catalogue import load_capabilities, validate_dependency_graph
from agentfabric.cli import main
from agentfabric.errors import InvalidCatalogue
from agentfabric.fabric import Fabric
from agentfabric.scaffold import scaffold
from agentfabric.schema import validate_capability_document


def _cap(cap_id: str, *, depends_on: list[str] | None = None) -> Any:
    return validate_capability_document(
        {
            "agentsop": "0.1",
            "id": cap_id,
            "title": cap_id,
            "description": f"{cap_id} for tests.",
            "input": {"type": "object", "properties": {}, "additionalProperties": False},
            "output": {"type": "object", "properties": {}, "additionalProperties": False},
            "effects": [],
            "idempotent": True,
            "authority": {"resources": [], "effects": []},
            "depends_on": list(depends_on or []),
        }
    )


def _write_overlay(home: Path, cap_id: str, *, depends_on: list[str]) -> Path:
    path = home / "capabilities" / f"{cap_id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "agentsop": "0.1",
                "id": cap_id,
                "title": cap_id,
                "description": f"{cap_id} for tests.",
                "input": {"type": "object", "properties": {}, "additionalProperties": False},
                "output": {"type": "object", "properties": {}, "additionalProperties": False},
                "effects": [],
                "idempotent": True,
                "authority": {"resources": [], "effects": []},
                "depends_on": depends_on,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return path


def test_valid_composition_graph() -> None:
    caps = load_capabilities()
    validate_dependency_graph(caps)
    digest = caps["journal.digest"]
    assert digest.depends_on == ["blob.read", "text.normalize"]
    assert set(digest.depends_on).issubset(caps)


def test_synthetic_valid_composition_graph() -> None:
    graph = {
        "blob.read": _cap("blob.read"),
        "text.normalize": _cap("text.normalize"),
        "journal.digest": _cap("journal.digest", depends_on=["blob.read", "text.normalize"]),
    }
    validate_dependency_graph(graph)


def test_dangling_dependency_is_invalid_catalogue() -> None:
    graph = {
        "journal.digest": _cap("journal.digest", depends_on=["blob.reed", "text.normalize"]),
        "text.normalize": _cap("text.normalize"),
    }
    with pytest.raises(InvalidCatalogue, match="unknown capability 'blob.reed'") as exc:
        validate_dependency_graph(graph)
    assert exc.value.code == "INVALID_CATALOGUE"
    assert "text.normalize" not in exc.value.message


def test_dependency_cycle_is_invalid_catalogue() -> None:
    graph = {
        "compose.a": _cap("compose.a", depends_on=["compose.b"]),
        "compose.b": _cap("compose.b", depends_on=["compose.a"]),
    }
    with pytest.raises(InvalidCatalogue, match="capability dependency cycle:") as exc:
        validate_dependency_graph(graph)
    assert exc.value.code == "INVALID_CATALOGUE"
    assert "compose.a" in exc.value.message
    assert "compose.b" in exc.value.message
    assert "->" in exc.value.message


def test_self_cycle_is_invalid_catalogue() -> None:
    graph = {"compose.self": _cap("compose.self", depends_on=["compose.self"])}
    with pytest.raises(InvalidCatalogue, match="compose.self -> compose.self"):
        validate_dependency_graph(graph)


def test_fabric_loads_valid_overlay_composition(fabric: Fabric) -> None:
    _write_overlay(fabric.home, "notes.digest", depends_on=["blob.read", "text.normalize"])
    reloaded = Fabric(fabric.home)
    view = reloaded.resolution_of("notes.digest")
    assert view.origin == "local"
    assert view.depends_on == ["blob.read", "text.normalize"]


def test_fabric_rejects_dangling_overlay_dependency(fabric: Fabric) -> None:
    _write_overlay(fabric.home, "compose.bad", depends_on=["does.not.exist"])
    with pytest.raises(InvalidCatalogue, match="does.not.exist"):
        Fabric(fabric.home)


def test_fabric_rejects_overlay_dependency_cycle(fabric: Fabric) -> None:
    _write_overlay(fabric.home, "compose.a", depends_on=["compose.b"])
    _write_overlay(fabric.home, "compose.b", depends_on=["compose.a"])
    with pytest.raises(InvalidCatalogue, match="capability dependency cycle:"):
        Fabric(fabric.home)


def test_scaffold_runs_graph_validation_before_write(fabric: Fabric) -> None:
    _write_overlay(fabric.home, "compose.bad", depends_on=["does.not.exist"])
    with pytest.raises(InvalidCatalogue, match="does.not.exist"):
        scaffold("text.hash", title="Hash text", home=fabric.home)
    assert not (fabric.home / "capabilities" / "text.hash.json").exists()


def test_cli_inspect_reports_invalid_catalogue(
    fabric: Fabric, capsys: pytest.CaptureFixture[str]
) -> None:
    _write_overlay(fabric.home, "compose.bad", depends_on=["does.not.exist"])
    code = main(["--home", str(fabric.home), "inspect"])
    assert code == 2
    err = capsys.readouterr().err
    payload = json.loads(err)
    assert payload["code"] == "INVALID_CATALOGUE"
    assert "does.not.exist" in payload["message"]
    assert "Traceback" not in err
