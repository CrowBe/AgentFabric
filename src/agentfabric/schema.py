"""Minimal JSON Schema subset used by AgentSOP 0.1."""

from __future__ import annotations

import re
from typing import Any

from agentfabric.errors import InvalidInput, InvalidRef
from agentfabric.types import CAPABILITY_ID_PATTERN, KNOWN_EFFECTS, REF_PATTERN, Capability


RESOURCE_REF_DEF = "#/$defs/ResourceRef"


def _fail(message: str) -> None:
    raise InvalidInput(message)


def validate_against(schema: dict[str, Any], value: Any, *, path: str = "input") -> Any:
    if "$ref" in schema:
        if schema["$ref"] != RESOURCE_REF_DEF:
            _fail(f"{path}: unsupported $ref {schema['$ref']}")
        from agentfabric.types import ResourceRef

        try:
            ref = ResourceRef.from_dict(value)
        except InvalidRef as exc:
            raise InvalidInput(str(exc)) from exc
        return ref.to_dict()

    expected = schema.get("type")
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
        return out
    if expected == "array":
        if not isinstance(value, list):
            _fail(f"{path} must be an array")
        item_schema = schema.get("items", {})
        return [
            validate_against(item_schema, item, path=f"{path}[{i}]")
            for i, item in enumerate(value)
        ]
    if expected == "string":
        if not isinstance(value, str):
            _fail(f"{path} must be a string")
        pattern = schema.get("pattern")
        if pattern and re.match(pattern, value) is None:
            _fail(f"{path} does not match {pattern}")
        if "enum" in schema and value not in schema["enum"]:
            _fail(f"{path} must be one of {schema['enum']}")
        return value
    if expected == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            _fail(f"{path} must be an integer")
        return value
    if expected == "boolean":
        if not isinstance(value, bool):
            _fail(f"{path} must be a boolean")
        return value
    if "enum" in schema:
        if value not in schema["enum"]:
            _fail(f"{path} must be one of {schema['enum']}")
        return value
    return value


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


def extract_resource_refs(capability: Capability, input_value: dict[str, Any]) -> list[dict[str, str]]:
    refs: list[dict[str, str]] = []
    for pointer in capability.authority.get("resources", []):
        if not pointer.startswith("input."):
            raise InvalidInput(f"unsupported authority resource pointer: {pointer}")
        key = pointer[len("input.") :]
        if key not in input_value:
            raise InvalidInput(f"{pointer} is missing")
        from agentfabric.types import ResourceRef

        refs.append(ResourceRef.from_dict(input_value[key]).to_dict())
    return refs


def looks_like_ref_id(value: str) -> bool:
    return re.match(REF_PATTERN, value) is not None
