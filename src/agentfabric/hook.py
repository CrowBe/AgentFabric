"""Harness hook adapter. Not part of AgentSOP.

Reads Cursor (or similar) hook JSON on stdin and writes JSON on stdout.
Observes shell/MCP/fallback; does not block the incomplete-Fabric escape hatch.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from agentfabric.core import EXAMPLE_RESOLVED_CAPABILITIES
from agentfabric.fabric import default_home
from agentfabric.notice import (
    maybe_shell_opportunity,
    open_opportunities,
    reminder_text,
)


def _home() -> Path:
    return default_home()


def _payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _command_from(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("command"), str):
        return payload["command"]
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, str):
        try:
            tool_input = json.loads(tool_input)
        except json.JSONDecodeError:
            return tool_input
    if isinstance(tool_input, dict):
        for key in ("command", "cmd"):
            value = tool_input.get(key)
            if isinstance(value, str):
                return value
    return ""


def _tool_name(payload: dict[str, Any]) -> str:
    return str(payload.get("tool_name") or payload.get("toolName") or "")


def handle(event: str, payload: dict[str, Any]) -> dict[str, Any]:
    home = _home()
    event = event.lower().replace("-", "").replace("_", "")
    if event == "sessionstart":
        return _session_start(home)
    if event in {"posttooluse", "aftershellexecution", "aftermcpexecution"}:
        return _after_execution(home, event, payload)
    return {}


def _session_start(home: Path) -> dict[str, Any]:
    if not (home / "fabric.json").exists():
        return {
            "additional_context": (
                "This repository is AgentFabric. After clone, run the namespaced "
                "/set-up skill (`.agents/skills/agentfabric/set-up`) before improvising "
                "with the shell. The example resolved catalogue should be live first."
            )
        }
    from agentfabric.fabric import Fabric

    try:
        fabric = Fabric(home)
    except Exception:
        return {}
    unresolved = [
        cap_id
        for cap_id in sorted(fabric.capabilities)
        if fabric.resolution_of(cap_id).status != "resolved"
    ]
    resolved = {
        cap_id
        for cap_id in fabric.capabilities
        if fabric.resolution_of(cap_id).status == "resolved"
    }
    opportunities = open_opportunities(home, resolved=resolved)
    if not unresolved and not opportunities:
        named = ", ".join(EXAMPLE_RESOLVED_CAPABILITIES)
        return {
            "additional_context": (
                f"AgentFabric is set up. Prefer named capabilities over shell. "
                f"Example resolved catalogue: {named}."
            )
        }
    return {"additional_context": reminder_text(opportunities, unresolved=unresolved)}


def _after_execution(home: Path, event: str, payload: dict[str, Any]) -> dict[str, Any]:
    if not (home / "fabric.json").exists():
        return {}
    command = _command_from(payload)
    tool = _tool_name(payload).lower()
    created = None
    if event == "aftermcpexecution" or "fallback" in tool:
        created = maybe_shell_opportunity(home, command) if command else None
        if tool in {"fallback_exec", "fallback.exec"} or payload.get("tool_name") == "fallback_exec":
            from agentfabric.notice import record

            created = record(
                home,
                kind="fallback",
                summary="MCP fallback_exec used; consider crystallising if this will recur",
                command=command or None,
            )
    elif tool in {"shell", "bash", "bashtool"} or event == "aftershellexecution":
        created = maybe_shell_opportunity(home, command)
    if created is None:
        return {}
    return {
        "additional_context": (
            "AgentFabric notice: that looks like a crystallisation candidate. "
            "Use /extend-library and agentsop/CONVENTIONS.md rather than repeating the implementation."
        )
    }


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    event = args[0] if args else "unknown"
    payload = _payload()
    try:
        result = handle(event, payload)
    except Exception:
        result = {}
    sys.stdout.write(json.dumps(result) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
