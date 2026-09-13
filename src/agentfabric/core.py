"""Example catalogue this Fabric's set-up must resolve.

These ids are not AgentSOP primitives. They exercise discovery, consume,
create, replace, transform, an effect, and composition. `journal.*` is an example
domain, not part of the 0.1 contract vocabulary.
"""

EXAMPLE_RESOLVED_CAPABILITIES: tuple[str, ...] = (
    "workspace.discover",
    "blob.read",
    "blob.create",
    "blob.replace",
    "text.normalize",
    "journal.append",
    "journal.digest",
)

