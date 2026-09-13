# AgentFabric

Clone, open this repo in an agent harness, then run **`/set-up`**.

That is the first step. It installs the package if needed, initialises `.fabric/`, and verifies the **example resolved catalogue** (`workspace.discover`, `blob.read`, `blob.create`, `blob.replace`, `text.normalize`, plus example-domain `journal.append` / `journal.digest`). Those journal operations are demos, not AgentSOP primitives. Do not start from Bash.

## How to work here

1. Prefer AgentSOP capabilities (`agentfabric invoke` or MCP `agentsop_invoke`) over shell.
2. ResourceRefs only — never pass filesystem paths as if they were handles. Discovery is how refs enter reachability.
3. When a job is novel, fallback/shell is allowed. When it recurs and is deterministic, crystallise it (`/extend-library`, `agentsop/CONVENTIONS.md`).
4. Skills live under `.agents/skills/agentfabric/`. They are workflows, not capabilities.
5. `.cursor/hooks.json` and `.cursor/mcp.json` are **this repo's Cursor harness adapter**, not part of AgentSOP. They observe gaps and must not block general-purpose execution.

`/set-up` is explicit. `notice-gap` and `extend-library` apply when relevant.
