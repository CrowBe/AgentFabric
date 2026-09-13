from __future__ import annotations

from pathlib import Path

from agentfabric.cli import main
from agentfabric.core import EXAMPLE_RESOLVED_CAPABILITIES
from agentfabric.setup import setup


def test_setup_binds_core_resolvers(tmp_path: Path) -> None:
    home = tmp_path / "fabric"
    report = setup(home)
    assert report["ok"] is True
    assert {item["id"] for item in report["example_resolved"]} == set(EXAMPLE_RESOLVED_CAPABILITIES)
    assert all(item["status"] == "resolved" for item in report["example_resolved"])
    assert "text.word_count" in report["unresolved"]
    assert report["unavailable"] == []
    again = setup(home)
    assert again["home"] == report["home"]
    assert again["ok"] is True


def test_cli_set_up(tmp_path: Path) -> None:
    home = tmp_path / "cli-setup"
    assert main(["--home", str(home), "set-up"]) == 0
    assert (home / "fabric.json").is_file()
