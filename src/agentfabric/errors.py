from __future__ import annotations


class FabricError(Exception):
    code = "RESOLVER_ERROR"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code is not None:
            self.code = code
        self.message = message

    def as_dict(self) -> dict:
        return {"code": self.code, "message": self.message}


class UnknownCapability(FabricError):
    code = "UNKNOWN_CAPABILITY"


class Unresolved(FabricError):
    code = "UNRESOLVED"


class Denied(FabricError):
    code = "DENIED"


class UnknownResource(FabricError):
    code = "UNKNOWN_RESOURCE"


class InvalidInput(FabricError):
    code = "INVALID_INPUT"


class InvalidCatalogue(FabricError):
    code = "INVALID_CATALOGUE"


class InvalidRef(FabricError):
    code = "INVALID_REF"


class KindMismatch(FabricError):
    code = "KIND_MISMATCH"


class DependencyFailed(FabricError):
    code = "DEPENDENCY_FAILED"


class UndeclaredDependency(FabricError):
    code = "UNDECLARED_DEPENDENCY"


class ResolverError(FabricError):
    code = "RESOLVER_ERROR"
