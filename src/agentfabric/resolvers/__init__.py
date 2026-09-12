from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol

from agentfabric.errors import ResolverError


class ResolverContext(Protocol):
    principal: str

    def invoke(self, capability_id: str, input_value: dict[str, Any]) -> dict[str, Any]:
        ...

    def locator(self, ref: str) -> Path:
        ...

    def issue_ref(self, *, kind: str, locator: Path, label: str) -> dict[str, str]:
        ...

    @property
    def workspace(self) -> Path:
        ...


ResolverFn = Callable[[Any, dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True)
class ResolverBinding:
    capability: str
    kind: str
    label: str
    fn: ResolverFn
    source: str


def load_python_resolver(source: str, path: str) -> ResolverFn:
    namespace: dict[str, Any] = {}
    try:
        compiled = compile(source, path, "exec")
        exec(compiled, namespace, namespace)  # noqa: S102 — resolvers are trusted local code
    except Exception as exc:  # pragma: no cover - syntax errors surface as resolver errors
        raise ResolverError(f"resolver {path} failed to load: {exc}") from exc
    fn = namespace.get("resolve")
    if not callable(fn):
        raise ResolverError(f"resolver {path} does not define resolve(ctx, input)")
    return fn
