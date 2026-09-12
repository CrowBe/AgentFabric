from __future__ import annotations

from agentfabric.fabric import Fabric


def test_semantic_loop_discover_read_transform_write(fabric: Fabric) -> None:
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
        "blob.write",
        {"label": "out.md", "text": normalized.output["text"]},
    )
    assert written.ok
    reread = fabric.invoke("operator", "blob.read", {"resource": written.output["resource"]})
    assert reread.output["text"] == "A B"


def test_unknown_capability(fabric: Fabric) -> None:
    result = fabric.invoke("operator", "no.such", {})
    assert not result.ok
    assert result.error.code == "UNKNOWN_CAPABILITY"


def test_invalid_input(fabric: Fabric) -> None:
    result = fabric.invoke("operator", "text.normalize", {"nope": 1})
    assert not result.ok
    assert result.error.code == "INVALID_INPUT"


def test_idempotent_replay(fabric: Fabric) -> None:
    first = fabric.invoke(
        "operator",
        "text.normalize",
        {"text": "  hello  "},
        idempotency_key="k1",
    )
    second = fabric.invoke(
        "operator",
        "text.normalize",
        {"text": "  different  "},
        idempotency_key="k1",
    )
    assert first.ok and second.ok
    assert second.output == first.output
    assert first.output["text"] == "hello"
