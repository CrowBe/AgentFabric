from __future__ import annotations

from agentfabric.demo import WORD_COUNT_SOURCE
from agentfabric.errors import Denied
from agentfabric.fabric import Fabric


def test_word_count_starts_unresolved(fabric: Fabric) -> None:
    view = fabric.resolution_of("text.word_count")
    assert view.status == "unresolved"
    result = fabric.invoke("operator", "text.word_count", {"text": "one two three"})
    assert not result.ok
    assert result.error.code == "UNRESOLVED"


def test_crystallise_then_reuse(fabric: Fabric) -> None:
    info = fabric.crystallise("operator", "text.word_count", WORD_COUNT_SOURCE)
    assert info["capability"] == "text.word_count"
    view = fabric.resolution_of("text.word_count")
    assert view.status == "resolved"
    assert view.resolver.startswith("local:")
    result = fabric.invoke("operator", "text.word_count", {"text": "one two three"})
    assert result.ok
    assert result.output["count"] == 3
    guest = fabric.invoke("guest", "text.word_count", {"text": "only two"})
    assert guest.ok
    assert guest.output["count"] == 2


def test_guest_cannot_crystallise(fabric: Fabric) -> None:
    try:
        fabric.crystallise("guest", "text.word_count", WORD_COUNT_SOURCE)
    except Denied as exc:
        assert exc.code == "DENIED"
    else:
        raise AssertionError("guest must not crystallise")
    assert fabric.resolution_of("text.word_count").status == "unresolved"


def test_crystallised_resolver_survives_reload(fabric: Fabric) -> None:
    fabric.crystallise("operator", "text.word_count", WORD_COUNT_SOURCE)
    reloaded = Fabric(fabric.home)
    result = reloaded.invoke("operator", "text.word_count", {"text": "a b c d"})
    assert result.ok
    assert result.output["count"] == 4
