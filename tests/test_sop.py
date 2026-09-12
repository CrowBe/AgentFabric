from __future__ import annotations

from agentfabric.catalogue import find_agentsop_root, load_capabilities
from agentfabric.schema import validate_against, validate_capability_document


def test_finds_experimental_contract() -> None:
    root = find_agentsop_root()
    assert (root / "EXPERIMENTAL-0.1.md").is_file()
    assert (root / "schema" / "capability.schema.json").is_file()


def test_capability_catalogue_is_valid() -> None:
    caps = load_capabilities()
    expected = {
        "workspace.discover",
        "blob.read",
        "blob.write",
        "text.normalize",
        "journal.append",
        "journal.digest",
        "text.word_count",
    }
    assert set(caps) == expected
    digest = caps["journal.digest"]
    assert digest.depends_on == ["blob.read", "text.normalize"]
    assert caps["text.word_count"].effects == []


def test_capability_documents_round_trip() -> None:
    root = find_agentsop_root()
    for path in (root / "capabilities").glob("*.json"):
        import json

        doc = json.loads(path.read_text(encoding="utf-8"))
        cap = validate_capability_document(doc, source=str(path))
        assert cap.id == path.name.removesuffix(".json")


def test_resource_ref_schema_rejects_locators() -> None:
    schema = {"$ref": "#/$defs/ResourceRef"}
    validate_against(schema, {"ref": "rf_abc123", "kind": "blob"})
    try:
        validate_against(
            schema, {"ref": "rf_abc123", "kind": "blob", "path": "/etc/passwd"}
        )
    except Exception as exc:
        assert "unexpected" in str(exc).lower() or "locator" in str(exc).lower() or "INVALID" in type(exc).__name__ or "extra" in str(exc).lower() or "must not" in str(exc).lower()
    else:
        raise AssertionError("locator field should be rejected")
