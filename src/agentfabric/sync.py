"""Reconcile a locally evolved Fabric with the current upstream catalogue.

Git updates the implementation tree. This module does not merge Git.
It records an origin pin, classifies catalogue drift, and surfaces
conflicts that need a semantic decision.
"""

from __future__ import annotations

from fnmatch import fnmatchcase
import json
import subprocess
from pathlib import Path
from typing import Any

from agentfabric.audit import utc_now
from agentfabric.catalogue import (
    LOCAL_PATH_PREFIXES,
    digest_capability_dir,
    find_agentsop_root,
    load_capability_dir,
    overlay_dir,
)
from agentfabric.store import read_json, write_json

ORIGIN_NAME = "origin.json"
REPO_OWNERSHIP_NAME = ".agentfabric-sync.json"


def origin_path(home: Path) -> Path:
    return Path(home) / ORIGIN_NAME


def read_origin(home: Path) -> dict[str, Any]:
    data = read_json(origin_path(home), {})
    return data if isinstance(data, dict) else {}


def discover_git_root(start: Path) -> Path | None:
    current = start.resolve()
    for candidate in [current, *current.parents]:
        if (candidate / ".git").exists():
            return candidate
    return None


def git_head(start: Path) -> str | None:
    root = discover_git_root(start)
    if root is None:
        return None
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return None
    if completed.returncode != 0:
        return None
    sha = completed.stdout.strip()
    return sha or None


def git_porcelain(root: Path) -> str:
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain", "-uall"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout


def _unusable_ownership_manifest(reason: str) -> tuple[tuple[str, ...], list[dict[str, str]]]:
    return ("**",), [
        {
            "kind": "invalid_ownership_manifest",
            "path": REPO_OWNERSHIP_NAME,
            "message": (
                f"{REPO_OWNERSHIP_NAME} {reason}; until it is fixed, every untracked "
                "path outside .fabric/ is reported as repo-owned"
            ),
        }
    ]


def read_repo_ownership(root: Path) -> tuple[tuple[str, ...], list[dict[str, str]]]:
    manifest = Path(root) / REPO_OWNERSHIP_NAME
    try:
        config = read_json(manifest, {})
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        return _unusable_ownership_manifest(f"could not be read ({exc})")
    repo_owned = config.get("repo_owned") if isinstance(config, dict) else None
    includes = repo_owned.get("include") if isinstance(repo_owned, dict) else None
    if (
        not isinstance(includes, list)
        or not includes
        or not all(isinstance(pattern, str) and pattern for pattern in includes)
    ):
        if not manifest.is_file():
            return ("**",), []
        return _unusable_ownership_manifest(
            "does not declare repo_owned.include as a non-empty list of path patterns"
        )
    return tuple(includes), []


def repo_owned_includes(root: Path) -> tuple[str, ...]:
    return read_repo_ownership(root)[0]


def _matches_repo_owned(path: str, patterns: tuple[str, ...]) -> bool:
    return any(
        pattern == "**"
        or (
            fnmatchcase(path, pattern)
            if "/" in pattern
            else "/" not in path and fnmatchcase(path, pattern)
        )
        for pattern in patterns
    )


def parse_ownership_leaks(
    porcelain: str,
    *,
    local_prefixes: tuple[str, ...] = LOCAL_PATH_PREFIXES,
    untracked_includes: tuple[str, ...] = ("**",),
) -> list[dict[str, str]]:
    leaks: list[dict[str, str]] = []
    for raw in porcelain.splitlines():
        if len(raw) < 4:
            continue
        path = raw[3:].strip()
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        if path.startswith('"') and path.endswith('"'):
            path = path[1:-1]
        if not path or any(
            path == prefix.rstrip("/") or path.startswith(prefix) for prefix in local_prefixes
        ):
            continue
        status = raw[:2].strip()
        if status == "??" and not _matches_repo_owned(path, untracked_includes):
            continue
        leaks.append(
            {
                "kind": "ownership_leak",
                "path": path,
                "status": status,
                "message": (
                    f"{path} has uncommitted changes in repo-owned checkout content; "
                    "commit or remove deliberate upstream work before the Git update, "
                    "and keep machine-specific Fabric evolution under .fabric/"
                ),
            }
        )
    return leaks


def snapshot_upstream(sop_root: Path) -> dict[str, Any]:
    root = Path(sop_root).resolve()
    return {
        "commit": git_head(root),
        "root": str(root),
        "capabilities": digest_capability_dir(root / "capabilities"),
    }


