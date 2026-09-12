from __future__ import annotations

from typing import Any

from agentfabric.audit import utc_now
from agentfabric.errors import KindMismatch
from agentfabric.types import ResourceRef


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    resource = ResourceRef.from_dict(input_value["resource"])
    path = ctx.locator(resource.ref)
    record = ctx.resources.get(resource.ref)
    if record.kind != "journal":
        raise KindMismatch("journal.append requires a journal resource")
    entry = input_value["entry"].rstrip() + "\n"
    block = f"\n## {utc_now()}\n\n{entry}\n"
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    path.write_text(existing + block, encoding="utf-8")
    return {
        "resource": resource.to_dict(),
        "bytes": path.stat().st_size,
    }
