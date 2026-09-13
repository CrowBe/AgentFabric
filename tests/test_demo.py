from __future__ import annotations

from pathlib import Path

from agentfabric.cli import main
from agentfabric.demo import run_walkthrough


def test_walkthrough_covers_the_mvp_script(tmp_path: Path) -> None:
    steps = run_walkthrough(tmp_path / "demo")
    assert steps["starting_catalogue"]["text.word_count"] == "unresolved"
    assert steps["starting_catalogue"]["blob.read"] == "resolved"
    assert steps["starting_catalogue"]["blob.replace"] == "resolved"
    assert steps["discover"]["ok"] is True
    assert steps["replace"]["ok"] is True
    assert steps["append_operator"]["ok"] is True
    assert steps["append_guest"]["error"]["code"] == "DENIED"
    assert steps["read_guest"]["ok"] is True
    assert steps["manufactured_ref"]["error"]["code"] == "UNKNOWN_RESOURCE"
    assert steps["sneaked_locator"]["error"]["code"] == "INVALID_REF"
    assert steps["word_count_unresolved"]["error"]["code"] == "UNRESOLVED"
    assert steps["guest_crystallise"]["ok"] is False
    assert steps["fallback_word_count"]["stdout"] == "3"
    assert steps["fallback_word_count"]["agentsop"] is None
    assert steps["word_count_resolved"]["output"]["count"] == 3
    assert steps["incomplete_fabric"]["ok"] is True
    word = next(
        cap
        for cap in steps["inspect"]["capabilities"]
        if cap["id"] == "text.word_count"
    )
    assert word["status"] == "resolved"


def test_cli_demo(tmp_path: Path) -> None:
    home = tmp_path / "cli-demo"
    assert main(["--home", str(home), "demo"]) == 0
    assert (home / "fabric.json").is_file()
