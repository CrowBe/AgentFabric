from __future__ import annotations

from typing import Any

from agentfabric.types import ResourceRef


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    resource = ResourceRef.from_dict(input_value["resource"])
    read = ctx.invoke("blob.read", {"resource": resource.to_dict()})
    normalized = ctx.invoke("text.normalize", {"text": read["text"]})
    headings = [line for line in read["text"].splitlines() if line.startswith("#")]
    excerpt = normalized["text"][:400]
    return {
        "text": excerpt,
        "headings": headings[:20],
        "chars": len(normalized["text"]),
    }
