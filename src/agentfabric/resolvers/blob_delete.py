from __future__ import annotations

from typing import Any

from agentfabric.types import ResourceRef


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    resource = ResourceRef.from_dict(input_value["resource"])
    ctx.resources.delete(resource, "blob")
    return {"deleted": True}