def record_origin(
    home: Path,
    *,
    sop_root: Path,
    last_sync: dict[str, Any] | None = None,
    accepted: dict[str, str] | None = None,
) -> dict[str, Any]:
    snapshot = snapshot_upstream(sop_root)
    payload: dict[str, Any] = {
        "agentsop": "0.1",
        "recorded_at": utc_now(),
        "upstream": snapshot,
        "accepted": dict(accepted) if accepted is not None else dict(snapshot["capabilities"]),
    }
    if last_sync is not None:
        payload["last_sync"] = last_sync
    else:
        existing = read_origin(home).get("last_sync")
        if existing:
            payload["last_sync"] = existing
    write_json(origin_path(home), payload)
    return payload


def _diff_capabilities(
    previous: dict[str, str],
    current: dict[str, str],
) -> dict[str, list[str]]:
    prev_ids = set(previous)
    curr_ids = set(current)
    changed = sorted(
        cap_id for cap_id in (prev_ids & curr_ids) if previous[cap_id] != current[cap_id]
    )
    return {
        "added": sorted(curr_ids - prev_ids),
        "removed": sorted(prev_ids - curr_ids),
        "changed": changed,
    }


def _local_resolutions(home: Path) -> dict[str, dict[str, Any]]:
    data = read_json(Path(home) / "resolution.json", {})
    if not isinstance(data, dict):
        return {}
    out: dict[str, dict[str, Any]] = {}
    for key, meta in data.items():
        if isinstance(key, str) and isinstance(meta, dict):
            out[key] = meta
    return out


def _grant_capability_ids(home: Path) -> set[str]:
    data = read_json(Path(home) / "grants.json", [])
    if not isinstance(data, list):
        return set()
    ids: set[str] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        cap = item.get("capability")
        if isinstance(cap, str) and cap != "*":
            ids.add(cap)
    return ids


def _string_digest_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(digest) for key, digest in value.items()}


def _bound_contract_digest(
    cap_id: str,
    meta: dict[str, Any],
    *,
    accepted: dict[str, str],
    previous: dict[str, str],
) -> str | None:
    stored = meta.get("contract_digest")
    if isinstance(stored, str) and stored:
        return stored
    for source in (accepted, previous):
        digest = source.get(cap_id)
        if digest:
            return digest
    return None


def _next_accepted(
    *,
    current_caps: dict[str, str],
    previous_accepted: dict[str, str],
    conflicts: list[dict[str, Any]],
) -> dict[str, str]:
    held_local = {
        item["capability"]
        for item in conflicts
        if item.get("kind") == "id_collision"
        and item.get("live") == "local"
        and isinstance(item.get("capability"), str)
    }
    stale = {
        item["capability"]
        for item in conflicts
        if item.get("kind") == "stale_local_resolver" and isinstance(item.get("capability"), str)
    }
    removed = {
        item["capability"]
        for item in conflicts
        if item.get("kind") == "capability_removed" and isinstance(item.get("capability"), str)
    }
    accepted: dict[str, str] = {}
    for cap_id, digest in current_caps.items():
        if cap_id in held_local:
            continue
        if cap_id in stale:
            accepted[cap_id] = previous_accepted.get(cap_id, digest)
            continue
        accepted[cap_id] = digest
    for cap_id in removed:
        if cap_id in previous_accepted:
            accepted[cap_id] = previous_accepted[cap_id]
    return accepted


