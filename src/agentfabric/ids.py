from __future__ import annotations

import secrets


def new_id(prefix: str, nbytes: int = 8) -> str:
    return f"{prefix}_{secrets.token_hex(nbytes)}"


def new_ref() -> str:
    return new_id("rf")


def new_grant_id() -> str:
    return new_id("g")


def new_invocation_id() -> str:
    return new_id("inv")
