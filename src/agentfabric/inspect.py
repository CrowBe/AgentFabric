from __future__ import annotations

from typing import Any

from agentfabric.types import ResolutionStatus


def render_snapshot(snapshot: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"AgentFabric  home={snapshot['home']}  agentsop={snapshot['agentsop']}")
    ownership = snapshot.get("ownership") or {}
    if ownership:
        commit = ownership.get("upstream_commit") or "—"
        local = ownership.get("local_capabilities") or []
        lines.append(
            f"Ownership    upstream_commit={commit}  local={len(local)}  "
            f"last_sync_ok={ownership.get('last_sync_ok')}"
        )
    lines.append("")
    lines.append("Capabilities")
    for cap in snapshot["capabilities"]:
        status: ResolutionStatus = cap["status"]
        resolver = cap["resolver"] or "—"
        origin = cap.get("origin") or "upstream"
        deps = f"  depends_on={','.join(cap['depends_on'])}" if cap["depends_on"] else ""
        lines.append(
            f"  {cap['id']:<22} {status:<11} origin={origin:<8} resolver={resolver}{deps}"
        )
        lines.append(f"    {cap['title']}")
    lines.append("")
    lines.append("Principals")
    for principal in snapshot["principals"]:
        priv = ",".join(principal["privileges"]) or "—"
        lines.append(f"  {principal['id']:<12} privileges={priv}")
    lines.append("")
    lines.append("Grants")
    for grant in snapshot["grants"]:
        effects = ",".join(grant["effects"])
        lines.append(
            f"  {grant['id']:<22} {grant['principal']:<10} "
            f"cap={grant['capability']:<22} resource={grant['resource']:<8} effects={effects}"
        )
    lines.append("")
    lines.append("Resources")
    if not snapshot["resources"]:
        lines.append("  (none)")
    for resource in snapshot["resources"]:
        lines.append(
            f"  {resource['ref']:<20} kind={resource['kind']:<8} label={resource['label']}"
        )
    lines.append("")
    conflicts = ownership.get("conflicts") or []
    lines.append("Sync conflicts")
    if not conflicts:
        lines.append("  (none)")
    for item in conflicts:
        cap = item.get("capability") or item.get("path") or ""
        lines.append(f"  {item.get('kind', '?'):<22} {cap}  {item.get('message', '')}")
    lines.append("")
    lines.append("Opportunities")
    opportunities = snapshot.get("opportunities") or []
    if not opportunities:
        lines.append("  (none)")
    for item in opportunities[-10:]:
        extra = item.get("capability") or item.get("command") or ""
        suffix = f"  {extra}" if extra else ""
        lines.append(f"  {item.get('kind', '?'):<12} {item.get('summary', '')}{suffix}")
    lines.append("")
    lines.append("Recent invocations")
    invocations = snapshot["invocations"]
    if not invocations:
        lines.append("  (none)")
    for item in invocations[-20:]:
        mark = "ok" if item["ok"] else (item.get("error_code") or "ERR")
        nested = " nested" if item.get("nested") else ""
        lines.append(
            f"  {item['ts']}  {item['principal']:<10} {item['capability']:<22} {mark}{nested}"
        )
    return "\n".join(lines) + "\n"
