from __future__ import annotations

import json
from io import StringIO
from pathlib import Path

from agentfabric.cli import main
from agentfabric.fabric import Fabric
from agentfabric.hook import handle
from agentfabric.notice import looks_like_candidate_shell, open_opportunities
from agentfabric.scaffold import scaffold
from agentfabric.schema import validate_capability_document


def test_shell_heuristics() -> None:
    assert looks_like_candidate_shell("python3 -c 'print(len(\"a b\".split()))'")
    assert looks_like_candidate_shell("wc -w notes.md")
    assert not looks_like_candidate_shell("pytest")
    assert not looks_like_candidate_shell("git status")
    assert not looks_like_candidate_shell("python3 -m pytest")
    assert not looks_like_candidate_shell("agentfabric inspect")


def test_unresolved_and_fallback_become_opportunities(fabric: Fabric) -> None:
    fabric.invoke("operator", "text.word_count", {"text": "a b"})
    fabric.fallback_exec("operator", "python3 -c 'print(3)'")
    found = {item["kind"]: item for item in fabric.snapshot()["opportunities"]}
    assert "unresolved" in found
    assert found["unresolved"]["capability"] == "text.word_count"
    assert "fallback" in found


def test_resolved_capability_drops_unresolved_notice(fabric: Fabric) -> None:
    fabric.invoke("operator", "text.word_count", {"text": "a b"})
    assert open_opportunities(fabric.home, resolved=set())
    dropped = open_opportunities(fabric.home, resolved={"text.word_count"})
    assert all(item.get("capability") != "text.word_count" for item in dropped)


def test_hook_asks_for_set_up_when_missing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTFABRIC_HOME", str(tmp_path / "missing"))
    out = handle("sessionStart", {})
    assert "/set-up" in out["additional_context"]


def test_hook_notices_candidate_shell(fabric: Fabric, monkeypatch) -> None:
    monkeypatch.setenv("AGENTFABRIC_HOME", str(fabric.home))
    out = handle(
        "postToolUse",
        {"tool_name": "Shell", "tool_input": {"command": "python3 -c 'print(1)'"}},
    )
    assert "crystallisation" in out["additional_context"]
    quiet = handle(
        "postToolUse",
        {"tool_name": "Shell", "tool_input": {"command": "pytest"}},
    )
    assert quiet == {}


def test_scaffold_writes_valid_document(tmp_path: Path) -> None:
    root = tmp_path / "agentsop"
    (root / "capabilities").mkdir(parents=True)
    (root / "EXPERIMENTAL-0.1.md").write_text("# stub\n", encoding="utf-8")
    path = scaffold(
        "text.hash",
        title="Hash text",
        description="SHA-256 of a text value.",
        sop_root=root,
    )
    doc = json.loads(path.read_text(encoding="utf-8"))
    cap = validate_capability_document(doc)
    assert cap.id == "text.hash"


def test_cli_hook_never_fails(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("AGENTFABRIC_HOME", str(tmp_path / "h"))
    monkeypatch.setattr("sys.stdin", StringIO("{not-json"))
    assert main(["hook", "sessionStart"]) == 0
