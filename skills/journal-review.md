# Skill: review the workspace journal

This is an agent *skill* — a reusable workflow — not an AgentSOP capability.

Capabilities are fine-grained deterministic operations (`blob.read`, `journal.digest`, `journal.append`).
Skills compose those operations, plus judgement, into a richer loop.

## When to use

The user wants a short reading of the current journal and an optional new entry.

## Steps

1. Call `agentsop_list`. Prefer resolved capabilities over `fallback_exec`.
2. `workspace.discover` and find the resource with `kind=journal`.
3. `journal.digest` on that ResourceRef.
4. If a new observation is warranted and you are the `operator` principal, `journal.append`.
5. If a needed operation is `UNRESOLVED`, use `fallback_exec` only long enough to learn a working implementation, then `fabric_crystallise` it.
6. Do not pass filesystem paths. If you do not have a ResourceRef, discover one.

## Why this is not a capability

The judgement of *whether* to append, and *what* to write, is agentic. Counting words or appending a string is not.
