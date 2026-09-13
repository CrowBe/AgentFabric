from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agentfabric.audit import AuditLog, preview, utc_now
from agentfabric.catalogue import find_agentsop_root, load_capabilities
from agentfabric.errors import (
    DependencyFailed,
    FabricError,
    InvalidInput,
    ResolverError,
    UndeclaredDependency,
    UnknownCapability,
    Unresolved,
)
from agentfabric.grants import Authority
from agentfabric.ids import new_invocation_id
from agentfabric.resolvers import ResolverBinding, ResolverFn, load_python_resolver
from agentfabric.resolvers import blob_read, blob_write, journal_append, journal_digest
from agentfabric.resolvers import text_normalize, workspace_discover
from agentfabric.resources import ResourceRegistry, _is_inside
from agentfabric.schema import extract_resource_refs, validate_against
from agentfabric.store import read_json, write_json
from agentfabric.types import (
    Capability,
    ErrorBody,
    InvocationRecord,
    Principal,
    ResolutionStatus,
    ResourceRef,
    Result,
)

BUILTIN_RESOLVERS: dict[str, tuple[str, ResolverFn]] = {
    "workspace.discover": ("builtin:workspace.discover", workspace_discover.resolve),
    "blob.read": ("builtin:blob.read", blob_read.resolve),
    "blob.write": ("builtin:blob.write", blob_write.resolve),
    "text.normalize": ("builtin:text.normalize", text_normalize.resolve),
    "journal.append": ("builtin:journal.append", journal_append.resolve),
    "journal.digest": ("builtin:journal.digest", journal_digest.resolve),
}

DEFAULT_SEED = {
    "notes.md": (
        "# Notes\n\n"
        "AgentFabric keeps implementation locators inside the fabric.\n"
        "Agents receive ResourceRefs instead.\n"
    ),
    "journal.md": (
        "# Journal\n\n"
        "## Opening\n\n"
        "The workspace is intentionally small. Recurring work should become capabilities.\n"
    ),
}


@dataclass
class CapabilityView:
    id: str
    title: str
    description: str
    effects: list[str]
    idempotent: bool
    depends_on: list[str]
    status: ResolutionStatus
    resolver: str | None


class InvokeContext:
    def __init__(self, fabric: Fabric, principal: str, *, capability: str) -> None:
        self._fabric = fabric
        self.principal = principal
        self.capability = capability

    @property
    def workspace(self) -> Path:
        return self._fabric.workspace

    @property
    def resources(self) -> ResourceRegistry:
        return self._fabric.resources

    def invoke(self, capability_id: str, input_value: dict[str, Any]) -> dict[str, Any]:
        allowed = self._fabric.capability(self.capability).depends_on
        if capability_id not in allowed:
            raise UndeclaredDependency(
                f"{self.capability} does not declare a dependency on {capability_id}"
            )
        result = self._fabric.invoke(
            self.principal, capability_id, input_value, nested=True
        )
        if not result.ok:
            assert result.error is not None
            raise DependencyFailed(
                f"{capability_id} failed: {result.error.code}: {result.error.message}"
            )
        assert result.output is not None
        return result.output

    def locator(self, ref: str) -> Path:
        record = self._fabric.resources.get(ref)
        return self._fabric.resources.locator_path(record)

    def issue_ref(self, *, kind: str, locator: Path, label: str, created_by: str | None = None) -> dict[str, str]:
        record = self._fabric.resources.issue(
            kind=kind,
            label=label,
            locator=locator,
            created_by=created_by or self.principal,
        )
        return record.public_ref().to_dict()


