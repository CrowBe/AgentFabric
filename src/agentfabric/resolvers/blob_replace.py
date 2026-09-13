from __future__ import annotations

from typing import Any

from agentfabric.types import ResourceRef


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    resource = ResourceRef.from_dict(input_value["resource"])
    record = ctx.resources.require(resource, "blob")
    path = ctx.resources.locator_path(record)
    path.write_text(input_value["text"], encoding="utf-8")
    return {"resource": record.public_ref().to_dict()}
