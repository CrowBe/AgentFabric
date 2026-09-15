from __future__ import annotations

from agentfabric.errors import Denied
from agentfabric.fabric import Fabric, dumps
from agentfabric.inspect import render_snapshot
from agentfabric.bindings.mcp import McpBinding


def test_inspect_answers_owner_questions(fabric: Fabric) -> None:
    snapshot = fabric.snapshot()
    text = render_snapshot(snapshot)
    assert "text.word_count" in text
    assert "unresolved" in text
    assert "operator" in text
    assert "guest" in text
    cap_ids = {cap["id"] for cap in snapshot["capabilities"]}
    assert "blob.read" in cap_ids
    word = next(cap for cap in snapshot["capabilities"] if cap["id"] == "text.word_count")
    assert word["status"] == "unresolved"
    assert word["resolver"] is None
    resolved = next(cap for cap in snapshot["capabilities"] if cap["id"] == "blob.read")
    assert resolved["status"] == "resolved"
    assert resolved["resolver"] == "builtin:blob.read"
    assert resolved["origin"] == "upstream"
    assert snapshot["ownership"]["local_capabilities"] == []
    principal_ids = {p["id"] for p in snapshot["principals"]}
    assert principal_ids == {"operator", "guest"}
    assert snapshot["grants"]
    assert snapshot["resources"]
    assert snapshot["invocations"]
    assert snapshot["opportunities"] == []
    fabric.invoke("operator", "text.word_count", {"text": "one two"})
    text2 = render_snapshot(fabric.snapshot())
    assert "Opportunities" in text2
    assert any(item["capability"] == "text.word_count" for item in fabric.snapshot()["opportunities"])


def test_guest_cannot_inspect_by_default(fabric: Fabric) -> None:
    try:
        fabric.authority.require_privilege("guest", "inspect")
    except Denied:
        return
    raise AssertionError("guest should lack inspect")


def test_guest_cannot_fallback_privilege(fabric: Fabric) -> None:
    try:
        fabric.authority.require_privilege("guest", "fallback")
    except Denied:
        return
    raise AssertionError("guest should lack fallback")


def test_guest_inspect_does_not_disclose_operator_payloads(fabric: Fabric) -> None:
    secret = "STRESS_SECRET_DO_NOT_EXPOSE_48f491"
    created = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "private.txt", "text": secret},
    )
    assert created.ok
    binding = McpBinding(fabric, "guest")
    try:
        binding.handle_tool("fabric_inspect", {"format": "json"})
    except Denied:
        pass
    else:
        raise AssertionError("default guest must not inspect")
    listed = dumps(binding.handle_tool("agentsop_list", {}))
    assert secret not in listed

    fabric.principals["guest"].privileges.append("inspect")
    snapshot = McpBinding(fabric, "guest").handle_tool("fabric_inspect", {"format": "json"})
    blob = dumps(snapshot)
    assert secret not in blob
    operator_invocations = [
        item for item in snapshot["invocations"] if item.get("principal") == "operator"
    ]
    assert operator_invocations
    for item in operator_invocations:
        assert item["input"] == {"redacted": True}
        assert item["output_preview"] == {"redacted": True}
    assert any(cap["id"] == "blob.create" and cap["status"] == "resolved" for cap in snapshot["capabilities"])

    owner = McpBinding(fabric, "operator").handle_tool("fabric_inspect", {"format": "json"})
    assert secret in dumps(owner)