class Fabric:
    def __init__(self, home: Path, *, sop_root: Path | None = None) -> None:
        self.home = Path(home).resolve()
        self.workspace = self.home / "workspace"
        self.resolvers_dir = self.home / "resolvers"
        self.sop_root = sop_root or find_agentsop_root(self.home)
        self.capabilities: dict[str, Capability] = load_capabilities(self.sop_root)
        state = read_json(self.home / "fabric.json", {})
        self.principals = {
            item["id"]: Principal(id=item["id"], privileges=list(item.get("privileges", [])))
            for item in state.get("principals", [])
        }
        self.resources = ResourceRegistry(self.home / "resources.json", self.workspace)
        self.authority = Authority(self.home / "grants.json", self.principals)
        self.audit = AuditLog(self.home / "audit.jsonl")
        # Process-local only. Persistent replay is deferred until an effectful
        # idempotent capability needs it. The CLI must not advertise this key.
        self._idempotency: dict[str, Result] = {}
        self._resolution = read_json(self.home / "resolution.json", {})
        self._bindings = self._load_bindings()

    def add_principal(self, principal_id: str, privileges: list[str] | None = None) -> Principal:
        principal = Principal(id=principal_id, privileges=list(privileges or []))
        self.principals[principal_id] = principal
        self.authority.principals = self.principals
        write_json(
            self.home / "fabric.json",
            {
                "principals": [
                    {"id": item.id, "privileges": list(item.privileges)}
                    for item in self.principals.values()
                ]
            },
        )
        return principal

    @classmethod
    def init(
        cls,
        home: Path,
        *,
        sop_root: Path | None = None,
        seed: dict[str, str] | None = None,
    ) -> Fabric:
        home = Path(home).resolve()
        home.mkdir(parents=True, exist_ok=True)
        workspace = home / "workspace"
        workspace.mkdir(parents=True, exist_ok=True)
        (home / "resolvers").mkdir(parents=True, exist_ok=True)
        write_json(
            home / "fabric.json",
            {
                "principals": [
                    {
                        "id": "operator",
                        "privileges": ["inspect", "crystallise", "fallback"],
                    },
                    {"id": "guest", "privileges": ["inspect"]},
                ]
            },
        )
        write_json(
            home / "grants.json",
            [
                {
                    "id": "g_operator_all",
                    "principal": "operator",
                    "capability": "*",
                    "resource": "*",
                    "effects": ["*"],
                },
                {
                    "id": "g_guest_discover",
                    "principal": "guest",
                    "capability": "workspace.discover",
                    "resource": "*",
                    "effects": ["discover"],
                },
                {
                    "id": "g_guest_read",
                    "principal": "guest",
                    "capability": "blob.read",
                    "resource": "*",
                    "effects": ["read"],
                },
                {
                    "id": "g_guest_normalize",
                    "principal": "guest",
                    "capability": "text.normalize",
                    "resource": "*",
                    "effects": ["*"],
                },
                {
                    "id": "g_guest_digest",
                    "principal": "guest",
                    "capability": "journal.digest",
                    "resource": "*",
                    "effects": ["read"],
                },
                {
                    "id": "g_guest_word_count",
                    "principal": "guest",
                    "capability": "text.word_count",
                    "resource": "*",
                    "effects": ["*"],
                },
            ],
        )
        write_json(home / "resources.json", [])
        write_json(home / "resolution.json", {})
        (home / "audit.jsonl").write_text("", encoding="utf-8")
        files = seed if seed is not None else DEFAULT_SEED
        for name, content in files.items():
            path = workspace / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text(content, encoding="utf-8")
        fabric = cls(home, sop_root=sop_root)
        fabric.invoke("operator", "workspace.discover", {})
        return fabric

    def _load_bindings(self) -> dict[str, ResolverBinding]:
        bindings: dict[str, ResolverBinding] = {}
        for cap_id, (label, fn) in BUILTIN_RESOLVERS.items():
            bindings[cap_id] = ResolverBinding(
                capability=cap_id,
                kind="builtin",
                label=label,
                fn=fn,
                source=label,
            )
        for cap_id, meta in self._resolution.items():
            path = Path(meta["path"])
            if not path.is_absolute():
                path = self.home / path
            source = path.read_text(encoding="utf-8")
            fn = load_python_resolver(source, str(path))
            bindings[cap_id] = ResolverBinding(
                capability=cap_id,
                kind=meta.get("kind", "local_python"),
                label=f"local:{path.name}",
                fn=fn,
                source=str(path),
            )
        return bindings

    def capability(self, capability_id: str) -> Capability:
        cap = self.capabilities.get(capability_id)
        if cap is None:
            raise UnknownCapability(f"unknown capability {capability_id!r}")
        return cap

    def resolution_of(self, capability_id: str, *, _seen: set[str] | None = None) -> CapabilityView:
        cap = self.capability(capability_id)
        seen = _seen or set()
        binding = self._bindings.get(capability_id)
        if binding is None:
            status: ResolutionStatus = "unresolved"
            resolver = None
        else:
            status = "resolved"
            resolver = binding.label
            if cap.depends_on:
                for dep in cap.depends_on:
                    if dep in seen:
                        continue
                    dep_view = self.resolution_of(dep, _seen=seen | {capability_id})
                    if dep_view.status != "resolved":
                        status = "blocked"
                        break
        return CapabilityView(
            id=cap.id,
            title=cap.title,
            description=cap.description,
            effects=list(cap.effects),
            idempotent=cap.idempotent,
            depends_on=list(cap.depends_on),
            status=status,
            resolver=resolver,
        )

    def invoke(
        self,
        principal: str,
        capability_id: str,
        input_value: dict[str, Any] | None = None,
        *,
        idempotency_key: str | None = None,
        nested: bool = False,
    ) -> Result:
        invocation_id = new_invocation_id()
        started = time.perf_counter()
        payload = input_value or {}
        try:
            result = self._invoke(
                principal,
                capability_id,
                payload,
                invocation_id=invocation_id,
                idempotency_key=idempotency_key,
            )
        except FabricError as exc:
            result = Result(
                ok=False,
                capability=capability_id,
                invocation_id=invocation_id,
                error=ErrorBody(code=exc.code, message=exc.message),
            )
        duration_ms = round((time.perf_counter() - started) * 1000, 3)
        self.audit.record(
            InvocationRecord(
                id=invocation_id,
                ts=utc_now(),
                principal=principal,
                capability=capability_id,
                ok=result.ok,
                error_code=None if result.ok else (result.error.code if result.error else None),
                input=preview(payload),
                output_preview=preview(result.output if result.ok else (result.error.to_dict() if result.error else None)),
                duration_ms=duration_ms,
                nested=nested,
            )
        )
        if not nested and not result.ok and result.error and result.error.code == "UNRESOLVED":
            from agentfabric.notice import record as record_opportunity

            record_opportunity(
                self.home,
                kind="unresolved",
                summary=f"{capability_id} is in the catalogue but has no resolver",
                capability=capability_id,
            )
        return result

    def _invoke(
        self,
        principal: str,
        capability_id: str,
        input_value: dict[str, Any],
        *,
        invocation_id: str,
        idempotency_key: str | None,
    ) -> Result:
        cap = self.capability(capability_id)
        if not isinstance(input_value, dict):
            raise InvalidInput("input must be an object")
        typed_input = validate_against(cap.input, input_value)
        refs = extract_resource_refs(cap, typed_input)
        for ref_dict in refs:
            ref = ResourceRef.from_dict(ref_dict)
            self.resources.require(ref)
        resource_keys = [item["ref"] for item in refs] or [None]
        effects = list(cap.authority.get("effects", cap.effects))
        for resource_key in resource_keys:
            self.authority.allow(principal, capability_id, resource_key, effects)

        if cap.idempotent and idempotency_key:
            cache_key = f"{principal}:{capability_id}:{idempotency_key}"
            cached = self._idempotency.get(cache_key)
            if cached is not None:
                return Result(
                    ok=cached.ok,
                    capability=capability_id,
                    invocation_id=invocation_id,
                    output=cached.output,
                    error=cached.error,
                )

        view = self.resolution_of(capability_id)
        if view.status == "unresolved":
            raise Unresolved(
                f"capability {capability_id} has no resolver; crystallise one to make it available"
            )
        if view.status == "blocked":
            missing = [
                dep
                for dep in cap.depends_on
                if self.resolution_of(dep).status != "resolved"
            ]
            raise Unresolved(
                f"capability {capability_id} is blocked on unresolved dependencies: {missing}"
            )
        binding = self._bindings[capability_id]
        ctx = InvokeContext(self, principal, capability=capability_id)
        try:
            output = binding.fn(ctx, typed_input)
        except FabricError:
            raise
        except Exception as exc:
            raise ResolverError(f"resolver {binding.label} raised: {exc}") from exc
        typed_output = validate_against(cap.output, output, path="output")
        result = Result(
            ok=True,
            capability=capability_id,
            invocation_id=invocation_id,
            output=typed_output,
        )
        if cap.idempotent and idempotency_key:
            self._idempotency[f"{principal}:{capability_id}:{idempotency_key}"] = result
        return result

    def crystallise(
        self,
        principal: str,
        capability_id: str,
        source: str,
        *,
        filename: str | None = None,
    ) -> dict[str, str]:
        self.authority.require_privilege(principal, "crystallise")
        cap = self.capability(capability_id)
        safe_name = filename or f"{capability_id.replace('.', '_')}.py"
        path = (self.resolvers_dir / Path(safe_name).name).resolve()
        if not _is_inside(self.resolvers_dir, path):
            raise InvalidInput("resolver path must stay inside the fabric resolvers directory")
        fn = load_python_resolver(source, str(path))
        path.write_text(source if source.endswith("\n") else source + "\n", encoding="utf-8")
        rel = path.relative_to(self.home).as_posix()
        self._resolution[capability_id] = {
            "kind": "local_python",
            "path": rel,
            "crystallised_by": principal,
            "crystallised_at": utc_now(),
        }
        write_json(self.home / "resolution.json", self._resolution)
        self._bindings[capability_id] = ResolverBinding(
            capability=capability_id,
            kind="local_python",
            label=f"local:{path.name}",
            fn=fn,
            source=str(path),
        )
        return {
            "capability": cap.id,
            "resolver": f"local:{path.name}",
            "path": rel,
        }

    def fallback_exec(
        self,
        principal: str,
        command: str,
        *,
        timeout: float = 15.0,
    ) -> dict[str, Any]:
        self.authority.require_privilege(principal, "fallback")
        if not command or not command.strip():
            raise InvalidInput("command must be non-empty")
        import subprocess

        completed = subprocess.run(
            command,
            shell=True,
            cwd=self.workspace,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        record = InvocationRecord(
            id=new_invocation_id(),
            ts=utc_now(),
            principal=principal,
            capability="fallback.exec",
            ok=completed.returncode == 0,
            error_code=None if completed.returncode == 0 else "FALLBACK_NONZERO",
            input={"command": command},
            output_preview=preview(
                {"stdout": completed.stdout, "stderr": completed.stderr, "exit_code": completed.returncode}
            ),
            duration_ms=0,
        )
        self.audit.record(record)
        from agentfabric.notice import record as record_opportunity

        record_opportunity(
            self.home,
            kind="fallback",
            summary="fallback.exec used for work the Fabric does not yet name",
            detail="Prefer crystallising deterministic fallback into a capability.",
            command=command,
        )
        return {
            "ok": completed.returncode == 0,
            "exit_code": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "cwd": str(self.workspace),
            "binding": "fallback.exec",
            "agentsop": None,
            "note": "fallback.exec is a harness escape hatch, not an AgentSOP capability",
        }

    def snapshot(self) -> dict[str, Any]:
        capabilities = [self.resolution_of(cap_id).__dict__ for cap_id in sorted(self.capabilities)]
        from agentfabric.notice import open_opportunities

        resolved = {cap["id"] for cap in capabilities if cap["status"] == "resolved"}
        return {
            "home": str(self.home),
            "agentsop": "0.1",
            "capabilities": capabilities,
            "principals": [
                {"id": p.id, "privileges": list(p.privileges)}
                for p in self.principals.values()
            ],
            "grants": [grant.__dict__ for grant in self.authority.grants()],
            "resources": [record.public_view() for record in self.resources.all()],
            "invocations": self.audit.recent(50),
            "opportunities": open_opportunities(self.home, resolved=resolved),
        }


def load_or_init(home: Path, *, sop_root: Path | None = None) -> Fabric:
    if not (home / "fabric.json").exists():
        return Fabric.init(home, sop_root=sop_root)
    return Fabric(home, sop_root=sop_root)


def default_home() -> Path:
    import os

    if env := os.environ.get("AGENTFABRIC_HOME"):
        return Path(env)
    return Path.cwd() / ".fabric"


def dumps(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True) + "\n"
