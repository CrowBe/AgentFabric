from __future__ import annotations

import io
import json
from typing import Any

from pathlib import Path

from agentfabric.bindings.mcp import McpBinding, serve, tools
from agentfabric.demo import WORD_COUNT_SOURCE
from agentfabric.fabric import Fabric, dumps
from agentfabric.store import write_json


def test_mcp_tool_surface_is_not_agentsop() -> None:
    names = {tool["name"] for tool in tools()}
    assert names == {
        "agentsop_list",
        "agentsop_invoke",
        "fabric_inspect",
        "fabric_crystallise",
        "fallback_exec",
    }


def test_mcp_binding_semantic_and_crystallise(fabric: Fabric) -> None:
    binding = McpBinding(fabric, "operator")
    listed = binding.handle_tool("agentsop_list", {})
    word = next(item for item in listed if item["id"] == "text.word_count")
    assert word["status"] == "unresolved"
    invoked = binding.handle_tool(
        "agentsop_invoke",
        {"capability": "text.word_count", "input": {"text": "a b"}},
    )
    assert invoked["error"]["code"] == "UNRESOLVED"
    binding.handle_tool(
        "fabric_crystallise",
        {"capability": "text.word_count", "source": WORD_COUNT_SOURCE},
    )
    reused = binding.handle_tool(
        "agentsop_invoke",
        {"capability": "text.word_count", "input": {"text": "a b"}},
    )
    assert reused["ok"] is True
    assert reused["output"]["count"] == 2


def test_agentsop_list_is_self_describing(fabric: Fabric) -> None:
    binding = McpBinding(fabric, "operator")
    listed = binding.handle_tool("agentsop_list", {})
    by_id = {item["id"]: item for item in listed}
    create = by_id["blob.create"]
    public = fabric.capability("blob.create").to_public_dict()
    for key in (
        "agentsop",
        "id",
        "title",
        "description",
        "input",
        "output",
        "effects",
        "idempotent",
        "authority",
        "depends_on",
    ):
        assert create[key] == public[key]
    assert "source" not in create
    assert create["input"]["required"] == ["label", "text"]
    assert set(create["input"]["properties"]) == {"label", "text", "kind"}
    assert create["input"]["properties"]["kind"].get("enum") == ["blob", "journal"]
    assert create["authority"]["resources"] == []
    assert "locator" not in create["input"]["properties"]
    assert "path" not in create["input"]["properties"]
    read = by_id["blob.read"]
    assert read["input"]["properties"]["resource"] == {"$ref": "#/$defs/ResourceRef"}
    assert read["authority"]["resources"] == ["input.resource"]
    created = binding.handle_tool(
        "agentsop_invoke",
        {
            "capability": "blob.create",
            "input": {
                key: ("from-list.md" if key == "label" else "hello from discovered schema")
                for key in create["input"]["required"]
            },
        },
    )
    assert created["ok"] is True
    assert created["output"]["resource"]["ref"].startswith("rf_")


def test_agentsop_list_does_not_expose_resolver_source(fabric: Fabric) -> None:
    binding = McpBinding(fabric, "operator")
    listed = {item["id"]: item for item in binding.handle_tool("agentsop_list", {})}
    read = listed["blob.read"]
    assert read["resolver"] == "builtin:blob.read"
    assert "src/" not in dumps(read)
    assert ".py" not in (read["resolver"] or "")
    assert "detail" not in read


def test_agentsop_list_omits_absolute_resolver_path_detail(fabric: Fabric, tmp_path: Path) -> None:
    external = tmp_path / "outside" / "broken_resolver.py"
    external.parent.mkdir()
    external.write_text("this is not valid python :\n", encoding="utf-8")
    write_json(
        fabric.home / "resolution.json",
        {
            "text.word_count": {
                "kind": "local_python",
                "path": str(external),
                "crystallised_by": "operator",
            }
        },
    )
    reloaded = Fabric(fabric.home)
    view = reloaded.resolution_of("text.word_count")
    assert view.status == "unavailable"
    assert view.detail is not None
    assert str(external) in view.detail

    listed = {item["id"]: item for item in McpBinding(reloaded, "operator").handle_tool("agentsop_list", {})}
    row = listed["text.word_count"]
    blob = dumps(row)
    assert row["status"] == "unavailable"
    assert "detail" not in row
    assert str(external) not in blob
    assert "/outside/" not in blob
    assert row["resolver"] == "local:broken_resolver.py"


def test_mcp_stdio_initialize_and_list(fabric: Fabric) -> None:
    request = json.dumps(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test"}},
        }
    )
    listed = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
    stdin = io.StringIO(request + "\n" + listed + "\n")
    stdout = io.StringIO()
    serve(fabric, "operator", stdin=stdin, stdout=stdout)
    lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
    init = json.loads(lines[0])
    assert init["result"]["serverInfo"]["name"] == "agentfabric"
    listed_result = json.loads(lines[1])
    names = {tool["name"] for tool in listed_result["result"]["tools"]}
    assert "agentsop_invoke" in names
    assert "fallback_exec" in names


def _serve_lines(fabric: Fabric, *messages: Any) -> list[dict[str, Any]]:
    payload = "".join(
        (item if isinstance(item, str) else json.dumps(item)) + "\n" for item in messages
    )
    stdin = io.StringIO(payload)
    stdout = io.StringIO()
    serve(fabric, "operator", stdin=stdin, stdout=stdout)
    return [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]


