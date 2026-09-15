"""Minimal JSON Schema subset used by AgentSOP 0.1."""

from __future__ import annotations

import re
from typing import Any

from agentfabric.errors import InvalidInput
from agentfabric.types import CAPABILITY_ID_PATTERN, KNOWN_EFFECTS, REF_PATTERN, Capability


RESOURCE_REF_DEF = "#/$defs/ResourceRef"
SUPPORTED_SCHEMA_TYPES = frozenset({"object", "string", "integer", "array", "boolean"})
SCHEMA_ANNOTATION_KEYS = frozenset({"description"})
COMMON_SCHEMA_KEYS = SCHEMA_ANNOTATION_KEYS | {"type", "enum"}
KEYS_BY_SCHEMA_TYPE = {
    "object": COMMON_SCHEMA_KEYS | {"properties", "required", "additionalProperties"},
    "string": COMMON_SCHEMA_KEYS | {"pattern"},
    "integer": COMMON_SCHEMA_KEYS,
    "array": COMMON_SCHEMA_KEYS | {"items"},
    "boolean": COMMON_SCHEMA_KEYS,
}


def _fail(message: str) -> None:
    raise InvalidInput(message)


def assert_supported_schema(schema: Any, *, path: str = "schema") -> None:
    """Reject schema constructs the 0.1 runtime does not actually validate."""
    if not isinstance(schema, dict):
        raise InvalidInput(f"{path} must be a schema object")
    if "$ref" in schema:
        extra = set(schema) - SCHEMA_ANNOTATION_KEYS - {"$ref"}
        if extra:
            raise InvalidInput(f"{path} has unsupported schema fields: {sorted(extra)}")
        if schema["$ref"] != RESOURCE_REF_DEF:
            raise InvalidInput(f"{path}: unsupported $ref {schema['$ref']}")
        return
    expected = schema.get("type")
    if expected not in SUPPORTED_SCHEMA_TYPES:
        raise InvalidInput(f"{path} has unsupported schema type {expected!r}")
    extra = set(schema) - KEYS_BY_SCHEMA_TYPE[expected]
    if extra:
        raise InvalidInput(f"{path} has unsupported schema fields: {sorted(extra)}")
    if expected == "object":
        props = schema.get("properties", {})
        if not isinstance(props, dict):
            raise InvalidInput(f"{path}.properties must be an object")
        for key, subschema in props.items():
            assert_supported_schema(subschema, path=f"{path}.properties.{key}")
        additional = schema.get("additionalProperties", True)
        if isinstance(additional, dict):
            assert_supported_schema(additional, path=f"{path}.additionalProperties")
        elif not isinstance(additional, bool):
            raise InvalidInput(f"{path}.additionalProperties must be a boolean or schema")
        required = schema.get("required", [])
        if not isinstance(required, list) or any(not isinstance(item, str) for item in required):
            raise InvalidInput(f"{path}.required must be a list of strings")
    elif expected == "array" and "items" in schema:
        assert_supported_schema(schema["items"], path=f"{path}.items")
    if "enum" in schema:
        values = schema["enum"]
        if not isinstance(values, list) or not values:
            raise InvalidInput(f"{path}.enum must be a non-empty list")
    if expected == "string" and "pattern" in schema and not isinstance(schema["pattern"], str):
        raise InvalidInput(f"{path}.pattern must be a string")


def validate_against(schema: dict[str, Any], value: Any, *, path: str = "input") -> Any:
    if "$ref" in schema:
        if schema["$ref"] != RESOURCE_REF_DEF:
            _fail(f"{path}: unsupported $ref {schema['$ref']}")
        from agentfabric.types import ResourceRef

        return ResourceRef.from_dict(value).to_dict()

    expected = schema.get("type")
    if expected is not None and expected not in SUPPORTED_SCHEMA_TYPES:
        _fail(f"{path}: unsupported schema type {expected!r}")

    result: Any
    if expected == "object":
        if not isinstance(value, dict):
            _fail(f"{path} must be an object")
        additional = schema.get("additionalProperties", True)
        props = schema.get("properties", {})
        if additional is False:
            extra = set(value) - set(props)
            if extra:
                _fail(f"{path} has unexpected fields: {sorted(extra)}")
        required = schema.get("required", [])
        for key in required:
            if key not in value:
                _fail(f"{path}.{key} is required")
        out: dict[str, Any] = {}
        for key, item in value.items():
            if key in props:
                out[key] = validate_against(props[key], item, path=f"{path}.{key}")
            elif additional is True:
                out[key] = item
            elif isinstance(additional, dict):
                out[key] = validate_against(additional, item, path=f"{path}.{key}")
        result = out
    elif expected == "array":
        if not isinstance(value, list):
            _fail(f"{path} must be an array")
        item_schema = schema.get("items", {})
        result = [
            validate_against(item_schema, item, path=f"{path}[{i}]")
            for i, item in enumerate(value)
        ]
    elif expected == "string":
        if not isinstance(value, str):
            _fail(f"{path} must be a string")
        pattern = schema.get("pattern")
        if pattern and re.match(pattern, value) is None:
            _fail(f"{path} does not match {pattern}")
        result = value
    elif expected == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            _fail(f"{path} must be an integer")
        result = value
    elif expected == "boolean":
        if not isinstance(value, bool):
            _fail(f"{path} must be a boolean")
        result = value
    else:
        result = value

    if "enum" in schema and result not in schema["enum"]:
        _fail(f"{path} must be one of {schema['enum']}")
    return result


