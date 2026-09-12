---
name: notice-gap
description: >
  Notice when AgentFabric work is happening through shell or fallback
  instead of a semantic capability. Use when an invoke returns UNRESOLVED,
  when fallback_exec or python -c / wc / jq / checksum commands solve a
  deterministic job, or when the same implementation-level steps are about
  to be repeated.
---

# Notice a semantic gap

AgentFabric is useful while incomplete. Novel work may use shell. Recurring deterministic work should not.

## When this applies

- `agentfabric invoke` returned `UNRESOLVED`
- You used `fallback_exec` or `agentfabric fallback`
- You ran `python -c`, `wc`, `jq`, `sed`, `awk`, or a checksum to compute a typed result
- A hook injected an "AgentFabric notice" about crystallisation

## What to do

1. Check whether a capability already names this (`inspect` / `agentsop_list`).
2. If yes and unresolved → `/extend-library` path A (crystallise).
3. If no name, and it will recur, and it is deterministic → `/extend-library` path B (scaffold + resolver).
4. If it is judgement, a multi-step recipe, or a one-off → leave it as a skill or as fallback.

Do not block the user. Mention the opportunity, then either crystallise or continue.

Conventions: `agentsop/CONVENTIONS.md`.
