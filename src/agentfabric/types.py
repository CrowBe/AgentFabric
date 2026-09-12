from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

Effect = Literal["discover", "read", "create", "write", "append"]
Privilege = Literal["inspect", "crystallise", "fallback"]
ResolutionStatus = Literal["resolved", "unresolved", "blocked"]

REF_PATTERN = r"^rf_[a-z0-9]+$"
CAPABILITY_ID_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$"
KNOWN_EFFECTS: tuple[Effect, ...] = ("discover", "read", "create", "write", "append")
KNOWN_PRIVILEGES: tuple[Privilege, ...] = ("inspect", "crystallise", "fallback")


@dataclass(frozen=True)
class ResourceRef:
    ref: str
    kind: str

    def to_dict(self) -> dict[str, str]:
        return {"ref": self.ref, "kind": self.kind}

    @classmethod
    def from_dict(cls, value: Any) -> ResourceRef:
        from agentfabric.errors import InvalidRef

        if not isinstance(value, dict):
            raise InvalidRef("ResourceRef must be an object")
        if set(value.keys()) - {"ref", "kind"}:
            raise InvalidRef("ResourceRef must not include locators or extra fields")
        ref = value.get("ref")
        kind = value.get("kind")
        if not isinstance(ref, str) or not isinstance(kind, str):
            raise InvalidRef("ResourceRef requires string ref and kind")
        if not ref.startswith("rf_"):
            raise InvalidRef("ResourceRef.ref is not a fabric-issued handle")
        if not kind:
            raise InvalidRef("ResourceRef.kind must be non-empty")
        return cls(ref=ref, kind=kind)


@dataclass
class ResourceRecord:
    ref: str
    kind: str
    label: str
    locator: str
    created_by: str

    def public_ref(self) -> ResourceRef:
        return ResourceRef(ref=self.ref, kind=self.kind)

    def public_view(self) -> dict[str, str]:
        return {
            "ref": self.ref,
            "kind": self.kind,
            "label": self.label,
        }


@dataclass
class Principal:
    id: str
    privileges: list[str] = field(default_factory=list)

    def has_privilege(self, privilege: str) -> bool:
        return privilege in self.privileges or "admin" in self.privileges


@dataclass
class Grant:
    id: str
    principal: str
    capability: str
    resource: str
    effects: list[str]

    def matches(
        self,
        principal: str,
        capability: str,
        resource: str | None,
        effects: list[str],
    ) -> bool:
        if self.principal != principal:
            return False
        if self.capability != "*" and self.capability != capability:
            return False
        needed_resource = resource if resource is not None else "*"
        if self.resource != "*" and self.resource != needed_resource:
            return False
        if "*" not in self.effects:
            if not set(effects).issubset(set(self.effects)):
                return False
        return True


@dataclass
class Capability:
    agentsop: str
    id: str
    title: str
    description: str
    input: dict[str, Any]
    output: dict[str, Any]
    effects: list[str]
    idempotent: bool
    authority: dict[str, Any]
    depends_on: list[str]
    source: str = ""

    def to_public_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data.pop("source", None)
        return data


@dataclass
class ErrorBody:
    code: str
    message: str

    def to_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


@dataclass
class Result:
    ok: bool
    capability: str
    invocation_id: str
    output: dict[str, Any] | None = None
    error: ErrorBody | None = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "ok": self.ok,
            "capability": self.capability,
            "invocation_id": self.invocation_id,
        }
        if self.ok:
            data["output"] = self.output
        else:
            data["error"] = self.error.to_dict() if self.error else None
        return data


@dataclass
class InvocationRecord:
    id: str
    ts: str
    principal: str
    capability: str
    ok: bool
    error_code: str | None
    input: dict[str, Any]
    output_preview: Any
    duration_ms: float
    nested: bool = False
