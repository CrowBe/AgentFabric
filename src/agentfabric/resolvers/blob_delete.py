from __future__ import annotations

from typing import Any

from agentfabric.types import ResourceRef


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    resource = ResourceRef.from_dict(input_value["resource"])
    record = ctx.resources.delete(resource, "blob")
    return {"resource": record.public_ref().to_dict()}
