"""Core capability ids that a set-up Fabric must resolve.

These are the first-run semantic library — not a complete catalogue.
"""

CORE_CAPABILITIES: tuple[str, ...] = (
    "workspace.discover",
    "blob.read",
    "blob.write",
    "text.normalize",
    "journal.append",
    "journal.digest",
)
