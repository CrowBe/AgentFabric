"""Scaffold an unresolved AgentSOP capability document."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Literal

from agentfabric.catalogue import (
    find_agentsop_root,
    load_capability_dir,
    merge_catalogue,
    overlay_dir,
    validate_dependency_graph,
)
from agentfabric.errors import InvalidInput
from agentfabric.schema import validate_capability_document
from agentfabric.types import CAPABILITY_ID_PATTERN

ScaffoldLayer = Literal["local", "upstream"]


def scaffold(
    capability_id: str,
    *,
    title: str | None = None,
    description: str | None = None,
    sop_root: Path | None = None,
    home: Path | None = None,
    layer: ScaffoldLayer = "local",
    force: bool = False,
) -> Path:
    if re.match(CAPABILITY_ID_PATTERN, capability_id) is None:
        raise InvalidInput(f"invalid capability id {capability_id!r}")
    root = sop_root or find_agentsop_root(home)
    upstream = load_capability_dir(root / "capabilities")
    local = load_capability_dir(overlay_dir(home)) if home is not None else {}
    if layer == "local":
        if home is None:
            raise InvalidInput("local scaffold requires a Fabric home")
        if capability_id in upstream and not force:
            raise InvalidInput(
                f"{capability_id} is already an upstream capability; "
                "choose a new id for local evolution, or pass --ship to contribute upstream"
            )
        directory = overlay_dir(home)
    else:
        directory = root / "capabilities"
        if capability_id in local and not force:
            raise InvalidInput(
                f"{capability_id} already exists in the local overlay; "
                "resolve that ownership before shipping the same id upstream"
            )
    path = directory / f"{capability_id}.json"
    if path.exists() and not force:
        raise InvalidInput(f"{path} already exists")
    doc = {
        "agentsop": "0.1",
        "id": capability_id,
        "title": title or capability_id,
        "description": description
        or (
            f"TODO: describe {capability_id} as a semantic operation. "
            "Fill input/output, then crystallise a resolver."
        ),
        "input": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        "output": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
        "effects": [],
        "idempotent": True,
        "authority": {"resources": [], "effects": []},
        "depends_on": [],
    }
    cap = validate_capability_document(doc, source=str(path))
    if layer == "local":
        overlay = dict(local)
        overlay[capability_id] = cap
        projected = merge_catalogue(upstream, overlay)
    else:
        shipped = dict(upstream)
        shipped[capability_id] = cap
        projected = merge_catalogue(shipped, local)
    validate_dependency_graph(projected.capabilities)
    directory.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return path
