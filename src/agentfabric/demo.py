"""End-to-end MVP walkthrough used by `agentfabric demo` and tests."""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path
from typing import Any

from agentfabric.fabric import Fabric

WORD_COUNT_SOURCE = '''\
def resolve(ctx, input):
    words = [part for part in input["text"].split() if part]
    return {"count": len(words)}
'''


def run_walkthrough(home: Path) -> dict[str, Any]:
    if home.exists():
        shutil.rmtree(home)
    fabric = Fabric.init(home)
    steps: dict[str, Any] = {}

    listing = fabric.snapshot()
    steps["starting_catalogue"] = {
        cap["id"]: cap["status"] for cap in listing["capabilities"]
    }

    discovered = fabric.invoke("operator", "workspace.discover", {}).to_dict()
    steps["discover"] = discovered
    notes = next(
        item["resource"]
        for item in discovered["output"]["resources"]
        if item["resource"]["kind"] == "blob"
    )
    journal = next(
        item["resource"]
        for item in discovered["output"]["resources"]
        if item["resource"]["kind"] == "journal"
    )

    read = fabric.invoke("operator", "blob.read", {"resource": notes}).to_dict()
    steps["read"] = {"ok": read["ok"], "bytes": read["output"]["bytes"]}

    normalized = fabric.invoke(
        "operator", "text.normalize", {"text": "  hello   AgentFabric \n\n world  "}
    ).to_dict()
    steps["normalize"] = normalized

    created = fabric.invoke(
        "operator",
        "blob.write",
        {"label": "scratch.md", "text": "scratch from operator\n"},
    ).to_dict()
    steps["write"] = created

    appended = fabric.invoke(
        "operator",
        "journal.append",
        {"resource": journal, "entry": "Crystallisation is the point of the MVP."},
    ).to_dict()
    steps["append_operator"] = {"ok": appended["ok"]}

    digest = fabric.invoke("operator", "journal.digest", {"resource": journal}).to_dict()
    steps["digest"] = {
        "ok": digest["ok"],
        "headings": digest["output"]["headings"],
        "chars": digest["output"]["chars"],
    }

    guest_denied = fabric.invoke(
        "guest",
        "journal.append",
        {"resource": journal, "entry": "guest should not be able to append"},
    ).to_dict()
    steps["append_guest"] = guest_denied

    guest_read = fabric.invoke("guest", "blob.read", {"resource": notes}).to_dict()
    steps["read_guest"] = {"ok": guest_read["ok"]}

    minted = fabric.invoke(
        "operator",
        "blob.read",
        {"resource": {"ref": "rf_deadbeefdead", "kind": "blob"}},
    ).to_dict()
    steps["manufactured_ref"] = minted

    sneaking = fabric.invoke(
        "operator",
        "blob.read",
        {"resource": {"ref": "rf_deadbeefdead", "kind": "blob", "path": "/etc/passwd"}},
    ).to_dict()
    steps["sneaked_locator"] = sneaking

    unresolved = fabric.invoke(
        "operator", "text.word_count", {"text": "one two three"}
    ).to_dict()
    steps["word_count_unresolved"] = unresolved

    guest_crystallise = None
    try:
        fabric.crystallise("guest", "text.word_count", WORD_COUNT_SOURCE)
        guest_crystallise = {"ok": True}
    except Exception as exc:
        guest_crystallise = {"ok": False, "code": getattr(exc, "code", None), "message": str(exc)}
    steps["guest_crystallise"] = guest_crystallise

    fallback = fabric.fallback_exec("operator", "python3 -c 'print(len(\"one two three\".split()))'")
    steps["fallback_word_count"] = {
        "ok": fallback["ok"],
        "stdout": fallback["stdout"].strip(),
        "agentsop": fallback["agentsop"],
    }

    guest_fallback = None
    try:
        fabric.fallback_exec("guest", "echo no")
        guest_fallback = {"ok": True}
    except Exception as exc:
        guest_fallback = {"ok": False, "code": getattr(exc, "code", None)}
    steps["guest_fallback"] = guest_fallback

    crystallised = fabric.crystallise("operator", "text.word_count", WORD_COUNT_SOURCE)
    steps["crystallise"] = crystallised

    reused = fabric.invoke(
        "operator", "text.word_count", {"text": "one two three"}
    ).to_dict()
    steps["word_count_resolved"] = reused

    outside = fabric.fallback_exec("operator", "uname -s")
    steps["incomplete_fabric"] = {
        "ok": outside["ok"],
        "stdout": outside["stdout"].strip(),
        "note": outside["note"],
    }

    steps["inspect"] = fabric.snapshot()
    steps["notes_ref"] = notes
    steps["journal_ref"] = journal
    return steps


def render_demo(steps: dict[str, Any]) -> str:
    lines = [
        "AgentFabric MVP walkthrough",
        "===========================",
        "",
        "Starting catalogue (text.word_count is unresolved):",
    ]
    for cap_id, status in steps["starting_catalogue"].items():
        lines.append(f"  {cap_id:22} {status}")
    lines += [
        "",
        "Semantic execution: discover / read / normalize / write / append / digest",
        f"  discover ok={steps['discover']['ok']}",
        f"  read bytes={steps['read']['bytes']}",
        f"  normalize -> {steps['normalize']['output']['text']!r}",
        f"  write -> {steps['write']['output']['resource']}",
        f"  digest headings={steps['digest']['headings']}",
        "",
        "Authority: operator appends, guest is denied",
        f"  operator append ok={steps['append_operator']['ok']}",
        f"  guest append     {steps['append_guest']['error']}",
        f"  guest read ok={steps['read_guest']['ok']}",
        "",
        "Resource boundary: manufactured handles fail",
        f"  unknown ref  {steps['manufactured_ref']['error']}",
        f"  sneaked path {steps['sneaked_locator']['error']}",
        "",
        "Crystallisation:",
        f"  word_count before {steps['word_count_unresolved']['error']}",
        f"  fallback probe    stdout={steps['fallback_word_count']['stdout']} agentsop={steps['fallback_word_count']['agentsop']}",
        f"  guest crystallise {steps['guest_crystallise']}",
        f"  operator bound    {steps['crystallise']}",
        f"  word_count after  {steps['word_count_resolved']['output']}",
        "",
        "Incomplete Fabric: novel work still uses the escape hatch",
        f"  {steps['incomplete_fabric']['note']}",
        f"  uname -> {steps['incomplete_fabric']['stdout']}",
        "",
    ]
    return "\n".join(lines) + "\n"


def run_demo(home: Path, *, as_json: bool = False) -> int:
    if str(home) in {"", ".", str(Path.cwd())}:
        home = Path(tempfile.mkdtemp(prefix="agentfabric-demo-"))
    steps = run_walkthrough(home)
    if as_json:
        print(json.dumps(steps, indent=2, sort_keys=True))
    else:
        print(render_demo(steps), end="")
        print(f"(fabric left at {home})")
    return 0
