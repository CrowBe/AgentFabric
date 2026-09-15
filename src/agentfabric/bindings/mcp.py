"""Stdio MCP binding for AgentFabric.

This module is a harness adapter. It is not part of AgentSOP.
AgentSOP names capabilities; this binding exposes them as MCP tools
alongside inspect, crystallise, and a non-semantic fallback.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from agentfabric.errors import FabricError
from agentfabric.fabric import Fabric, dumps
from agentfabric.inspect import render_snapshot

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "agentfabric"
SERVER_VERSION = "0.1.0"


def tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "agentsop_list",
            "description": (
                "List AgentSOP capabilities known to this Fabric, including "
                "each public contract (input, output, effects, authority, "
                "dependencies, idempotency) and whether it is currently "
                "resolvable. This is a binding-level discovery tool, not "
                "itself an AgentSOP capability. It does not expose resolver "
                "source or implementation locators."
            ),
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "agentsop_invoke",
            "description": (
                "Invoke an AgentSOP capability as the configured Principal. "
                "Pass the capability id and a typed input object. ResourceRefs "
                "must be fabric-issued handles, not locators."
            ),
            "inputSchema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["capability"],
                "properties": {
                    "capability": {"type": "string"},
                    "input": {"type": "object"},
                    # Honoured for this long-lived stdio process. The CLI does
                    # not expose the same option because each command is a new process.
                    "idempotency_key": {"type": "string"},
                },
            },
        },
        {
            "name": "fabric_inspect",
            "description": (
                "Inspect the current Fabric: capabilities, resolution, principals, "
                "grants, known resources, and recent invocations. Requires the inspect privilege."
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "format": {"type": "string", "enum": ["text", "json"]}
                },
                "additionalProperties": False,
            },
        },
        {
            "name": "fabric_crystallise",
            "description": (
                "Bind trusted local Python source as the resolver for an existing "
                "AgentSOP capability. The source must define resolve(ctx, input). "
                "Requires the crystallise privilege. Contracts stay; resolvers are disposable."
            ),
            "inputSchema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["capability", "source"],
                "properties": {
                    "capability": {"type": "string"},
                    "source": {"type": "string"},
                    "filename": {"type": "string"},
                },
            },
        },
        {
            "name": "fallback_exec",
            "description": (
                "Broader execution escape hatch: run a shell command in the fabric "
                "workspace. This is NOT an AgentSOP capability. Use it for novel work "
                "that has not yet been crystallised. Requires the fallback privilege."
            ),
            "inputSchema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["command"],
                "properties": {
                    "command": {"type": "string"},
                    "timeout": {"type": "number"},
                },
            },
        },
    ]


class McpBinding:
    def __init__(self, fabric: Fabric, principal: str) -> None:
        self.fabric = fabric
        self.principal = principal

    def handle_tool(self, name: str, arguments: dict[str, Any] | None) -> Any:
        args = arguments or {}
        if name == "agentsop_list":
            return [
                _public_capability(self.fabric, cap_id)
                for cap_id in sorted(self.fabric.capabilities)
            ]
        if name == "agentsop_invoke":
            return self.fabric.invoke(
                self.principal,
                args["capability"],
                args.get("input") or {},
                idempotency_key=args.get("idempotency_key"),
            ).to_dict()
        if name == "fabric_inspect":
            self.fabric.authority.require_privilege(self.principal, "inspect")
            snapshot = self.fabric.snapshot()
            if args.get("format") == "json":
                return snapshot
            return render_snapshot(snapshot)
        if name == "fabric_crystallise":
            return self.fabric.crystallise(
                self.principal,
                args["capability"],
                args["source"],
                filename=args.get("filename"),
            )
        if name == "fallback_exec":
            return self.fabric.fallback_exec(
                self.principal,
                args["command"],
                timeout=float(args.get("timeout") or 15),
            )
        raise FabricError(f"unknown tool {name}", code="UNKNOWN_TOOL")


def _public_capability(fabric: Fabric, cap_id: str) -> dict[str, Any]:
    """Public catalogue row: contract fields plus live resolution metadata.

    Aligned with Capability.to_public_dict() plus runtime status. Resolver
    labels are included; source paths and other locators are not.
    """
    cap = fabric.capability(cap_id)
    view = fabric.resolution_of(cap_id)
    public = cap.to_public_dict()
    public.update(
        {
            "status": view.status,
            "resolver": view.resolver,
            "origin": view.origin,
            "detail": view.detail,
        }
    )
    return public


def _text_result(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        text = value
    else:
        text = dumps(value)
    return {"content": [{"type": "text", "text": text}]}


def _error_result(message: str) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": message}],
        "isError": True,
    }


def read_message(stdin) -> dict[str, Any] | None:
    first = stdin.readline()
    if first == "":
        return None
    if first.lower().startswith("content-length:"):
        length = int(first.split(":", 1)[1].strip())
        while True:
            line = stdin.readline()
            if line in ("", "\n", "\r\n"):
                break
        body = stdin.read(length)
        return json.loads(body)
    line = first.strip()
    if not line:
        return read_message(stdin)
    return json.loads(line)


def write_message(stdout, message: dict[str, Any], *, framed: bool) -> None:
    body = json.dumps(message, ensure_ascii=False)
    if framed:
        encoded = body.encode("utf-8")
        stdout.write(f"Content-Length: {len(encoded)}\r\n\r\n")
        stdout.write(body)
    else:
        stdout.write(body + "\n")
    stdout.flush()


def serve(fabric: Fabric, principal: str, stdin=None, stdout=None) -> None:
    binding = McpBinding(fabric, principal)
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    framed = False

    def reply(message: dict[str, Any]) -> None:
        write_message(stdout, message, framed=framed)

    while True:
        try:
            peek = stdin.readline()
            if peek == "":
                return
            if peek.lower().startswith("content-length:"):
                framed = True
                length = int(peek.split(":", 1)[1].strip())
                while True:
                    line = stdin.readline()
                    if line in ("", "\n", "\r\n"):
                        break
                request = json.loads(stdin.read(length))
            else:
                line = peek.strip()
                if not line:
                    continue
                request = json.loads(line)
        except json.JSONDecodeError:
            reply(
                {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": "parse error"},
                }
            )
            continue
        req_id = request.get("id")
        method = request.get("method")
        params = request.get("params") or {}
        if method == "initialize":
            reply(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                        "instructions": (
                            "AgentFabric exposes AgentSOP capabilities via agentsop_invoke. "
                            "Use agentsop_list first. ResourceRefs are opaque; do not pass paths. "
                            "fallback_exec is an incomplete-Fabric escape hatch, not a capability."
                        ),
                    },
                }
            )
            continue
        if method == "notifications/initialized" or method == "initialized":
            continue
        if method == "ping":
            reply({"jsonrpc": "2.0", "id": req_id, "result": {}})
            continue
        if method == "tools/list":
            reply({"jsonrpc": "2.0", "id": req_id, "result": {"tools": tools()}})
            continue
        if method == "tools/call":
            name = params.get("name")
            try:
                result = binding.handle_tool(name, params.get("arguments") or {})
                reply({"jsonrpc": "2.0", "id": req_id, "result": _text_result(result)})
            except FabricError as exc:
                reply(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": _error_result(dumps(exc.as_dict())),
                    }
                )
            except Exception as exc:  # pragma: no cover
                reply(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": _error_result(str(exc)),
                    }
                )
            continue
        if req_id is not None:
            reply(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {"code": -32601, "message": f"method not found: {method}"},
                }
            )
