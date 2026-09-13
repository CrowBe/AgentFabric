"""Idempotent first-run setup: make the example resolved catalogue real."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from agentfabric.core import EXAMPLE_RESOLVED_CAPABILITIES
from agentfabric.fabric import load_or_init
from agentfabric.notice import harvest_audit, open_opportunities
from agentfabric.sync import origin_path, record_origin


def setup(home: Path, *, sop_root: Path | None = None) -> dict[str, Any]:
    fabric = load_or_init(home, sop_root=sop_root)
    if not origin_path(fabric.home).is_file():
        record_origin(fabric.home, sop_root=fabric.sop_root)
    harvest_audit(fabric.home, fabric.audit.recent(200))
    views = [fabric.resolution_of(cap_id) for cap_id in EXAMPLE_RESOLVED_CAPABILITIES]
    missing = [view.id for view in views if view.status != "resolved"]
    unresolved = [
        cap_id
        for cap_id in sorted(fabric.capabilities)
        if fabric.resolution_of(cap_id).status == "unresolved"
    ]
    unavailable = [
        cap_id
        for cap_id in sorted(fabric.capabilities)
        if fabric.resolution_of(cap_id).status == "unavailable"
    ]
    resolved_ids = {
        cap_id
        for cap_id in fabric.capabilities
        if fabric.resolution_of(cap_id).status == "resolved"
    }
    opportunities = open_opportunities(fabric.home, resolved=resolved_ids)
    return {
        "home": str(fabric.home),
        "ok": not missing,
        "example_resolved": [
            {
                "id": view.id,
                "status": view.status,
                "resolver": view.resolver,
            }
            for view in views
        ],
        "unresolved": unresolved,
        "unavailable": unavailable,
        "opportunities": opportunities,
        "next": [
            "Prefer agentsop_invoke / `agentfabric invoke` for named work.",
            "When fallback or shell solves a recurring deterministic job, run /extend-library.",
            "Local evolution belongs in .fabric/; after pulling upstream, run `agentfabric sync`.",
            "Read agentsop/CONVENTIONS.md before adding a capability.",
        ],
    }


def render_setup(report: dict[str, Any]) -> str:
    lines = [
        f"AgentFabric set-up  home={report['home']}",
        "",
        "Example resolved capabilities (demo catalogue, not AgentSOP primitives)",
    ]
    for item in report["example_resolved"]:
        lines.append(f"  {item['id']:<22} {item['status']:<11} {item['resolver'] or '—'}")
    lines.append("")
    lines.append("Unresolved (named, not yet crystallised)")
    if report["unresolved"]:
        for cap_id in report["unresolved"]:
            lines.append(f"  {cap_id}")
    else:
        lines.append("  (none)")
    lines.append("")
    lines.append("Unavailable (recorded resolver missing or broken)")
    if report.get("unavailable"):
        for cap_id in report["unavailable"]:
            lines.append(f"  {cap_id}")
    else:
        lines.append("  (none)")
    lines.append("")
    lines.append("Opportunities to extend the library")
    if report["opportunities"]:
        for item in report["opportunities"]:
            extra = item.get("capability") or item.get("command") or ""
            lines.append(f"  {item['kind']:<12} {item['summary']} {extra}".rstrip())
    else:
        lines.append("  (none yet — hooks will notice fallback/shell candidates)")
    lines.append("")
    lines.append("Next")
    for step in report["next"]:
        lines.append(f"  - {step}")
    lines.append("")
    return "\n".join(lines)

