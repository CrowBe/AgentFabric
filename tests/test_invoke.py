from __future__ import annotations

from pathlib import Path

from agentfabric.fabric import Fabric
from agentfabric.schema import validate_capability_document


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
        {"text": "  hello  "},
        idempotency_key="k1",
    )
    assert first.ok and second.ok
    assert second.output == first.output
    assert first.output["text"] == "hello"


def test_idempotent_replay_is_payload_bound(fabric: Fabric) -> None:
    first = fabric.invoke(
        "operator",
        "text.normalize",
        {"text": "alpha"},
        idempotency_key="same-key",
    )
    conflict = fabric.invoke(
        "operator",
        "text.normalize",
        {"text": "beta"},
        idempotency_key="same-key",
    )
    assert first.ok
    assert first.output["text"] == "alpha"
    assert not conflict.ok
    assert conflict.error.code == "IDEMPOTENCY_CONFLICT"


def test_equivalent_typed_input_replays_regardless_of_key_order(fabric: Fabric) -> None:
    first = fabric.invoke(
        "operator",
        "text.normalize",
        {"text": "hello"},
        idempotency_key="order",
    )
    second = fabric.invoke(
        "operator",
        "text.normalize",
        {"text": "hello"},
        idempotency_key="order",
    )
    assert first.ok and second.ok
    assert second.output == first.output


def test_non_idempotent_create_ignores_key_and_repeats_the_effect(fabric: Fabric) -> None:
    first = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "once.md", "text": "a"},
        idempotency_key="create-1",
    )
    second = fabric.invoke(
        "operator",
        "blob.create",
        {"label": "once.md", "text": "a"},
        idempotency_key="create-1",
    )
    assert first.ok and second.ok
    assert first.output["resource"]["ref"] != second.output["resource"]["ref"]


def test_effectful_idempotent_retry_does_not_duplicate_side_effects(fabric: Fabric) -> None:
    fabric.capabilities["blob.stamp"] = validate_capability_document(
        {
            "agentsop": "0.1",
            "id": "blob.stamp",
            "title": "Stamp blob",
            "description": "Append a stamp once; retry-safe when idempotent.",
            "input": {
                "type": "object",
                "properties": {
                    "resource": {"$ref": "#/$defs/ResourceRef"},
                    "stamp": {"type": "string"},
                },
                "required": ["resource", "stamp"],
                "additionalProperties": False,
            },
            "output": {
                "type": "object",
                "properties": {
                    "resource": {"$ref": "#/$defs/ResourceRef"},
                    "bytes": {"type": "integer"},
                },
                "required": ["resource", "bytes"],
                "additionalProperties": False,
            },
            "effects": ["write"],
            "idempotent": True,
            "authority": {"resources": ["input.resource"], "effects": ["write"]},
            "depends_on": [],
        }
    )
    fabric.crystallise(
        "operator",
        "blob.stamp",
        """
def resolve(ctx, input):
    resource = input["resource"]
    path = ctx.locator(resource["ref"])
    path.write_text(path.read_text(encoding="utf-8") + input["stamp"], encoding="utf-8")
    return {"resource": resource, "bytes": path.stat().st_size}
""",
    )
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    notes = next(item["resource"] for item in discovered["resources"] if item["label"] == "notes.md")
    payload = {"resource": notes, "stamp": "STAMP"}
    first = fabric.invoke("operator", "blob.stamp", payload, idempotency_key="retry")
    second = fabric.invoke("operator", "blob.stamp", payload, idempotency_key="retry")
    assert first.ok and second.ok
    assert second.output == first.output
    text = Path(fabric.resources.get(notes["ref"]).locator).read_text(encoding="utf-8")
    assert text.count("STAMP") == 1

