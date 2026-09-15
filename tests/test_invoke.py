from __future__ import annotations

from agentfabric.bindings.mcp import McpBinding
from agentfabric.fabric import Fabric


def test_semantic_loop_discover_read_transform_create_replace(fabric: Fabric) -> None:
    discovered = fabric.invoke("operator", "workspace.discover", {})
    assert discovered.ok
    blob = next(
        item["resource"]
        for item in discovered.output["resources"]
        if item["label"] == "notes.md"
    )
    read = fabric.invoke("operator", "blob.read", {"resource": blob})
    assert read.ok
    normalized = fabric.invoke("operator", "text.normalize", {"text": "  A   B  "})
    assert normalized.output["text"] == "A B"
    written = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "out.md", "text": normalized.output["text"]},
    )
    assert written.ok
    reread = fabric.invoke("operator", "blob.read", {"resource": written.output["resource"]})
    assert reread.output["text"] == "A B"
    replaced = fabric.invoke(
        "operator",
        "blob.replace",
        {"resource": written.output["resource"], "text": "B A"},
    )
    assert replaced.ok
    assert replaced.output["resource"] == written.output["resource"]
    reread_replaced = fabric.invoke(
        "operator", "blob.read", {"resource": written.output["resource"]}
    )
    assert reread_replaced.output["text"] == "B A"


def test_unknown_capability(fabric: Fabric) -> None:
    result = fabric.invoke("operator", "no.such", {})
    assert not result.ok
    assert result.error.code == "UNKNOWN_CAPABILITY"


def test_invalid_input(fabric: Fabric) -> None:
    result = fabric.invoke("operator", "text.normalize", {"nope": 1})
    assert not result.ok
    assert result.error.code == "INVALID_INPUT"


def test_bindings_do_not_replay_on_an_idempotency_key(fabric: Fabric) -> None:
    first = fabric.invoke(
        "operator",
        "text.normalize",
        {"text": "alpha"},
        idempotency_key="same-key",
    )
    second = fabric.invoke(
        "operator",
        "text.normalize",
        {"text": "beta"},
        idempotency_key="same-key",
    )
    assert first.ok and second.ok
    assert first.output["text"] == "alpha"
    assert second.output["text"] == "beta"


def test_non_idempotent_create_repeats_the_effect(fabric: Fabric) -> None:
    first = fabric.invoke("operator", "blob.create", {"label": "once.md", "text": "a"})
    second = fabric.invoke("operator", "blob.create", {"label": "once.md", "text": "a"})
    assert first.ok and second.ok
    assert first.output["resource"]["ref"] != second.output["resource"]["ref"]


def test_mcp_invoke_does_not_forward_an_idempotency_key(fabric: Fabric) -> None:
    binding = McpBinding(fabric, "operator")
    result = binding.handle_tool(
        "agentsop_invoke",
        {
            "capability": "text.normalize",
            "input": {"text": "hello"},
            "idempotency_key": "should-not-be-a-field",
        },
    )
    # extra fields are ignored by handle_tool today; the MCP schema must not
    # advertise the key. The invoke still succeeds as a fresh call.
    assert result["ok"] is True
    assert result["output"]["text"] == "hello"

