"""Notice recurring implementation-level work that could become a capability."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from agentfabric.audit import utc_now
from agentfabric.core import EXAMPLE_RESOLVED_CAPABILITIES
from agentfabric.store import append_jsonl

IGNORE_SHELL = re.compile(
    r"(^|\b)(git|pytest|pip|pip3|python3?\s+-m\s+(pytest|agentfabric|pip)|agentfabric|"
    r"ls|pwd|which|echo|true|false|direnv|pre-commit)(\b|$)",
    re.IGNORECASE,
)
CANDIDATE_SHELL = re.compile(
    r"(python3?\s+-c\b|\bwc\b|\bjq\b|\bawk\b|\bsed\b|\bcut\b|"
    r"\bsha256sum\b|\bshasum\b|\bmd5sum\b|\bopenssl\s+dgst\b|"
    r"\bsort\b|\buniq\b|\bgrep\s+-c\b|\btr\b|\bcolumn\b)",
    re.IGNORECASE,
)


def opportunities_path(home: Path) -> Path:
    return Path(home) / "opportunities.jsonl"


def signature_for(kind: str, key: str) -> str:
    digest = hashlib.sha256(f"{kind}:{key}".encode("utf-8")).hexdigest()[:16]
    return f"{kind}:{digest}"


def looks_like_candidate_shell(command: str) -> bool:
    text = " ".join(command.split())
    if not text or IGNORE_SHELL.search(text):
        return False
    return CANDIDATE_SHELL.search(text) is not None


def record(
    home: Path,
    *,
    kind: str,
    summary: str,
    detail: str = "",
    capability: str | None = None,
    command: str | None = None,
) -> dict[str, Any] | None:
    """Append an opportunity unless an identical open signature already exists."""
    key = capability or command or summary
    sig = signature_for(kind, key)
    existing = {item["signature"] for item in load(home)}
    if sig in existing:
        return None
    item = {
        "ts": utc_now(),
        "kind": kind,
        "signature": sig,
        "summary": summary,
        "detail": detail,
        "capability": capability,
        "command": command,
    }
    append_jsonl(opportunities_path(home), item)
    return item


def load(home: Path) -> list[dict[str, Any]]:
    path = opportunities_path(home)
    if not path.exists():
        return []
    items: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            items.append(json.loads(line))
    return items


def open_opportunities(home: Path, *, resolved: set[str] | None = None) -> list[dict[str, Any]]:
    """Deduplicate and drop unresolved-capability notices that are now resolved."""
    resolved = resolved or set()
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in load(home):
        sig = item.get("signature")
        if not sig or sig in seen:
            continue
        if item.get("kind") == "unresolved" and item.get("capability") in resolved:
            continue
        seen.add(sig)
        out.append(item)
    return out


def harvest_audit(home: Path, invocations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    created: list[dict[str, Any]] = []
    for item in invocations:
        cap = item.get("capability")
        if item.get("error_code") == "UNRESOLVED" and cap:
            rec = record(
                home,
                kind="unresolved",
                summary=f"{cap} is in the catalogue but has no resolver",
                capability=cap,
            )
            if rec:
                created.append(rec)
        if cap == "fallback.exec":
            command = ""
            payload = item.get("input") or {}
            if isinstance(payload, dict):
                command = str(payload.get("command") or "")
            rec = record(
                home,
                kind="fallback",
                summary="fallback.exec used for work the Fabric does not yet name",
                detail="Prefer crystallising deterministic fallback into a capability.",
                command=command,
            )
            if rec:
                created.append(rec)
    return created


def maybe_shell_opportunity(home: Path, command: str) -> dict[str, Any] | None:
    if not looks_like_candidate_shell(command):
        return None
    return record(
        home,
        kind="shell",
        summary="shell did deterministic work that may belong in the semantic library",
        detail="If this will recur, add a capability document and a resolver. See agentsop/CONVENTIONS.md.",
        command=" ".join(command.split()),
    )


def reminder_text(opportunities: list[dict[str, Any]], *, unresolved: list[str]) -> str:
    lines = [
        "AgentFabric notice: implementation-level work can be crystallised.",
        "Follow the namespaced /extend-library skill and agentsop/CONVENTIONS.md.",
    ]
    if unresolved:
        lines.append("Unresolved capabilities: " + ", ".join(unresolved))
    for item in opportunities[:5]:
        extra = item.get("capability") or item.get("command") or ""
        lines.append(f"- {item['kind']}: {item['summary']}" + (f" ({extra})" if extra else ""))
    named = ", ".join(EXAMPLE_RESOLVED_CAPABILITIES)
    lines.append(f"Example resolved capabilities already named: {named}")
    return "\n".join(lines)
