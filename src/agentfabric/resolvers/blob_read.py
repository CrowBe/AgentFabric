from __future__ import annotations

from typing import Any

from agentfabric.types import ResourceRef


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    resource = ResourceRef.from_dict(input_value["resource"])
    path = ctx.locator(resource.ref)
    data = path.read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        from agentfabric.errors import ResolverError

        raise ResolverError("blob is not valid UTF-8") from exc
    return {"text": text, "bytes": len(data)}
