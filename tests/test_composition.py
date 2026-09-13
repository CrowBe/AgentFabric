from __future__ import annotations

from agentfabric.fabric import Fabric


def test_digest_composes_read_and_normalize(fabric: Fabric) -> None:
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    journal = next(item["resource"] for item in discovered["resources"] if item["resource"]["kind"] == "journal")
    result = fabric.invoke("operator", "journal.digest", {"resource": journal})
    assert result.ok
    assert any("Journal" in heading or heading.startswith("#") for heading in result.output["headings"])
    assert result.output["chars"] > 0
    nested = [item for item in fabric.audit.recent() if item.get("nested")]
    caps = {item["capability"] for item in nested}
    assert "blob.read" in caps
    assert "text.normalize" in caps


def test_composition_does_not_bypass_grants(fabric: Fabric) -> None:
    fabric.add_principal("narrow")
    fabric.authority.add(
        principal="narrow",
        capability="journal.digest",
        resource="*",
        effects=["read"],
    )
    discovered = fabric.invoke("operator", "workspace.discover", {}).output
    journal = next(item["resource"] for item in discovered["resources"] if item["resource"]["kind"] == "journal")
    result = fabric.invoke("narrow", "journal.digest", {"resource": journal})
    assert not result.ok
    assert result.error.code == "DEPENDENCY_FAILED"
    assert result.error.message.startswith("blob.read failed: DENIED:")
    assert "DEPENDENCY_FAILED" not in result.error.message


def test_undeclared_nested_invoke_is_rejected(fabric: Fabric) -> None:
    fabric.crystallise(
        "operator",
        "text.word_count",
        '''
def resolve(ctx, input):
    ctx.invoke("text.normalize", {"text": input["text"]})
    return {"count": 1}
''',
    )
    result = fabric.invoke("operator", "text.word_count", {"text": "one two"})
    assert not result.ok
    assert result.error.code == "UNDECLARED_DEPENDENCY"


def test_guest_digest_works_because_guest_can_read(fabric: Fabric) -> None:
    discovered = fabric.invoke("guest", "workspace.discover", {}).output
    journal = next(item["resource"] for item in discovered["resources"] if item["resource"]["kind"] == "journal")
    result = fabric.invoke("guest", "journal.digest", {"resource": journal})
    assert result.ok

