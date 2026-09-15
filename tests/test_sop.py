from __future__ import annotations

import pytest

from agentfabric.catalogue import find_agentsop_root, load_capabilities
from agentfabric.errors import InvalidRef
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
        "blob.create",
        "blob.replace",
        "blob.delete",
        "text.normalize",
        "journal.append",
        "journal.digest",
        "text.word_count",
    }
    assert set(caps) == expected
    digest = caps["journal.digest"]
    assert digest.depends_on == ["blob.read", "text.normalize"]
    assert caps["text.word_count"].effects == []
    assert caps["blob.create"].effects == ["create"]
    assert caps["blob.create"].authority["resources"] == []
    assert caps["blob.replace"].effects == ["write"]
    assert caps["blob.replace"].authority["resources"] == ["input.resource"]
    assert caps["blob.delete"].effects == ["delete"]
    assert caps["blob.delete"].authority["resources"] == ["input.resource"]
    assert caps["blob.delete"].authority["effects"] == ["delete"]


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
    with pytest.raises(InvalidRef, match="locators or extra fields"):
        validate_against(
            schema, {"ref": "rf_abc123", "kind": "blob", "path": "/etc/passwd"}
        )
