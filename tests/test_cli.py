from __future__ import annotations

import argparse

import pytest

from agentfabric.bindings.mcp import tools
from agentfabric.cli import build_parser, main


def _invoke_parser() -> argparse.ArgumentParser:
    parser = build_parser()
    sub = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction))
    return sub.choices["invoke"]


def test_cli_invoke_does_not_advertise_idempotency() -> None:
    invoke = _invoke_parser()
    option_strings = [flag for action in invoke._actions for flag in action.option_strings]
    assert "--idempotency-key" not in option_strings
    assert not any("idempotency" in flag.lower() for flag in option_strings)
    help_text = invoke.format_help()
    assert "idempotency" not in help_text.lower()


def test_cli_rejects_idempotency_key(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exc:
        main(["invoke", "text.normalize", "{}", "--idempotency-key", "k1"])
    assert exc.value.code != 0
    err = capsys.readouterr().err
    assert "unrecognized arguments" in err
    assert "--idempotency-key" in err


def test_mcp_invoke_still_accepts_idempotency_key() -> None:
    invoke = next(tool for tool in tools() if tool["name"] == "agentsop_invoke")
    assert "idempotency_key" in invoke["inputSchema"]["properties"]
    description = invoke["description"].lower()
    assert "process" in description
    assert "idempotency_conflict" in description
