from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from agentfabric.catalogue import find_agentsop_root, merge_catalogue
from agentfabric.cli import main
from agentfabric.fabric import Fabric
from agentfabric.scaffold import scaffold
from agentfabric.schema import validate_capability_document
from agentfabric.sync import (
    parse_ownership_leaks,
    read_origin,
    read_repo_ownership,
    render_sync,
    repo_owned_includes,
    sync_fabric,
)
from agentfabric.types import Capability


def _cap(cap_id: str, *, title: str | None = None, source: str = "") -> Capability:
    doc = {
        "agentsop": "0.1",
        "id": cap_id,
        "title": title or cap_id,
        "description": f"{cap_id} for tests.",
        "input": {"type": "object", "properties": {}, "additionalProperties": False},
        "output": {"type": "object", "properties": {}, "additionalProperties": False},
        "effects": [],
        "idempotent": True,
        "authority": {"resources": [], "effects": []},
        "depends_on": [],
    }
    return validate_capability_document(doc, source=source)


def _init_git_repo(path: Path) -> None:
    try:
        completed = subprocess.run(
            ["git", "init", "-q", str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:  # pragma: no cover - git missing
        pytest.skip("git is unavailable")
    if completed.returncode != 0:  # pragma: no cover - git unusable
        pytest.skip("git could not initialise a scratch repository")


def _copy_sop(tmp_path: Path, ids: list[str]) -> Path:
    src = find_agentsop_root()
    dest = tmp_path / "agentsop"
    (dest / "capabilities").mkdir(parents=True)
    (dest / "EXPERIMENTAL-0.1.md").write_text("# stub\n", encoding="utf-8")
    for cap_id in ids:
        shutil.copy(src / "capabilities" / f"{cap_id}.json", dest / "capabilities" / f"{cap_id}.json")
    return dest


def test_merge_adds_local_only_ids() -> None:
    upstream = {"blob.read": _cap("blob.read")}
    overlay = {"text.hash": _cap("text.hash", source="/tmp/overlay/text.hash.json")}
    catalogue = merge_catalogue(upstream, overlay)
    assert set(catalogue.capabilities) == {"blob.read", "text.hash"}
    assert catalogue.origins["blob.read"] == "upstream"
    assert catalogue.origins["text.hash"] == "local"
    assert catalogue.collisions == []


def test_merge_does_not_override_owned_upstream_id() -> None:
    upstream = {"blob.read": _cap("blob.read", title="Upstream")}
    overlay = {"blob.read": _cap("blob.read", title="Local fork")}
    catalogue = merge_catalogue(upstream, overlay, upstream_owned={"blob.read"})
    assert catalogue.capabilities["blob.read"].title == "Upstream"
    assert catalogue.origins["blob.read"] == "upstream"
    assert catalogue.collisions == ["blob.read"]


def test_merge_holds_local_when_upstream_later_claims_the_id() -> None:
    upstream = {"text.hash": _cap("text.hash", title="Shipped")}
    overlay = {"text.hash": _cap("text.hash", title="Local")}
    without_hold = merge_catalogue(upstream, overlay, upstream_owned={"text.hash"})
    assert without_hold.capabilities["text.hash"].title == "Shipped"
    catalogue = merge_catalogue(
        upstream,
        overlay,
        upstream_owned={"text.hash"},
        holds={"text.hash"},
    )
    assert catalogue.capabilities["text.hash"].title == "Local"
    assert catalogue.origins["text.hash"] == "local"
    assert catalogue.collisions == ["text.hash"]


def test_scaffold_writes_local_overlay(fabric: Fabric) -> None:
    path = scaffold(
        "text.hash",
        title="Hash text",
        description="SHA-256 of a text value.",
        home=fabric.home,
    )
    assert path == fabric.home / "capabilities" / "text.hash.json"
    reloaded = Fabric(fabric.home)
    view = reloaded.resolution_of("text.hash")
    assert view.origin == "local"
    assert view.status == "unresolved"


def test_scaffold_rejects_upstream_id_for_local_layer(fabric: Fabric) -> None:
    try:
        scaffold("blob.read", home=fabric.home)
    except Exception as exc:
        assert "upstream" in str(exc).lower()
    else:
        raise AssertionError("local scaffold must not shadow blob.read")


def test_owned_overlay_collision_keeps_upstream_live(fabric: Fabric) -> None:
    overlay = fabric.home / "capabilities" / "blob.read.json"
    overlay.write_text(
        json.dumps(
            {
                "agentsop": "0.1",
                "id": "blob.read",
                "title": "Local fork",
                "description": "Must not replace the shipped contract.",
                "input": {"type": "object", "properties": {}, "additionalProperties": False},
                "output": {"type": "object", "properties": {}, "additionalProperties": False},
                "effects": [],
                "idempotent": True,
                "authority": {"resources": [], "effects": []},
                "depends_on": [],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    reloaded = Fabric(fabric.home)
    assert reloaded.resolution_of("blob.read").origin == "upstream"
    assert reloaded.resolution_of("blob.read").title == "Read blob"
    assert "blob.read" in reloaded.catalogue_collisions
    snapshot = reloaded.snapshot()
    kinds = {item["kind"] for item in snapshot["ownership"]["conflicts"]}
    assert "id_collision" in kinds


def test_sync_clean_when_upstream_unchanged(fabric: Fabric) -> None:
    report = sync_fabric(fabric.home, sop_root=fabric.sop_root)
    assert report["ok"] is True
    assert report["changes"] == {"added": [], "removed": [], "changed": []}
    assert report["conflicts"] == []
    origin = read_origin(fabric.home)
    assert origin["upstream"]["capabilities"]
    assert origin["last_sync"]["ok"] is True


def test_sync_preserves_local_when_upstream_adds_same_id(tmp_path: Path) -> None:
    sop = _copy_sop(tmp_path, ["workspace.discover"])
    fabric = Fabric.init(tmp_path / "fabric", sop_root=sop)
    scaffold(
        "text.hash",
        title="Hash text",
        description="Local hash.",
        home=fabric.home,
        sop_root=sop,
    )
    shutil.copy(
        find_agentsop_root() / "capabilities" / "text.normalize.json",
        sop / "capabilities" / "text.hash.json",
    )
    hash_doc = json.loads((sop / "capabilities" / "text.hash.json").read_text(encoding="utf-8"))
    hash_doc["id"] = "text.hash"
    hash_doc["title"] = "Upstream hash"
    (sop / "capabilities" / "text.hash.json").write_text(
        json.dumps(hash_doc, indent=2) + "\n", encoding="utf-8"
    )

    report = sync_fabric(fabric.home, sop_root=sop)
    assert report["ok"] is False
    assert "text.hash" in report["changes"]["added"]
    collision = next(item for item in report["conflicts"] if item["kind"] == "id_collision")
    assert collision["capability"] == "text.hash"
    assert collision["live"] == "local"

    reloaded = Fabric(fabric.home, sop_root=sop)
    assert reloaded.resolution_of("text.hash").origin == "local"
    assert reloaded.resolution_of("text.hash").title == "Hash text"

    again = sync_fabric(fabric.home, sop_root=sop)
    assert again["ok"] is False
    again_collision = next(item for item in again["conflicts"] if item["kind"] == "id_collision")
    assert again_collision["capability"] == "text.hash"
    assert again_collision["live"] == "local"
    held = Fabric(fabric.home, sop_root=sop)
    assert held.resolution_of("text.hash").origin == "local"


def test_sync_flags_stale_local_resolver(tmp_path: Path) -> None:
    sop = _copy_sop(tmp_path, ["workspace.discover", "text.normalize"])
    fabric = Fabric.init(tmp_path / "fabric", sop_root=sop)
    fabric.crystallise(
        "operator",
        "text.normalize",
        "def resolve(ctx, input):\n    return {\"text\": input[\"text\"].strip()}\n",
    )
    path = sop / "capabilities" / "text.normalize.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["description"] = "Changed contract description."
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    report = sync_fabric(fabric.home, sop_root=sop)
    assert report["ok"] is False
    assert report["changes"]["changed"] == ["text.normalize"]
    assert any(item["kind"] == "stale_local_resolver" for item in report["conflicts"])
    snapshot = Fabric(fabric.home, sop_root=sop).snapshot()
    assert snapshot["capabilities"]
    assert snapshot["ownership"]["conflicts"]

    again = sync_fabric(fabric.home, sop_root=sop)
    assert again["ok"] is False
    assert again["changes"]["changed"] == []
    assert any(item["kind"] == "stale_local_resolver" for item in again["conflicts"])


def test_sync_flags_removed_capability_still_in_use(tmp_path: Path) -> None:
    sop = _copy_sop(tmp_path, ["workspace.discover", "text.normalize"])
    fabric = Fabric.init(tmp_path / "fabric", sop_root=sop)
    fabric.crystallise(
        "operator",
        "text.normalize",
        "def resolve(ctx, input):\n    return {\"text\": input[\"text\"].strip()}\n",
    )
    (sop / "capabilities" / "text.normalize.json").unlink()
    report = sync_fabric(fabric.home, sop_root=sop)
    assert report["ok"] is False
    assert report["changes"]["removed"] == ["text.normalize"]
    assert any(item["kind"] == "capability_removed" for item in report["conflicts"])
    Fabric(fabric.home, sop_root=sop).snapshot()

    again = sync_fabric(fabric.home, sop_root=sop)
    assert again["ok"] is False
    assert again["changes"]["removed"] == []
    assert any(item["kind"] == "capability_removed" for item in again["conflicts"])


def test_sync_check_does_not_write_origin(fabric: Fabric) -> None:
    before = read_origin(fabric.home)
    report = sync_fabric(fabric.home, sop_root=fabric.sop_root, apply=False)
    assert report["wrote_origin"] is False
    assert read_origin(fabric.home)["recorded_at"] == before["recorded_at"]


def test_stale_resolver_without_stored_digest_survives_second_sync(tmp_path: Path) -> None:
    sop = _copy_sop(tmp_path, ["workspace.discover", "text.normalize"])
    fabric = Fabric.init(tmp_path / "fabric", sop_root=sop)
    fabric.crystallise(
        "operator",
        "text.normalize",
        "def resolve(ctx, input):\n    return {\"text\": input[\"text\"].strip()}\n",
    )
    resolution = json.loads((fabric.home / "resolution.json").read_text(encoding="utf-8"))
    resolution["text.normalize"].pop("contract_digest", None)
    (fabric.home / "resolution.json").write_text(
        json.dumps(resolution, indent=2) + "\n", encoding="utf-8"
    )
    path = sop / "capabilities" / "text.normalize.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["description"] = "Changed contract description."
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    first = sync_fabric(fabric.home, sop_root=sop)
    second = sync_fabric(fabric.home, sop_root=sop)
    assert first["ok"] is False
    assert second["ok"] is False
    assert any(item["kind"] == "stale_local_resolver" for item in first["conflicts"])
    assert any(item["kind"] == "stale_local_resolver" for item in second["conflicts"])


def test_recrystallise_clears_stale_local_resolver(tmp_path: Path) -> None:
    sop = _copy_sop(tmp_path, ["workspace.discover", "text.normalize"])
    fabric = Fabric.init(tmp_path / "fabric", sop_root=sop)
    source = "def resolve(ctx, input):\n    return {\"text\": input[\"text\"].strip()}\n"
    fabric.crystallise("operator", "text.normalize", source)
    path = sop / "capabilities" / "text.normalize.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["description"] = "Changed contract description."
    path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    assert sync_fabric(fabric.home, sop_root=sop)["ok"] is False

    refreshed = Fabric(fabric.home, sop_root=sop)
    refreshed.crystallise("operator", "text.normalize", source)
    report = sync_fabric(refreshed.home, sop_root=sop)
    assert report["ok"] is True
    assert all(item["kind"] != "stale_local_resolver" for item in report["conflicts"])


def test_ownership_leak_parser_treats_tracked_repo_as_upstream() -> None:
    porcelain = "\n".join(
        [
            " M agentsop/capabilities/blob.read.json",
            "?? src/agentfabric/sync.py",
            " M tests/test_sync.py",
            " M AGENTS.md",
            "?? .agents/skills/agentfabric/sync-upstream/SKILL.md",
            "?? .fabric/capabilities/text.hash.json",
        ]
    )
    leaks = parse_ownership_leaks(porcelain)
    paths = {item["path"] for item in leaks}
    assert paths == {
        "agentsop/capabilities/blob.read.json",
        "src/agentfabric/sync.py",
        "tests/test_sync.py",
        "AGENTS.md",
        ".agents/skills/agentfabric/sync-upstream/SKILL.md",
    }


def test_ownership_manifest_limits_untracked_feedback(tmp_path: Path) -> None:
    (tmp_path / ".agentfabric-sync.json").write_text(
        json.dumps(
            {
                "version": 1,
                "repo_owned": {"include": ["src/**", "*.md"]},
            }
        ),
        encoding="utf-8",
    )
    porcelain = "\n".join(
        [
            " M tracked-anywhere.bin",
            "?? src/agentfabric/new_module.py",
            "?? DESIGN.md",
            "?? .codex/config.toml",
        ]
    )

    leaks = parse_ownership_leaks(
        porcelain,
        untracked_includes=repo_owned_includes(tmp_path),
    )

    assert {item["path"] for item in leaks} == {
        "tracked-anywhere.bin",
        "src/agentfabric/new_module.py",
        "DESIGN.md",
    }


@pytest.mark.parametrize(
    "manifest",
    [
        '{"version": 1, "repo_owned": {"include": ["src/**",]}}',
        '{"version": 1, "repo_owned": {"include": "src/**"}}',
        '{"version": 1, "repo-owned": {"include": ["src/**"]}}',
        '{"version": 1, "repo_owned": {"include": []}}',
        '{"version": 1, "repo_owned": {"include": ["src/**", 7]}}',
        "[]",
    ],
)
def test_unusable_ownership_manifest_keeps_classification_fail_safe(
    manifest: str, tmp_path: Path
) -> None:
    (tmp_path / ".agentfabric-sync.json").write_text(manifest, encoding="utf-8")

    includes, manifest_feedback = read_repo_ownership(tmp_path)

    assert includes == ("**",)
    assert repo_owned_includes(tmp_path) == ("**",)
    assert [item["path"] for item in manifest_feedback] == [".agentfabric-sync.json"]
    assert ".agentfabric-sync.json" in manifest_feedback[0]["message"]

    leaks = parse_ownership_leaks(
        "\n".join(["?? .codex/config.toml", "?? .fabric/capabilities/text.hash.json"]),
        untracked_includes=includes,
    )

    assert {item["path"] for item in leaks} == {".codex/config.toml"}


def test_absent_ownership_manifest_stays_silent(tmp_path: Path) -> None:
    includes, manifest_feedback = read_repo_ownership(tmp_path)

    assert includes == ("**",)
    assert manifest_feedback == []


def test_sync_report_names_an_unusable_manifest_and_keeps_flagging(tmp_path: Path) -> None:
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    _init_git_repo(checkout)
    sop = _copy_sop(checkout, ["blob.read"])
    (checkout / ".agentfabric-sync.json").write_text(
        '{"version": 1, "repo_owned": {"include": []}}',
        encoding="utf-8",
    )
    (checkout / "examples").mkdir()
    (checkout / "examples" / "new_resolver.py").write_text("VALUE = 1\n", encoding="utf-8")
    fabric = Fabric.init(checkout / ".fabric")

    report = sync_fabric(fabric.home, sop_root=sop, apply=False)

    feedback = report["feedback"]
    manifest_items = [item for item in feedback if item["kind"] == "invalid_ownership_manifest"]
    assert [item["path"] for item in manifest_items] == [".agentfabric-sync.json"]
    assert ".agentfabric-sync.json" in manifest_items[0]["message"]
    leaked = {item["path"] for item in feedback if item["kind"] == "ownership_leak"}
    assert "examples/new_resolver.py" in leaked
    assert not any(path.startswith(".fabric/") for path in leaked)
    assert ".agentfabric-sync.json" in render_sync(report)


def test_shipped_ownership_manifest_covers_every_tracked_top_level() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    try:
        tracked = subprocess.run(
            ["git", "-C", str(repo_root), "ls-files"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:  # pragma: no cover - git missing
        pytest.skip("git is unavailable")
    if tracked.returncode != 0:  # pragma: no cover - not a checkout
        pytest.skip("tests are not running inside a git checkout")

    top_level_dirs = sorted(
        {line.split("/", 1)[0] for line in tracked.stdout.splitlines() if "/" in line}
    )
    assert "examples" in top_level_dirs
    probes = [f"{name}/ownership-probe.md" for name in top_level_dirs]
    porcelain = "\n".join(
        [f"?? {probe}" for probe in probes]
        + ["?? .codex/config.toml", "?? .fabric/capabilities/text.hash.json"]
    )

    leaks = parse_ownership_leaks(
        porcelain,
        untracked_includes=repo_owned_includes(repo_root),
    )

    assert {item["path"] for item in leaks} == set(probes)


def test_cli_scaffold_and_sync(tmp_path: Path, capsys) -> None:
    home = tmp_path / "cli-fabric"
    assert main(["--home", str(home), "set-up"]) == 0
    assert main(["--home", str(home), "scaffold", "text.hash", "--title", "Hash text"]) == 0
    out = capsys.readouterr().out
    assert str(home / "capabilities" / "text.hash.json") in out
    assert main(["--home", str(home), "sync", "--json"]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["ok"] is True
    assert "text.hash" in report["overlay"]
    inspect_home = Fabric(home)
    assert inspect_home.resolution_of("text.hash").origin == "local"
