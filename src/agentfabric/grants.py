from __future__ import annotations

from pathlib import Path

from agentfabric.errors import Denied
from agentfabric.ids import new_grant_id
from agentfabric.store import read_json, write_json
from agentfabric.types import Grant, Principal


class Authority:
    def __init__(self, path: Path, principals: dict[str, Principal]) -> None:
        self.path = path
        self.principals = principals
        self._grants: list[Grant] = []
        self._load()

    def _load(self) -> None:
        raw = read_json(self.path, [])
        self._grants = [Grant(**item) for item in raw]

    def _save(self) -> None:
        write_json(self.path, [grant.__dict__ for grant in self._grants])

    def grants(self) -> list[Grant]:
        return list(self._grants)

    def require_principal(self, principal_id: str) -> Principal:
        principal = self.principals.get(principal_id)
        if principal is None:
            raise Denied(f"unknown principal {principal_id!r}")
        return principal

    def require_privilege(self, principal_id: str, privilege: str) -> Principal:
        principal = self.require_principal(principal_id)
        if not principal.has_privilege(privilege):
            raise Denied(f"principal {principal_id!r} lacks privilege {privilege!r}")
        return principal

    def allow(
        self,
        principal_id: str,
        capability_id: str,
        resource: str | None,
        effects: list[str],
    ) -> None:
        self.require_principal(principal_id)
        resource_key = resource if resource is not None else "*"
        for grant in self._grants:
            if grant.matches(principal_id, capability_id, resource_key, effects):
                return
        raise Denied(
            f"principal {principal_id!r} is not granted {capability_id} "
            f"on {resource_key} with effects {effects}"
        )

    def add(
        self,
        *,
        principal: str,
        capability: str,
        resource: str = "*",
        effects: list[str] | None = None,
    ) -> Grant:
        self.require_principal(principal)
        grant = Grant(
            id=new_grant_id(),
            principal=principal,
            capability=capability,
            resource=resource,
            effects=list(effects or ["*"]),
        )
        self._grants.append(grant)
        self._save()
        return grant
