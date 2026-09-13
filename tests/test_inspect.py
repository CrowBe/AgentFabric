from __future__ import annotations

from agentfabric.errors import Denied
from agentfabric.fabric import Fabric
from agentfabric.inspect import render_snapshot


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


def test_guest_may_inspect(fabric: Fabric) -> None:
    fabric.authority.require_privilege("guest", "inspect")


def test_guest_cannot_fallback_privilege(fabric: Fabric) -> None:
    try:
        fabric.authority.require_privilege("guest", "fallback")
    except Denied:
        return
    raise AssertionError("guest should lack fallback")
