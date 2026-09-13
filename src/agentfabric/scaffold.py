"""Scaffold an unresolved AgentSOP capability document."""

from __future__ import annotations

import json
import re
from pathlib import Path

from agentfabric.catalogue import find_agentsop_root
from agentfabric.errors import InvalidInput
from agentfabric.schema import validate_capability_document
from agentfabric.types import CAPABILITY_ID_PATTERN


def scaffold(
    capability_id: str,
    *,
    title: str | None = None,
    description: str | None = None,
    sop_root: Path | None = None,
    force: bool = False,
) -> Path:
    if re.match(CAPABILITY_ID_PATTERN, capability_id) is None:
        raise InvalidInput(f"invalid capability id {capability_id!r}")
    root = sop_root or find_agentsop_root()
    path = root / "capabilities" / f"{capability_id}.json"
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
    validate_capability_document(doc, source=str(path))
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    return path