def validate_capability_document(doc: dict[str, Any], *, source: str = "") -> Capability:
    if doc.get("agentsop") != "0.1":
        raise InvalidInput("agentsop must be '0.1'")
    cap_id = doc.get("id")
    if not isinstance(cap_id, str) or re.match(CAPABILITY_ID_PATTERN, cap_id) is None:
        raise InvalidInput("invalid capability id")
    for key in ("title", "description"):
        if not isinstance(doc.get(key), str) or not doc[key]:
            raise InvalidInput(f"{key} is required")
    if not isinstance(doc.get("input"), dict) or not isinstance(doc.get("output"), dict):
        raise InvalidInput("input and output must be schema objects")
    effects = doc.get("effects")
    if not isinstance(effects, list) or any(e not in KNOWN_EFFECTS for e in effects):
        raise InvalidInput("effects must be a list of known effects")
    if not isinstance(doc.get("idempotent"), bool):
        raise InvalidInput("idempotent must be a boolean")
    authority = doc.get("authority")
    if not isinstance(authority, dict):
        raise InvalidInput("authority is required")
    if set(authority.keys()) - {"resources", "effects"}:
        raise InvalidInput("authority has unexpected fields")
    if not isinstance(authority.get("resources"), list) or not isinstance(
        authority.get("effects"), list
    ):
        raise InvalidInput("authority.resources and authority.effects must be lists")
    if any(e not in KNOWN_EFFECTS for e in authority["effects"]):
        raise InvalidInput("authority.effects must be known effects")
    depends = doc.get("depends_on")
    if not isinstance(depends, list) or any(not isinstance(d, str) for d in depends):
        raise InvalidInput("depends_on must be a list of capability ids")
    extra = set(doc) - {
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
    }
    if extra:
        raise InvalidInput(f"capability has unexpected fields: {sorted(extra)}")
    assert_supported_schema(doc["input"], path="input")
    assert_supported_schema(doc["output"], path="output")
    for pointer in authority["resources"]:
        assert_authority_selector(pointer, doc["input"])
    return Capability(
        agentsop="0.1",
        id=cap_id,
        title=doc["title"],
        description=doc["description"],
        input=doc["input"],
        output=doc["output"],
        effects=list(effects),
        idempotent=doc["idempotent"],
        authority={
            "resources": list(authority["resources"]),
            "effects": list(authority["effects"]),
        },
        depends_on=list(depends),
        source=source,
    )


SELECTOR_PROPERTY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def parse_authority_selector(pointer: str) -> list[str]:
    if not isinstance(pointer, str) or not pointer.startswith("input."):
        raise InvalidInput(f"unsupported authority resource selector: {pointer!r}")
    rest = pointer[len("input.") :]
    if not rest:
        raise InvalidInput(f"unsupported authority resource selector: {pointer!r}")
    parts = rest.split(".")
    for part in parts:
        if part == "*":
            continue
        if SELECTOR_PROPERTY.match(part) is None:
            raise InvalidInput(f"unsupported authority resource selector: {pointer!r}")
    return parts


def assert_authority_selector(pointer: str, input_schema: dict[str, Any]) -> None:
    """Reject selectors that do not target a ResourceRef-shaped schema node."""
    parts = parse_authority_selector(pointer)
    current: Any = input_schema
    path = "input"
    for part in parts:
        if part == "*":
            if not isinstance(current, dict) or current.get("type") != "array":
                raise InvalidInput(f"{pointer}: '*' requires an array at {path}")
            current = current.get("items")
            path = f"{path}.*"
            continue
        if not isinstance(current, dict) or current.get("type") != "object":
            raise InvalidInput(f"{pointer}: {path} is not an object")
        props = current.get("properties")
        if not isinstance(props, dict) or part not in props:
            raise InvalidInput(f"{pointer}: {path} has no property {part!r}")
        current = props[part]
        path = f"{path}.{part}"
    if not isinstance(current, dict) or current.get("$ref") != RESOURCE_REF_DEF:
        raise InvalidInput(f"{pointer} does not target a ResourceRef schema node")


def extract_resource_refs(capability: Capability, input_value: dict[str, Any]) -> list[dict[str, str]]:
    refs: list[dict[str, str]] = []
    for pointer in capability.authority.get("resources", []):
        parts = parse_authority_selector(pointer)
        refs.extend(_extract_refs(input_value, parts, path="input"))
    return refs


def _extract_refs(value: Any, parts: list[str], *, path: str) -> list[dict[str, str]]:
    if not parts:
        from agentfabric.types import ResourceRef

        return [ResourceRef.from_dict(value).to_dict()]
    head, *tail = parts
    if head == "*":
        if not isinstance(value, list):
            raise InvalidInput(f"{path} must be an array")
        refs: list[dict[str, str]] = []
        for i, item in enumerate(value):
            refs.extend(_extract_refs(item, tail, path=f"{path}[{i}]"))
        return refs
    if not isinstance(value, dict):
        raise InvalidInput(f"{path} must be an object")
    if head not in value:
        raise InvalidInput(f"{path}.{head} is missing")
    return _extract_refs(value[head], tail, path=f"{path}.{head}")


def looks_like_ref_id(value: str) -> bool:
    return re.match(REF_PATTERN, value) is not None
