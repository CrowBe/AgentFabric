from __future__ import annotations

import json
import shutil
from pathlib import Path

from agentfabric.catalogue import find_agentsop_root, merge_catalogue
from agentfabric.cli import main
from agentfabric.fabric import Fabric
from agentfabric.scaffold import scaffold
from agentfabric.schema import validate_capability_document
from agentfabric.sync import parse_ownership_leaks, read_origin, sync_fabric
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


def test_sync_check_does_not_write_origin(fabric: Fabric) -> None:
    before = read_origin(fabric.home)
    report = sync_fabric(fabric.home, sop_root=fabric.sop_root, apply=False)
    assert report["wrote_origin"] is False
    assert read_origin(fabric.home)["recorded_at"] == before["recorded_at"]


def test_ownership_leak_parser_ignores_fabric_and_tests() -> None:
    porcelain = "\n".join(
        [
            " M agentsop/capabilities/blob.read.json",
            "?? src/agentfabric/sync.py",
            " M tests/test_sync.py",
            "?? .fabric/capabilities/text.hash.json",
        ]
    )
    leaks = parse_ownership_leaks(porcelain)
    paths = {item["path"] for item in leaks}
    assert paths == {
        "agentsop/capabilities/blob.read.json",
        "src/agentfabric/sync.py",
    }


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
