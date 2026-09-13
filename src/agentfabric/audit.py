from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from agentfabric.store import append_jsonl
from agentfabric.types import InvocationRecord


class AuditLog:
    def __init__(self, path: Path, *, limit: int = 200) -> None:
        self.path = path
        self.limit = limit

    def record(self, entry: InvocationRecord) -> None:
        append_jsonl(self.path, entry.__dict__)

    def recent(self, limit: int | None = None) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        take = limit if limit is not None else self.limit
        out: list[dict[str, Any]] = []
        for line in lines[-take:]:
            if line.strip():
                out.append(__import__("json").loads(line))
        return out


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def preview(value: Any, *, n: int = 240) -> Any:
    text = repr(value)
    if len(text) <= n:
        return value
    if isinstance(value, str):
        return value[: n - 3] + "..."
    if isinstance(value, dict):
        clipped = {}
        for key, item in value.items():
            clipped[key] = preview(item, n=max(40, n // max(len(value), 1)))
        return clipped
    return text[: n - 3] + "..."
