from __future__ import annotations

from typing import Any

import pytest

from agentfabric.errors import InvalidInput, InvalidRef
from agentfabric.fabric import Fabric
from agentfabric.schema import validate_against, validate_capability_document
from agentfabric.types import ResourceRef


def _minimal_capability(**overrides: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "agentsop": "0.1",
        "id": "test.cap",
        "title": "Test",
        "description": "A test capability.",
        "input": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
        "output": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
        "effects": [],
        "idempotent": True,
        "authority": {"resources": [], "effects": []},
        "depends_on": [],
    }
    doc.update(overrides)
    return doc


def _resource_compose_capability(cap_id: str, *, depends_on: list[str]) -> dict[str, Any]:
    return {
        "agentsop": "0.1",
        "id": cap_id,
        "title": cap_id,
        "description": "Test composition capability.",
        "input": {
            "type": "object",
            "properties": {"resource": {"$ref": "#/$defs/ResourceRef"}},
            "required": ["resource"],
            "additionalProperties": False,
        },
        "output": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
            "additionalProperties": False,
        },
        "effects": ["read"],
        "idempotent": True,
        "authority": {"resources": ["input.resource"], "effects": ["read"]},
        "depends_on": depends_on,
    }


def _notes_resource(fabric: Fabric) -> dict[str, str]:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    return next(item["resource"] for item in discovered["resources"] if item["label"] == "notes.md")


def test_malformed_ref_is_invalid_ref_not_unknown(fabric: Fabric) -> None:
    result = fabric.invoke(
        "operator",
        "blob.read",
        {"resource": {"ref": "not-a-ref", "kind": "blob"}},
    )
    assert not result.ok
    assert result.error.code == "INVALID_REF"


def test_uppercase_ref_id_is_invalid_ref(fabric: Fabric) -> None:
    result = fabric.invoke(
        "operator",
        "blob.read",
        {"resource": {"ref": "rf_DEADBEEFDEAD", "kind": "blob"}},
    )
    assert not result.ok
    assert result.error.code == "INVALID_REF"


def test_hyphenated_ref_id_is_invalid_ref(fabric: Fabric) -> None:
    result = fabric.invoke(
        "operator",
        "blob.read",
        {"resource": {"ref": "rf_dead-beef", "kind": "blob"}},
    )
    assert not result.ok
    assert result.error.code == "INVALID_REF"


def test_valid_shaped_unknown_ref_is_unknown_resource(fabric: Fabric) -> None:
    result = fabric.invoke(
        "operator",
        "blob.read",
        {"resource": {"ref": "rf_deadbeefdead", "kind": "blob"}},
    )
    assert not result.ok
    assert result.error.code == "UNKNOWN_RESOURCE"


def test_invalid_caller_input_stays_invalid_input(fabric: Fabric) -> None:
    result = fabric.invoke("operator", "text.normalize", {"text": 12})
    assert not result.ok
    assert result.error.code == "INVALID_INPUT"


def test_invalid_resolver_output_is_resolver_error(fabric: Fabric) -> None:
    fabric.crystallise(
        "operator",
        "text.word_count",
        """
def resolve(ctx, input):
    return {"count": "not-an-integer"}
""",
    )
    result = fabric.invoke("operator", "text.word_count", {"text": "one two"})
    assert not result.ok
    assert result.error.code == "RESOLVER_ERROR"
    assert "invalid output" in result.error.message


def test_missing_resolver_output_field_is_resolver_error(fabric: Fabric) -> None:
    fabric.crystallise(
        "operator",
        "text.word_count",
        """
def resolve(ctx, input):
    return {"nope": 3}
""",
    )
    result = fabric.invoke("operator", "text.word_count", {"text": "one two"})
    assert not result.ok
    assert result.error.code == "RESOLVER_ERROR"


