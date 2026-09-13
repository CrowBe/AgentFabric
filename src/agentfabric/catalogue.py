from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from agentfabric.errors import InvalidInput
from agentfabric.schema import validate_capability_document
from agentfabric.types import Capability

CapabilityOrigin = Literal["upstream", "local"]
LOCAL_PATH_PREFIXES = (".fabric/",)


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


def load_capability_dir(directory: Path) -> dict[str, Capability]:
    if not directory.is_dir():
        return {}
    loaded: dict[str, Capability] = {}
    for path in sorted(directory.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        cap = validate_capability_document(doc, source=str(path))
        if cap.id in loaded:
            raise InvalidInput(f"duplicate capability id {cap.id}")
        loaded[cap.id] = cap
    return loaded


def load_capabilities(sop_root: Path | None = None) -> dict[str, Capability]:
    root = sop_root if sop_root is not None else find_agentsop_root()
    return load_capability_dir(root / "capabilities")


def document_digest(doc: dict[str, Any]) -> str:
    canonical = json.dumps(doc, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def digest_capability_dir(directory: Path) -> dict[str, str]:
    digests: dict[str, str] = {}
    if not directory.is_dir():
        return digests
    for path in sorted(directory.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        cap_id = doc.get("id")
        if not isinstance(cap_id, str):
            continue
        digests[cap_id] = document_digest(doc)
    return digests


def digest_capability(cap: Capability) -> str:
    if cap.source:
        path = Path(cap.source)
        if path.is_file():
            doc = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(doc, dict):
                return document_digest(doc)
    return document_digest(cap.to_public_dict())


@dataclass
class Catalogue:
    capabilities: dict[str, Capability]
    origins: dict[str, CapabilityOrigin]
    collisions: list[str] = field(default_factory=list)


def merge_catalogue(
    upstream: dict[str, Capability],
    overlay: dict[str, Capability],
    *,
    upstream_owned: set[str] | None = None,
    holds: set[str] | None = None,
) -> Catalogue:
    """Merge local overlay onto upstream without silently replacing owned contracts.

    Local overlay may add new ids. It may keep an id live when that id was not
    already upstream-owned, or when a previous sync recorded a hold (local
    named it first; upstream later shipped the same name). Overlay files that
    collide with already-owned upstream ids stay on disk but do not enter the
    live catalogue unless held.
    """
    owned = set(upstream_owned) if upstream_owned is not None else set(upstream)
    held = set(holds) if holds is not None else set()
    capabilities = dict(upstream)
    origins: dict[str, CapabilityOrigin] = {cap_id: "upstream" for cap_id in upstream}
    collisions: list[str] = []
    for cap_id, cap in overlay.items():
        if cap_id in upstream:
            collisions.append(cap_id)
            if cap_id not in owned or cap_id in held:
                capabilities[cap_id] = cap
                origins[cap_id] = "local"
            continue
        capabilities[cap_id] = cap
        origins[cap_id] = "local"
    collisions.sort()
    return Catalogue(capabilities=capabilities, origins=origins, collisions=collisions)


def overlay_dir(home: Path) -> Path:
    return Path(home) / "capabilities"
