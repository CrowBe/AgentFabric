from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from agentfabric.errors import FabricError
from agentfabric.fabric import Fabric, default_home, dumps, load_or_init
from agentfabric.inspect import render_snapshot


def _fabric(ns: argparse.Namespace) -> Fabric:
    return load_or_init(Path(ns.home).expanduser().resolve())


def _print(value: Any, *, as_json: bool) -> None:
    if as_json or not isinstance(value, str):
        sys.stdout.write(dumps(value) if not isinstance(value, str) else value)
        if isinstance(value, str) and not value.endswith("\n"):
            sys.stdout.write("\n")
        return
    sys.stdout.write(value if value.endswith("\n") else value + "\n")


def cmd_init(ns: argparse.Namespace) -> int:
    home = Path(ns.home).expanduser().resolve()
    if (home / "fabric.json").exists() and not ns.force:
        sys.stderr.write(f"fabric already exists at {home} (pass --force to re-init)\n")
        return 1
    if ns.force and home.exists():
        import shutil

        shutil.rmtree(home)
    fabric = Fabric.init(home)
    sys.stdout.write(f"initialized fabric at {fabric.home}\n")
    sys.stdout.write(render_snapshot(fabric.snapshot()))
    return 0


def cmd_inspect(ns: argparse.Namespace) -> int:
    fabric = _fabric(ns)
    snapshot = fabric.snapshot()
    if ns.json:
        _print(snapshot, as_json=True)
    else:
        sys.stdout.write(render_snapshot(snapshot))
    return 0


def cmd_invoke(ns: argparse.Namespace) -> int:
    fabric = _fabric(ns)
    payload: dict[str, Any]
    if ns.input:
        payload = json.loads(ns.input)
    elif not sys.stdin.isatty():
        raw = sys.stdin.read().strip()
        payload = json.loads(raw) if raw else {}
    else:
        payload = {}
    result = fabric.invoke(
        ns.principal,
        ns.capability,
        payload,
        idempotency_key=ns.idempotency_key,
    )
    _print(result.to_dict(), as_json=True)
    return 0 if result.ok else 2


def cmd_crystallise(ns: argparse.Namespace) -> int:
    fabric = _fabric(ns)
    if ns.source_file:
        source = Path(ns.source_file).read_text(encoding="utf-8")
    elif ns.source:
        source = ns.source
    else:
        sys.stderr.write("pass --source or --source-file\n")
        return 2
    try:
        info = fabric.crystallise(
            ns.principal,
            ns.capability,
            source,
            filename=ns.filename,
        )
    except FabricError as exc:
        _print(exc.as_dict(), as_json=True)
        return 2
    _print(info, as_json=True)
    return 0


def cmd_fallback(ns: argparse.Namespace) -> int:
    fabric = _fabric(ns)
    try:
        result = fabric.fallback_exec(ns.principal, ns.command, timeout=ns.timeout)
    except FabricError as exc:
        _print(exc.as_dict(), as_json=True)
        return 2
    _print(result, as_json=True)
    return 0 if result["ok"] else 2


def cmd_mcp(ns: argparse.Namespace) -> int:
    from agentfabric.bindings.mcp import serve

    fabric = _fabric(ns)
    serve(fabric, ns.principal)
    return 0


def cmd_demo(ns: argparse.Namespace) -> int:
    from agentfabric.demo import run_demo

    return run_demo(Path(ns.home).expanduser().resolve(), as_json=ns.json)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentfabric",
        description="AgentFabric MVP — semantic capabilities over a thin runtime.",
    )
    parser.add_argument(
        "--home",
        default=os.environ.get("AGENTFABRIC_HOME", str(default_home())),
        help="Fabric home directory (default: $AGENTFABRIC_HOME or ./.fabric)",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="Create a local Fabric with demo principals and workspace")
    p_init.add_argument("--force", action="store_true")
    p_init.set_defaults(func=cmd_init)

    p_inspect = sub.add_parser("inspect", help="Show capabilities, grants, resources, and recent invocations")
    p_inspect.add_argument("--json", action="store_true")
    p_inspect.set_defaults(func=cmd_inspect)

    p_invoke = sub.add_parser("invoke", help="Invoke an AgentSOP capability")
    p_invoke.add_argument("capability")
    p_invoke.add_argument("input", nargs="?", help="JSON input object")
    p_invoke.add_argument("-p", "--principal", default="operator")
    p_invoke.add_argument("--idempotency-key")
    p_invoke.set_defaults(func=cmd_invoke)

    p_crys = sub.add_parser("crystallise", help="Bind a Python resolver to a capability")
    p_crys.add_argument("capability")
    p_crys.add_argument("--source", help="Python source defining resolve(ctx, input)")
    p_crys.add_argument("--source-file", help="Path to a .py resolver")
    p_crys.add_argument("-p", "--principal", default="operator")
    p_crys.add_argument("--filename")
    p_crys.set_defaults(func=cmd_crystallise)

    p_fb = sub.add_parser("fallback", help="Run a non-semantic shell command in the workspace")
    p_fb.add_argument("command")
    p_fb.add_argument("-p", "--principal", default="operator")
    p_fb.add_argument("--timeout", type=float, default=15.0)
    p_fb.set_defaults(func=cmd_fallback)

    p_mcp = sub.add_parser("mcp", help="Serve the MCP binding on stdio")
    p_mcp.add_argument("-p", "--principal", default=os.environ.get("AGENTFABRIC_PRINCIPAL", "operator"))
    p_mcp.set_defaults(func=cmd_mcp)

    p_demo = sub.add_parser("demo", help="Run the MVP walkthrough against a fresh fabric")
    p_demo.add_argument("--json", action="store_true")
    p_demo.set_defaults(func=cmd_demo)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    ns = parser.parse_args(argv)
    try:
        return ns.func(ns)
    except FabricError as exc:
        sys.stderr.write(dumps(exc.as_dict()))
        return 2
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"invalid JSON: {exc}\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