def sync_fabric(
    home: Path,
    *,
    sop_root: Path | None = None,
    apply: bool = True,
) -> dict[str, Any]:
    home = Path(home).resolve()
    root = Path(sop_root).resolve() if sop_root is not None else find_agentsop_root(home)
    current = snapshot_upstream(root)
    origin = read_origin(home)
    previous_upstream = origin.get("upstream") if isinstance(origin.get("upstream"), dict) else {}
    previous_caps = _string_digest_map(previous_upstream.get("capabilities"))
    if not previous_caps:
        previous_caps = _string_digest_map(current["capabilities"])
    accepted_caps = _string_digest_map(origin.get("accepted")) or dict(previous_caps)
    current_caps: dict[str, str] = _string_digest_map(current["capabilities"])
    applied = _diff_capabilities(previous_caps, current_caps)

    overlay = load_capability_dir(overlay_dir(home))
    overlay_ids = set(overlay)
    current_ids = set(current_caps)
    owned_ids = set(accepted_caps)

    conflicts: list[dict[str, Any]] = []
    for cap_id in sorted(overlay_ids & current_ids):
        if cap_id in owned_ids:
            conflicts.append(
                {
                    "kind": "id_collision",
                    "capability": cap_id,
                    "message": (
                        f"{cap_id} exists both upstream and in the local overlay; "
                        "the live catalogue keeps the already-owned upstream contract. "
                        "Rename the overlay document to keep local behaviour, or "
                        "remove it to adopt upstream."
                    ),
                    "live": "upstream",
                }
            )
        else:
            conflicts.append(
                {
                    "kind": "id_collision",
                    "capability": cap_id,
                    "message": (
                        f"upstream now ships {cap_id}, which this Fabric already named "
                        "locally. Local behaviour stays live until you intentionally "
                        "supersede it (remove or rename .fabric/capabilities/"
                        f"{cap_id}.json)."
                    ),
                    "live": "local",
                }
            )

    held_local = {
        item["capability"]
        for item in conflicts
        if item.get("kind") == "id_collision" and item.get("live") == "local"
    }
    resolutions = _local_resolutions(home)
    for cap_id, meta in sorted(resolutions.items()):
        if cap_id not in current_ids or cap_id in held_local:
            continue
        bound = _bound_contract_digest(
            cap_id, meta, accepted=accepted_caps, previous=previous_caps
        )
        if bound is None or bound == current_caps[cap_id]:
            continue
        conflicts.append(
            {
                "kind": "stale_local_resolver",
                "capability": cap_id,
                "message": (
                    f"upstream changed the {cap_id} contract and this Fabric has a "
                    "crystallised resolver for it. Re-crystallise or drop the local "
                    "resolver after confirming it still matches the new contract."
                ),
            }
        )

    local_grants = _grant_capability_ids(home)
    known_upstream = set(accepted_caps) | set(previous_caps)
    dangling = (set(resolutions) - current_ids - overlay_ids) | (
        (local_grants & known_upstream) - current_ids - overlay_ids
    )
    for cap_id in sorted(dangling):
        conflicts.append(
            {
                "kind": "capability_removed",
                "capability": cap_id,
                "message": (
                    f"upstream removed {cap_id}, but this Fabric still has a local "
                    "resolver or grant for it. Copy the contract into "
                    f".fabric/capabilities/{cap_id}.json to keep it, or drop the "
                    "local binding."
                ),
            }
        )

    git_root = discover_git_root(root)
    feedback: list[dict[str, Any]] = []
    if git_root is not None:
        includes, manifest_feedback = read_repo_ownership(git_root)
        feedback.extend(manifest_feedback)
        feedback.extend(
            parse_ownership_leaks(
                git_porcelain(git_root),
                untracked_includes=includes,
            )
        )

    next_accepted = _next_accepted(
        current_caps=current_caps,
        previous_accepted=accepted_caps,
        conflicts=conflicts,
    )
    last_sync = {
        "at": utc_now(),
        "ok": not conflicts,
        "changes": applied,
        "conflicts": conflicts,
        "feedback": feedback,
        "overlay": sorted(overlay_ids),
        "upstream_commit": current.get("commit"),
    }
    if apply:
        record_origin(
            home,
            sop_root=root,
            last_sync=last_sync,
            accepted=next_accepted,
        )
    return {
        "home": str(home),
        "ok": last_sync["ok"],
        "wrote_origin": apply,
        "upstream": current,
        **last_sync,
    }


def render_sync(report: dict[str, Any]) -> str:
    lines = [
        f"AgentFabric sync  home={report['home']}",
        f"  ok={str(report['ok']).lower()}  wrote_origin={str(report.get('wrote_origin', True)).lower()}",
    ]
    commit = (report.get("upstream") or {}).get("commit") or report.get("upstream_commit")
    if commit:
        lines.append(f"  upstream_commit={commit}")
    diff = report.get("changes")
    if isinstance(diff, dict):
        lines.append("")
        lines.append("Upstream catalogue drift")
        for label in ("added", "removed", "changed"):
            items = diff.get(label) or []
            if items:
                lines.append(f"  {label}: {', '.join(items)}")
            else:
                lines.append(f"  {label}: (none)")
    overlay = report.get("overlay") or []
    lines.append("")
    lines.append("Local overlay")
    if overlay:
        for cap_id in overlay:
            lines.append(f"  {cap_id}")
    else:
        lines.append("  (none)")
    lines.append("")
    lines.append("Conflicts (need a semantic decision)")
    conflicts = report.get("conflicts") or []
    if conflicts:
        for item in conflicts:
            cap = item.get("capability") or ""
            lines.append(f"  {item.get('kind', '?'):<22} {cap}  {item.get('message', '')}")
    else:
        lines.append("  (none)")
    lines.append("")
    lines.append("Ownership feedback")
    feedback = report.get("feedback") or []
    if feedback:
        for item in feedback:
            path = item.get("path") or item.get("capability") or ""
            lines.append(f"  {item.get('kind', '?'):<22} {path}  {item.get('message', '')}")
    else:
        lines.append("  (none — local evolution stayed inside .fabric/)")
    lines.append("")
    if report["ok"]:
        lines.append("Fabric is valid to inspect. Local overlay was preserved.")
    else:
        lines.append(
            "Fabric remains inspectable. Do not Git-merge to dismiss these conflicts; "
            "decide keep-local (rename overlay) or adopt-upstream (remove overlay / re-crystallise)."
        )
    lines.append("")
    return "\n".join(lines)