def test_malformed_resolver_output_ref_is_resolver_error(fabric: Fabric) -> None:
    fabric.capabilities["test.mint"] = validate_capability_document(
        {
            "agentsop": "0.1",
            "id": "test.mint",
            "title": "Mint",
            "description": "Returns a ResourceRef for output-schema tests.",
            "input": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
            "output": {
                "type": "object",
                "properties": {"resource": {"$ref": "#/$defs/ResourceRef"}},
                "required": ["resource"],
                "additionalProperties": False,
            },
            "effects": [],
            "idempotent": True,
            "authority": {"resources": [], "effects": []},
            "depends_on": [],
        }
    )
    fabric.crystallise(
        "operator",
        "test.mint",
        """
def resolve(ctx, input):
    return {"resource": {"ref": "not-a-ref", "kind": "blob"}}
""",
    )
    result = fabric.invoke("operator", "test.mint", {})
    assert not result.ok
    assert result.error.code == "RESOLVER_ERROR"
    assert "invalid output" in result.error.message


def test_unsupported_schema_type_rejected_at_load() -> None:
    doc = _minimal_capability()
    doc["input"]["properties"]["n"] = {"type": "number"}
    with pytest.raises(InvalidInput, match="unsupported schema type"):
        validate_capability_document(doc)


def test_unsupported_schema_construct_rejected_at_load() -> None:
    doc = _minimal_capability()
    doc["input"]["properties"]["text"] = {"type": "string", "oneOf": [{"const": "a"}]}
    with pytest.raises(InvalidInput, match="unsupported schema fields"):
        validate_capability_document(doc)


def test_format_annotation_is_unsupported_at_load() -> None:
    doc = _minimal_capability()
    doc["input"]["properties"]["text"] = {"type": "string", "format": "email"}
    with pytest.raises(InvalidInput, match="unsupported schema fields"):
        validate_capability_document(doc)


def test_existing_catalogue_schemas_remain_supported() -> None:
    validate_capability_document(_minimal_capability())


def test_resource_ref_from_dict_enforces_declared_shape() -> None:
    ResourceRef.from_dict({"ref": "rf_abc123", "kind": "blob"})
    with pytest.raises(InvalidRef):
        ResourceRef.from_dict({"ref": "rf_ABC", "kind": "blob"})
    with pytest.raises(InvalidRef):
        ResourceRef.from_dict("rf_abc123")


def test_validate_against_preserves_invalid_ref() -> None:
    schema = {"$ref": "#/$defs/ResourceRef"}
    with pytest.raises(InvalidRef):
        validate_against(schema, {"ref": "rf_NOPE", "kind": "blob"})
    with pytest.raises(InvalidInput):
        validate_against({"type": "string"}, 1)


def test_nested_dependency_failure_is_not_rewrapped(fabric: Fabric) -> None:
    fabric.capabilities["compose.mid"] = validate_capability_document(
        _resource_compose_capability("compose.mid", depends_on=["blob.read"])
    )
    fabric.capabilities["compose.outer"] = validate_capability_document(
        _resource_compose_capability("compose.outer", depends_on=["compose.mid"])
    )
    fabric.crystallise(
        "operator",
        "compose.mid",
        """
def resolve(ctx, input):
    read = ctx.invoke("blob.read", {"resource": {"ref": "rf_deadbeefdead", "kind": "blob"}})
    return {"text": read["text"]}
""",
    )
    fabric.crystallise(
        "operator",
        "compose.outer",
        """
def resolve(ctx, input):
    return ctx.invoke("compose.mid", input)
""",
    )
    result = fabric.invoke("operator", "compose.outer", {"resource": _notes_resource(fabric)})
    assert not result.ok
    assert result.error.code == "DEPENDENCY_FAILED"
    assert result.error.message.startswith("blob.read failed: UNKNOWN_RESOURCE:")
    assert "compose.mid failed" not in result.error.message
    assert "DEPENDENCY_FAILED" not in result.error.message


