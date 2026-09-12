from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from agentfabric.ids import new_id


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    label = input_value["label"]
    text = input_value["text"]
    kind = input_value.get("kind") or "blob"
    name = _safe_name(label)
    path = ctx.workspace / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    record = ctx.issue_ref(kind=kind, locator=path, label=name, created_by=ctx.principal)
    return {"resource": record}


def _safe_name(label: str) -> str:
    name = Path(label).name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    if not name or name in {".", ".."}:
        name = new_id("blob")
    if name.startswith("."):
        name = "blob_" + name.lstrip(".")
    return name
