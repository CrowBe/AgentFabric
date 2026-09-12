from __future__ import annotations

from typing import Any

from agentfabric.errors import DependencyFailed
from agentfabric.types import ResourceRef


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    resource = ResourceRef.from_dict(input_value["resource"])
    try:
        read = ctx.invoke("blob.read", {"resource": resource.to_dict()})
        normalized = ctx.invoke("text.normalize", {"text": read["text"]})
    except Exception as exc:
        from agentfabric.errors import FabricError

        if isinstance(exc, FabricError):
            raise DependencyFailed(f"journal.digest failed: {exc.code}: {exc.message}") from exc
        raise
    headings = [line for line in read["text"].splitlines() if line.startswith("#")]
    excerpt = normalized["text"][:400]
    return {
        "text": excerpt,
        "headings": headings[:20],
        "chars": len(normalized["text"]),
    }
