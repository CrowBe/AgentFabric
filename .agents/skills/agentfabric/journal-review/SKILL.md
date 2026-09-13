---
name: journal-review
description: >
  Review the AgentFabric workspace journal through semantic capabilities
  (discover, digest, optionally append). Use when the user wants a reading
  of the journal or to add an entry without touching filesystem paths.
---

# Review the workspace journal

This is an agent *skill* — a reusable workflow — not an AgentSOP capability.

Capabilities are fine-grained deterministic operations (`blob.read`, `journal.digest`, `journal.append`).
Skills compose those operations, plus judgement, into a richer loop.

## Steps

1. Prefer resolved capabilities over `fallback_exec`. List them if unsure.
2. `workspace.discover` and find the resource with `kind=journal`. Use the ResourceRef, not a path.
3. `journal.digest` on that ResourceRef.
4. If a new observation is warranted and you are the `operator` principal, `journal.append`.
5. If a needed operation is `UNRESOLVED`, follow `notice-gap` / `extend-library`.
6. Do not pass filesystem paths. If you do not have a ResourceRef, discover one.

## Why this is not a capability

The judgement of *whether* to append, and *what* to write, is agentic. Counting words or appending a string is not.
