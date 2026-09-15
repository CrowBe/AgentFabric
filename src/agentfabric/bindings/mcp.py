"""Stdio MCP binding for AgentFabric.

This module is a harness adapter. It is not part of AgentSOP.
AgentSOP names capabilities; this binding exposes them as MCP tools
alongside inspect, crystallise, and a non-semantic fallback.
"""

from __future__ import annotations

import json
import sys
from typing import Any

from agentfabric.errors import FabricError, InvalidInput
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
                "must be fabric-issued handles, not locators. Bindings do not "
                "accept an idempotency_key; `idempotent` on a capability is a "
                "semantic property of the operation, not a replay cache."
            ),
            "inputSchema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["capability"],
                "properties": {
                    "capability": {"type": "string"},
                    "input": {"type": "object"},
                },
            },
        },
        {
            "name": "fabric_inspect",
            "description": (
                "Inspect this Fabric's control-plane snapshot: capabilities, "
                "resolution, principals, grants, known resources, and recent "
                "invocations. Requires the inspect privilege. Full invocation "
                "payloads are owner/control-plane data (principals with "
                "crystallise). Other inspectors receive capability status and "
                "redacted foreign payloads. Agent-safe catalogue discovery is "
                "agentsop_list, not this tool."
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
        if not isinstance(name, str) or not name:
            raise FabricError("tool name is required", code="INVALID_PARAMS")
        if arguments is None:
            args: dict[str, Any] = {}
        elif not isinstance(arguments, dict):
            raise FabricError("tool arguments must be an object", code="INVALID_PARAMS")
        else:
            args = arguments
        if name == "agentsop_list":
            return [
                _public_capability(self.fabric, cap_id)
                for cap_id in sorted(self.fabric.capabilities)
            ]
        if name == "agentsop_invoke":
            extra = set(args) - {"capability", "input"}
            if extra:
                fields = ", ".join(sorted(extra))
                message = f"unexpected fields: {fields}"
                if "idempotency_key" in extra:
                    message += "; idempotency_key is not accepted"
                raise InvalidInput(message)
            capability = args.get("capability")
            if not isinstance(capability, str) or not capability:
                raise FabricError("capability is required", code="INVALID_PARAMS")
            payload = args.get("input") if "input" in args else {}
            if payload is None:
                payload = {}
            if not isinstance(payload, dict):
                raise FabricError("input must be an object", code="INVALID_PARAMS")
            return self.fabric.invoke(
                self.principal,
                capability,
                payload,
            ).to_dict()
        if name == "fabric_inspect":
            self.fabric.authority.require_privilege(self.principal, "inspect")
            snapshot = self.fabric.snapshot(viewer=self.principal)
            if args.get("format") == "json":
                return snapshot
            return render_snapshot(snapshot)
        if name == "fabric_crystallise":
            capability = args.get("capability")
            source = args.get("source")
            if not isinstance(capability, str) or not capability:
                raise FabricError("capability is required", code="INVALID_PARAMS")
            if not isinstance(source, str):
                raise FabricError("source is required", code="INVALID_PARAMS")
            filename = args.get("filename")
            if filename is not None and not isinstance(filename, str):
                raise FabricError("filename must be a string", code="INVALID_PARAMS")
            return self.fabric.crystallise(
                self.principal,
                capability,
                source,
                filename=filename,
            )
        if name == "fallback_exec":
            command = args.get("command")
            if not isinstance(command, str) or not command:
                raise FabricError("command is required", code="INVALID_PARAMS")
            timeout = args.get("timeout")
            if timeout is None:
                timeout_s = 15.0
            else:
                try:
                    timeout_s = float(timeout)
                except (TypeError, ValueError) as exc:
                    raise FabricError("timeout must be a number", code="INVALID_PARAMS") from exc
            return self.fabric.fallback_exec(
                self.principal,
                command,
                timeout=timeout_s,
            )
        raise FabricError(f"unknown tool {name}", code="UNKNOWN_TOOL")


def _public_capability(fabric: Fabric, cap_id: str) -> dict[str, Any]:
    """Public catalogue row: contract fields plus live resolution metadata.

    Aligned with Capability.to_public_dict() plus live resolution status.
    Resolver labels are included; source paths, load diagnostics, and other
    locators are not. Privileged `fabric_inspect` still surfaces `detail`.
    """
    cap = fabric.capability(cap_id)
    view = fabric.resolution_of(cap_id)
    public = cap.to_public_dict()
    public.update(
        {
            "status": view.status,
            "resolver": view.resolver,
            "origin": view.origin,
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


def _decode_line(raw: Any) -> str:
    if raw == "" or raw == b"":
        return ""
    if isinstance(raw, bytes):
        return raw.decode("utf-8")
    return str(raw)


def _framed_content_length(header: str) -> int:
    """Parse Content-Length as a non-negative byte count.

    Negative lengths are rejected before any body read: ``read(-1)`` drains the
    remaining stream and prevents later-valid-request recovery. MCP and
    AgentSOP do not define a framed-body size cap, so large but otherwise
    valid requests (for example a large ``fabric_crystallise`` source) are
    read in full rather than rejected in a way that desynchronizes the stream.
    """
    length = int(header.split(":", 1)[1].strip())
    if length < 0:
        raise ValueError("invalid Content-Length")
    return length


def _skip_framed_headers(stdin) -> None:
    while True:
        line = _decode_line(stdin.readline())
        if line in ("", "\n", "\r\n"):
            return


def _read_framed_body(stdin, length: int) -> str:
    """Read Content-Length bytes, not characters."""
    buffer = getattr(stdin, "buffer", None)
    if buffer is not None:
        data = buffer.read(length)
        if isinstance(data, str):
            data = data.encode("utf-8")
        if len(data) != length:
            raise ValueError("truncated framed body")
        return bytes(data).decode("utf-8")
    sample = stdin.read(0)
    if isinstance(sample, (bytes, bytearray)):
        data = stdin.read(length)
        if len(data) != length:
            raise ValueError("truncated framed body")
        return bytes(data).decode("utf-8")
    collected = bytearray()
    while len(collected) < length:
        ch = stdin.read(1)
        if ch == "" or ch == b"":
            raise ValueError("truncated framed body")
        collected.extend(ch.encode("utf-8") if isinstance(ch, str) else ch)
    if len(collected) != length:
        raise ValueError("framed body is not valid UTF-8 at Content-Length boundary")
    return collected.decode("utf-8")


def _write_bytes(stdout, data: bytes) -> None:
    buffer = getattr(stdout, "buffer", None)
    if buffer is not None:
        buffer.write(data)
        buffer.flush()
        return
    try:
        stdout.write(data)
    except TypeError:
        stdout.write(data.decode("utf-8"))
    stdout.flush()


def read_message(stdin) -> dict[str, Any] | None:
    first = _decode_line(stdin.readline())
    if first == "":
        return None
    if first.lower().startswith("content-length:"):
        length = _framed_content_length(first)
        _skip_framed_headers(stdin)
        body = _read_framed_body(stdin, length)
        return json.loads(body)
    line = first.strip()
    if not line:
        return read_message(stdin)
    return json.loads(line)


def write_message(stdout, message: dict[str, Any], *, framed: bool) -> None:
    body = json.dumps(message, ensure_ascii=False)
    encoded = body.encode("utf-8")
    if framed:
        _write_bytes(stdout, f"Content-Length: {len(encoded)}\r\n\r\n".encode("ascii") + encoded)
    else:
        _write_bytes(stdout, encoded + b"\n")


JSONRPC_PARSE_ERROR = -32700
JSONRPC_INVALID_REQUEST = -32600
JSONRPC_METHOD_NOT_FOUND = -32601
JSONRPC_INVALID_PARAMS = -32602
JSONRPC_INTERNAL_ERROR = -32603


def _rpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": code, "message": message},
    }


def _rpc_result(req_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def handle_jsonrpc(binding: McpBinding, request: Any) -> dict[str, Any] | None:
    """Validate and dispatch one JSON-RPC message. None means a notification."""
    if isinstance(request, list):
        return _rpc_error(None, JSONRPC_INVALID_REQUEST, "batch requests are not supported")
    if not isinstance(request, dict):
        return _rpc_error(None, JSONRPC_INVALID_REQUEST, "request must be a JSON object")

    jsonrpc = request.get("jsonrpc")
    method = request.get("method")
    has_id = "id" in request
    req_id = request.get("id") if has_id else None
    valid_envelope = jsonrpc == "2.0" and isinstance(method, str) and bool(method)
    if not valid_envelope:
        return _rpc_error(req_id, JSONRPC_INVALID_REQUEST, "invalid request")
    notification = not has_id

    def reply(message: dict[str, Any] | None) -> dict[str, Any] | None:
        if notification:
            return None
        return message

    params = request.get("params", {})
    if params is None:
        params = {}

    try:
        if method == "initialize":
            if params is not None and not isinstance(params, dict):
                return reply(_rpc_error(req_id, JSONRPC_INVALID_PARAMS, "params must be an object"))
            return reply(
                _rpc_result(
                    req_id,
                    {
                        "protocolVersion": PROTOCOL_VERSION,
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                        "instructions": (
                            "AgentFabric exposes AgentSOP capabilities via agentsop_invoke. "
                            "Use agentsop_list first. ResourceRefs are opaque; do not pass paths. "
                            "fallback_exec is an incomplete-Fabric escape hatch, not a capability."
                        ),
                    },
                )
            )
        if method in {"notifications/initialized", "initialized"}:
            return None
        if method == "ping":
            return reply(_rpc_result(req_id, {}))
        if method == "tools/list":
            return reply(_rpc_result(req_id, {"tools": tools()}))
        if method == "tools/call":
            if not isinstance(params, dict):
                return reply(_rpc_error(req_id, JSONRPC_INVALID_PARAMS, "params must be an object"))
            name = params.get("name")
            if not isinstance(name, str) or not name:
                return reply(
                    _rpc_error(req_id, JSONRPC_INVALID_PARAMS, "tools/call requires a string name")
                )
            arguments = params.get("arguments")
            if arguments is None:
                arguments = {}
            elif not isinstance(arguments, dict):
                return reply(
                    _rpc_error(
                        req_id, JSONRPC_INVALID_PARAMS, "tools/call arguments must be an object"
                    )
                )
            try:
                result = binding.handle_tool(name, arguments)
            except FabricError as exc:
                if exc.code == "INVALID_PARAMS":
                    return reply(_rpc_error(req_id, JSONRPC_INVALID_PARAMS, exc.message))
                return reply(_rpc_result(req_id, _error_result(dumps(exc.as_dict()))))
            except (KeyError, AttributeError, TypeError):
                return reply(_rpc_error(req_id, JSONRPC_INVALID_PARAMS, "invalid tool arguments"))
            except Exception:
                return reply(_rpc_error(req_id, JSONRPC_INTERNAL_ERROR, "internal error"))
            return reply(_rpc_result(req_id, _text_result(result)))
        return reply(_rpc_error(req_id, JSONRPC_METHOD_NOT_FOUND, f"method not found: {method}"))
    except (KeyError, AttributeError, TypeError):
        return reply(_rpc_error(req_id, JSONRPC_INVALID_REQUEST, "invalid request"))
    except Exception:
        return reply(_rpc_error(req_id, JSONRPC_INTERNAL_ERROR, "internal error"))


def serve(fabric: Fabric, principal: str, stdin=None, stdout=None) -> None:
    binding = McpBinding(fabric, principal)
    stdin = stdin if stdin is not None else sys.stdin.buffer
    stdout = stdout if stdout is not None else sys.stdout.buffer
    framed = False

    def reply(message: dict[str, Any]) -> None:
        write_message(stdout, message, framed=framed)

    while True:
        try:
            peek = _decode_line(stdin.readline())
            if peek == "":
                return
            if peek.lower().startswith("content-length:"):
                framed = True
                try:
                    length = _framed_content_length(peek)
                except ValueError:
                    _skip_framed_headers(stdin)
                    reply(_rpc_error(None, JSONRPC_PARSE_ERROR, "parse error"))
                    continue
                _skip_framed_headers(stdin)
                request = json.loads(_read_framed_body(stdin, length))
            else:
                line = peek.strip()
                if not line:
                    continue
                request = json.loads(line)
        except json.JSONDecodeError:
            reply(_rpc_error(None, JSONRPC_PARSE_ERROR, "parse error"))
            continue
        except (TypeError, ValueError, OSError):
            reply(_rpc_error(None, JSONRPC_PARSE_ERROR, "parse error"))
            continue
        try:
            message = handle_jsonrpc(binding, request)
        except Exception:
            message = _rpc_error(
                request.get("id") if isinstance(request, dict) else None,
                JSONRPC_INTERNAL_ERROR,
                "internal error",
            )
        if message is not None:
            reply(message)
