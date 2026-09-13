from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from agentfabric.errors import Denied
from agentfabric.ids import new_id


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    label = input_value["label"]
    text = input_value["text"]
    kind = input_value.get("kind") or "blob"
    name = _allocate_name(ctx, label)
    path = ctx.workspace / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    record = ctx.create_ref(kind=kind, locator=path, label=name, created_by=ctx.principal)
    return {"resource": record}


def _allocate_name(ctx: Any, label: str) -> str:
    name = _safe_name(label)
    if not ctx.resources.locator_taken(ctx.workspace / name):
        return name
    stem = Path(name).stem
    suffix = Path(name).suffix
    for _ in range(8):
        candidate = _safe_name(f"{stem}_{new_id('n')}{suffix}")
        if not ctx.resources.locator_taken(ctx.workspace / candidate):
            return candidate
    raise Denied("create cannot allocate a unique locator for this label")


def _safe_name(label: str) -> str:
    name = Path(label).name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    if not name or name in {".", ".."}:
        name = new_id("blob")
    if name.startswith("."):
        name = "blob_" + name.lstrip(".")
    return name
