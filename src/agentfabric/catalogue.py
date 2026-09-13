from __future__ import annotations

import json
from pathlib import Path

from agentfabric.errors import InvalidInput
from agentfabric.schema import validate_capability_document
from agentfabric.types import Capability


def find_agentsop_root(start: Path | None = None) -> Path:
    env_start = start.resolve() if start is not None else Path.cwd().resolve()
    candidates = [env_start, *env_start.parents]
    here = Path(__file__).resolve()
    candidates.extend([here.parent, *here.parents])
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        root = candidate / "agentsop"
        if (root / "EXPERIMENTAL-0.1.md").is_file() and (root / "capabilities").is_dir():
            return root
        if candidate.name == "agentsop" and (candidate / "EXPERIMENTAL-0.1.md").is_file():
            return candidate
    raise FileNotFoundError("could not find agentsop/ Experimental 0.1 root")


def load_capabilities(sop_root: Path | None = None) -> dict[str, Capability]:
    root = sop_root if sop_root is not None else find_agentsop_root()
    cap_dir = root / "capabilities"
    loaded: dict[str, Capability] = {}
    for path in sorted(cap_dir.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        cap = validate_capability_document(doc, source=str(path))
        if cap.id in loaded:
            raise InvalidInput(f"duplicate capability id {cap.id}")
        loaded[cap.id] = cap
    return loaded
