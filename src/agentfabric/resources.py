from __future__ import annotations

from pathlib import Path

from agentfabric.errors import Denied, KindMismatch, UnknownResource
from agentfabric.ids import new_ref
from agentfabric.store import read_json, write_json
from agentfabric.types import ResourceRecord, ResourceRef


class ResourceRegistry:
    """Managed ResourceRefs. Locators stay inside the fabric."""

    def __init__(self, path: Path, workspace: Path) -> None:
        self.path = path
        self.workspace = workspace.resolve()
        self._records: dict[str, ResourceRecord] = {}
        self._load()

    def _load(self) -> None:
        raw = read_json(self.path, [])
        self._records = {}
        for item in raw:
            record = ResourceRecord(**item)
            self._records[record.ref] = record

    def _save(self) -> None:
        write_json(self.path, [record.__dict__ for record in self._records.values()])

    def all(self) -> list[ResourceRecord]:
        return list(self._records.values())

    def get(self, ref: str) -> ResourceRecord:
        record = self._records.get(ref)
        if record is None:
            raise UnknownResource("ResourceRef is not known to this fabric")
        return record

    def require(self, resource: ResourceRef, *kinds: str) -> ResourceRecord:
        record = self.get(resource.ref)
        if resource.kind != record.kind:
            raise KindMismatch(
                f"ResourceRef kind {resource.kind!r} does not match {record.kind!r}"
            )
        if kinds and record.kind not in kinds:
            raise KindMismatch(f"resource kind {record.kind!r} is not one of {kinds}")
        return record

    def find_by_locator(self, locator: Path) -> ResourceRecord | None:
        resolved = str(locator.resolve())
        for record in self._records.values():
            if record.locator == resolved:
                return record
        return None

    def locator_taken(self, locator: Path) -> bool:
        resolved = locator.resolve()
        if resolved.exists():
            return True
        return self.find_by_locator(locator) is not None

    def issue(
        self,
        *,
        kind: str,
        label: str,
        locator: Path,
        created_by: str,
    ) -> ResourceRecord:
        existing = self.find_by_locator(locator)
        if existing is not None:
            return existing
        return self._insert(kind=kind, label=label, locator=locator, created_by=created_by)

    def create(
        self,
        *,
        kind: str,
        label: str,
        locator: Path,
        created_by: str,
    ) -> ResourceRecord:
        existing = self.find_by_locator(locator)
        if existing is not None:
            raise Denied(
                "create cannot occupy an existing resource locator; "
                "mutation requires a ResourceRef and write authority"
            )
        return self._insert(kind=kind, label=label, locator=locator, created_by=created_by)

    def _insert(
        self,
        *,
        kind: str,
        label: str,
        locator: Path,
        created_by: str,
    ) -> ResourceRecord:
        record = ResourceRecord(
            ref=new_ref(),
            kind=kind,
            label=label,
            locator=str(locator.resolve()),
            created_by=created_by,
        )
        self._records[record.ref] = record
        self._save()
        return record

    def locator_path(self, record: ResourceRecord) -> Path:
        path = Path(record.locator).resolve()
        if not _is_inside(self.workspace, path):
            raise UnknownResource("resource locator is outside the fabric workspace")
        return path


def _is_inside(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False