def test_mcp_batch_does_not_terminate_serve(fabric: Fabric) -> None:
    lines = _serve_lines(
        fabric,
        [{"jsonrpc": "2.0", "id": 1, "method": "ping"}],
        {"jsonrpc": "2.0", "id": 2, "method": "ping"},
    )
    assert lines[0]["error"]["code"] == -32600
    assert "batch" in lines[0]["error"]["message"]
    assert lines[1]["id"] == 2
    assert lines[1]["result"] == {}


def test_mcp_notifications_produce_no_response(fabric: Fabric) -> None:
    lines = _serve_lines(
        fabric,
        {"jsonrpc": "2.0", "method": "ping"},
        {"jsonrpc": "2.0", "id": 3, "method": "ping"},
    )
    assert lines == [{"jsonrpc": "2.0", "id": 3, "result": {}}]


def test_mcp_parse_error_then_recovers(fabric: Fabric) -> None:
    lines = _serve_lines(
        fabric,
        "{not-json",
        {"jsonrpc": "2.0", "id": 4, "method": "ping"},
    )
    assert lines[0]["error"]["code"] == -32700
    assert lines[1]["id"] == 4
    assert lines[1]["result"] == {}


def test_mcp_unknown_method(fabric: Fabric) -> None:
    lines = _serve_lines(fabric, {"jsonrpc": "2.0", "id": 5, "method": "nope"})
    assert lines[0]["error"]["code"] == -32601


def test_mcp_tools_call_non_object_params(fabric: Fabric) -> None:
    lines = _serve_lines(
        fabric,
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": ["agentsop_list"]},
        {"jsonrpc": "2.0", "id": 7, "method": "ping"},
    )
    assert lines[0]["error"]["code"] == -32602
    blob = json.dumps(lines[0])
    assert "KeyError" not in blob
    assert "AttributeError" not in blob
    assert lines[1]["id"] == 7


def test_mcp_tools_call_missing_name_is_invalid_params(fabric: Fabric) -> None:
    lines = _serve_lines(
        fabric,
        {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"arguments": {}}},
    )
    assert lines[0]["error"]["code"] == -32602
    assert "UNKNOWN_TOOL" not in json.dumps(lines[0])


def test_mcp_invoke_missing_capability_is_invalid_params(fabric: Fabric) -> None:
    lines = _serve_lines(
        fabric,
        {
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {"name": "agentsop_invoke", "arguments": {"input": {}}},
        },
    )
    assert lines[0]["error"]["code"] == -32602
    blob = json.dumps(lines[0])
    assert "'capability'" not in blob
    assert "KeyError" not in blob
    assert "AttributeError" not in blob


def test_mcp_unknown_tool_is_structured(fabric: Fabric) -> None:
    lines = _serve_lines(
        fabric,
        {
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/call",
            "params": {"name": "not_a_tool", "arguments": {}},
        },
        {
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/call",
            "params": {"name": "agentsop_list", "arguments": {}},
        },
    )
    error_text = lines[0]["result"]["content"][0]["text"]
    assert lines[0]["result"]["isError"] is True
    assert "UNKNOWN_TOOL" in error_text
    assert lines[1]["id"] == 11
    assert "result" in lines[1]


def test_handle_tool_rejects_non_object_arguments(fabric: Fabric) -> None:
    binding = McpBinding(fabric, "operator")
    try:
        binding.handle_tool("agentsop_invoke", ["blob.create"])  # type: ignore[arg-type]
    except Exception as exc:
        assert getattr(exc, "code", None) == "INVALID_PARAMS"
        assert "KeyError" not in str(exc)
        assert "AttributeError" not in str(exc)
    else:
        raise AssertionError("non-object arguments must fail")


def test_mcp_invalid_idless_object_is_invalid_request(fabric: Fabric) -> None:
    lines = _serve_lines(
        fabric,
        {},
        {"jsonrpc": "2.0", "id": 12, "method": "ping"},
    )
    assert lines[0]["id"] is None
    assert lines[0]["error"]["code"] == -32600
    assert lines[1]["id"] == 12
    assert lines[1]["result"] == {}


def _frame(message: dict[str, Any]) -> bytes:
    body = json.dumps(message, ensure_ascii=False).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


def _parse_framed(raw: bytes) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    buf = raw
    while buf:
        header, rest = buf.split(b"\r\n\r\n", 1)
        length = int(header.decode("ascii").split(":", 1)[1].strip())
        body, buf = rest[:length], rest[length:]
        messages.append(json.loads(body.decode("utf-8")))
    return messages


def test_mcp_framed_multibyte_does_not_desync(fabric: Fabric) -> None:
    first = {"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"note": "café"}}
    second = {"jsonrpc": "2.0", "id": 2, "method": "ping"}
    stdin = io.BytesIO(_frame(first) + _frame(second))
    stdout = io.BytesIO()
    serve(fabric, "operator", stdin=stdin, stdout=stdout)
    messages = _parse_framed(stdout.getvalue())
    assert [item["id"] for item in messages] == [1, 2]
    assert all(item["result"] == {} for item in messages)


def test_mcp_negative_content_length_then_recovers(fabric: Fabric) -> None:
    ping = _frame({"jsonrpc": "2.0", "id": 13, "method": "ping"})
    stdin = io.BytesIO(b"Content-Length: -1\r\n\r\n" + ping)
    stdout = io.BytesIO()
    serve(fabric, "operator", stdin=stdin, stdout=stdout)
    messages = _parse_framed(stdout.getvalue())
    assert messages[0]["error"]["code"] == -32700
    assert messages[1]["id"] == 13
    assert messages[1]["result"] == {}