def _batch_capability(**overrides: Any) -> dict[str, Any]:
    doc = {
        "agentsop": "0.1",
        "id": "blob.batch_read",
        "title": "Batch read",
        "description": "Read several blobs.",
        "input": {
            "type": "object",
            "properties": {
                "resources": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/ResourceRef"},
                }
            },
            "required": ["resources"],
            "additionalProperties": False,
        },
        "output": {
            "type": "object",
            "properties": {"count": {"type": "integer"}},
            "required": ["count"],
            "additionalProperties": False,
        },
        "effects": ["read"],
        "idempotent": True,
        "authority": {"resources": ["input.resources"], "effects": ["read"]},
        "depends_on": [],
    }
    doc.update(overrides)
    return doc


def test_top_level_scalar_selector_loads() -> None:
    validate_capability_document(_resource_compose_capability("blob.read", depends_on=[]))


def test_hyphenated_top_level_selector_loads() -> None:
    doc = _minimal_capability(
        id="blob.hyphen",
        input={
            "type": "object",
            "properties": {"resource-ref": {"$ref": "#/$defs/ResourceRef"}},
            "required": ["resource-ref"],
            "additionalProperties": False,
        },
        authority={"resources": ["input.resource-ref"], "effects": []},
    )
    cap = validate_capability_document(doc)
    assert cap.authority["resources"] == ["input.resource-ref"]


def test_non_ref_field_selector_is_rejected() -> None:
    doc = _minimal_capability(authority={"resources": ["input.text"], "effects": []})
    with pytest.raises(InvalidInput, match="top-level ResourceRef"):
        validate_capability_document(doc)


def test_collection_selector_is_rejected_at_load() -> None:
    with pytest.raises(InvalidInput, match="top-level ResourceRef"):
        validate_capability_document(_batch_capability())
    starred = _batch_capability()
    starred["authority"] = {"resources": ["input.resources.*"], "effects": ["read"]}
    with pytest.raises(InvalidInput, match="nested objects and collections"):
        validate_capability_document(starred)


def test_dotted_resource_ref_property_is_rejected_at_load() -> None:
    dotted = _minimal_capability(
        id="blob.dotted",
        input={
            "type": "object",
            "properties": {"resource.ref": {"$ref": "#/$defs/ResourceRef"}},
            "required": ["resource.ref"],
            "additionalProperties": False,
        },
        authority={"resources": ["input.resource.ref"], "effects": []},
    )
    with pytest.raises(InvalidInput, match="dotted"):
        validate_capability_document(dotted)
    unnamed = _minimal_capability(
        id="blob.dotted",
        input={
            "type": "object",
            "properties": {"resource.ref": {"$ref": "#/$defs/ResourceRef"}},
            "required": ["resource.ref"],
            "additionalProperties": False,
        },
    )
    with pytest.raises(InvalidInput, match="dotted"):
        validate_capability_document(unnamed)


def test_nested_selector_is_rejected_at_load() -> None:
    nested = _minimal_capability(
        id="blob.wrapped",
        input={
            "type": "object",
            "properties": {
                "item": {
                    "type": "object",
                    "properties": {"resource": {"$ref": "#/$defs/ResourceRef"}},
                    "required": ["resource"],
                    "additionalProperties": False,
                }
            },
            "required": ["item"],
            "additionalProperties": False,
        },
        authority={"resources": ["input.item.resource"], "effects": []},
    )
    with pytest.raises(InvalidInput, match="nested objects and collections"):
        validate_capability_document(nested)


def test_missing_top_level_ref_is_invalid_input(fabric: Fabric) -> None:
    result = fabric.invoke("operator", "blob.read", {})
    assert not result.ok
    assert result.error.code == "INVALID_INPUT"


def test_scalar_selector_still_works_for_blob_read(fabric: Fabric) -> None:
    notes = _notes_resource(fabric)
    result = fabric.invoke("operator", "blob.read", {"resource": notes})
    assert result.ok
    missing = fabric.invoke("operator", "blob.replace", {"text": "nope"})
    assert not missing.ok
    assert missing.error.code == "INVALID_INPUT"
