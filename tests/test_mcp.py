from __future__ import annotations

import io
import json

from agentfabric.bindings.mcp import McpBinding, serve, tools
from agentfabric.demo import WORD_COUNT_SOURCE
from agentfabric.fabric import Fabric, dumps


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
