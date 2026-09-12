from __future__ import annotations

from typing import Any


def resolve(ctx: Any, input_value: dict[str, Any]) -> dict[str, Any]:
    kind = input_value.get("kind")
    workspace = ctx.workspace
    workspace.mkdir(parents=True, exist_ok=True)
    resources = []
    for path in sorted(p for p in workspace.rglob("*") if p.is_file()):
        if path.name.startswith("."):
            continue
        label = path.relative_to(workspace).as_posix()
        resource_kind = "journal" if path.stem == "journal" or path.name.endswith(".journal.md") else "blob"
        if kind and resource_kind != kind:
            continue
        record = ctx.issue_ref(kind=resource_kind, locator=path, label=label)
        resources.append({"resource": record, "label": label})
    return {"resources": resources}
