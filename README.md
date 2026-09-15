# AgentFabric

A small runtime that lets an agent work through **stable semantic capabilities** instead of rediscovering implementation every time.

This repository is an MVP. It is trying to prove a loop, not to cover every operation an agent might need.

```
Agent encounters a task
        ↓
AgentSOP capability exists
        ↓
AgentFabric resolves it through known code
        ↓
Agent invokes the semantic capability
        ↓
Result is returned consistently
```

And the bootstrap path when the Fabric is incomplete:

```
Capability unavailable
        ↓
User/agent determines how to perform it
        ↓
Resolver is created
        ↓
Capability becomes available
        ↓
Future agents use the capability rather than rediscovering implementation
```

Contracts are durable. Resolvers are disposable. Resolvers in this MVP are trusted local Python.

---

## What is here

| Layer | Where | Role |
| --- | --- | --- |
| **AgentSOP Experimental 0.1** | [`agentsop/`](agentsop/) | Semantic contract: capabilities, typed I/O, ResourceRefs, effects, grants, success/failure, resolution, small composition. |
| **AgentFabric runtime** | [`src/agentfabric/`](src/agentfabric/) | Principals, ResourceRefs, grants, resolvers, invocation, audit. Thin on purpose. |
| **Binding** | CLI + [`src/agentfabric/bindings/mcp.py`](src/agentfabric/bindings/mcp.py) | How an existing agent harness talks to the Fabric. Not part of AgentSOP. |
| **Skills** | [`.agents/skills/agentfabric/`](.agents/skills/agentfabric/) | Namespaced harness skills. `/set-up` is the clone-path command. `/extend-library` and `notice-gap` grow the catalogue. `/sync-upstream` reconciles a locally evolved Fabric. Not part of AgentSOP. |
| **Hooks** | [`.cursor/hooks.json`](.cursor/hooks.json) | Cursor harness adapter: observe fallback/shell and remind the agent to crystallise. Not part of AgentSOP; do not block the escape hatch. |
| **Conventions** | [`agentsop/CONVENTIONS.md`](agentsop/CONVENTIONS.md) | How to add a capability without leaking locators or widening authority. Local overlay vs upstream shipping, and `agentfabric sync`. |

AgentSOP does not know about MCP, shells, or Python. The MCP server is one adapter. A second harness should bind to the same capability documents.

---

## Quick start

The intended path is: clone, `cd` into the repo with an agent harness, run **`/set-up`**.

That skill installs the package if needed, runs `agentfabric set-up`, and checks that the **example resolved catalogue** is live. It does not grow the catalogue, and it does not treat `journal.*` as AgentSOP primitives.

```bash
# equivalent without a harness
python3 -m pip install -e '.[dev]'
python3 -m agentfabric set-up
python3 -m agentfabric inspect
```

Local evolution stays inside `.fabric/` (gitignored): overlay capability documents, crystallised resolvers, grants, workspace. Git-tracked repository content is upstream-owned. After pulling upstream changes into the git tree, run `agentfabric sync` — it reconciles catalogues and surfaces semantic conflicts; it does not merge Git.

`agentfabric demo` still walks the original MVP script: semantic work, authority, ResourceRef boundaries, crystallisation, reuse, and the fallback escape hatch.

### Invoke a capability

```bash
agentfabric invoke workspace.discover '{}'
agentfabric invoke -p guest journal.append '{"resource":{"ref":"rf_…","kind":"journal"},"entry":"nope"}'
```

Each CLI `invoke` is a new process. The runtime's idempotency cache is process-local, so the CLI does not accept `--idempotency-key`; that flag would imply replay across commands that it cannot provide. Long-lived bindings such as MCP may still pass `idempotency_key`. AgentSOP still declares `idempotent` on capability documents.

### Crystallise the unresolved capability

A fresh Fabric ships `text.word_count` in the catalogue with **no resolver**.

```bash
agentfabric invoke text.word_count '{"text":"one two three"}'
# → UNRESOLVED

agentfabric crystallise text.word_count --source-file examples/resolvers/text_word_count.py

agentfabric invoke text.word_count '{"text":"one two three"}'
# → {"count": 3}
```

### Talk to a real agent

The MCP binding is stdio JSON-RPC. Point a harness at:

```bash
agentfabric mcp --principal operator
```

Project MCP config lives in [`.cursor/mcp.json`](.cursor/mcp.json). Tools:

| Tool | What it is |
| --- | --- |
| `agentsop_list` / `agentsop_invoke` | Semantic catalogue and invocation |
| `fabric_inspect` / `fabric_crystallise` | Control plane (privileged) |
| `fallback_exec` | **Not** AgentSOP. Broader execution for novel work the Fabric does not yet name. |

The configured principal is a binding concern. Agents do not choose their own identity on each call.

---

## Capability set

Enough to exercise different parts of the model, small enough to hold in your head. This is a **demo catalogue**, not the AgentSOP primitive set. `journal.*` is an example domain.

| Capability | Why it is here | Ships resolved? |
| --- | --- | --- |
| `workspace.discover` | Resource discovery; introduces ResourceRefs | yes |
| `blob.read` | Resource consumption | yes |
| `blob.create` | Resource creation; fabric chooses the locator; never replaces | yes |
| `blob.replace` | Ref-scoped mutation of an existing blob | yes |
| `text.normalize` | Pure transformation, no resource | yes |
| `journal.append` | Example effectful operation | yes |
| `journal.digest` | Example composition via `depends_on` → `blob.read` + `text.normalize` | yes |
| `text.word_count` | Crystallisation target | **no** |

Composition reuses resolvers. Nested invokes are limited to the parent capability's `depends_on`. The live catalogue must name every dependency and must be acyclic (`INVALID_CATALOGUE` at load). It does not mint ResourceRefs and it does not widen authority: inner invocations are authorized as the same Principal.

---

## Authority and ResourceRefs

A fresh Fabric has two principals:

- **`operator`** — all capabilities, plus privileges `inspect`, `crystallise`, `fallback`. `inspect` here is control-plane: recent invocation payloads are included.
- **`guest`** — discover, read, normalize, digest, and (once crystallised) word count. Cannot create, replace, append, inspect, crystallise, or use the fallback. Catalogue discovery uses `agentsop_list`, which does not include audit payloads.

```
knowing a locator  ≠  possessing a ResourceRef  ≠  having authority to act on it
```

`blob.create` accepts a *label*, not a path. Labels such as `../../etc/passwd` are reduced to a safe basename inside the fabric workspace. A colliding label is a naming hint only: create allocates a new locator and ResourceRef rather than replacing the existing resource. Mutation uses `blob.replace` with that resource's ResourceRef, and is authorized against the ref. Passing `{ "ref": "rf_deadbeef", "kind": "blob" }` that the fabric never issued fails with `UNKNOWN_RESOURCE`. Extra fields such as `path`, or a `ref` that does not match `rf_` plus lowercase alphanumerics, fail with `INVALID_REF`.

The owner of the Fabric chooses the trust model. AgentFabric only provides the mechanism.

---

## Inspect

```bash
agentfabric inspect
```

The CLI inspect command is **owner/control-plane**. It runs locally against the Fabric home and includes recent invocation input/output previews. That is distinct from agent-safe discovery (`agentsop_list` / `agentsop_invoke`), which never returns another Principal's payloads.

`fabric_inspect` on MCP requires the `inspect` privilege. The default guest does not have it. If inspect is granted without `crystallise`, the JSON snapshot still redacts other principals' `input` and `output_preview`. Audit payloads are protected data; capability status remains visible.

answers:

- What capabilities exist, and which are resolvable, unresolved, unavailable, or blocked?
- Invocation failures use the matching stable code: `UNRESOLVED`, `RESOLVER_UNAVAILABLE`, or `DEPENDENCY_BLOCKED`.
- Which resolver backs each one? A missing or broken local resolver degrades that capability instead of failing inspect.
- Which principals exist, and what has been granted?
- Which resources are known (as refs and labels, not locators)?
- What was recently invoked?
- What opportunities to extend the library have been noticed?
- What is upstream-owned vs local overlay, and are there sync conflicts?

After the git tree has been updated with upstream commits:

```bash
agentfabric sync
```

---

## Design stance

The MVP is trying to learn whether this shape is useful:

- Does the contract feel natural without leaking implementation?
- Is crystallising a working implementation actually better than running Bash again?
- Can grants sit around capabilities and resources without collapsing into ambient access?
- Do ResourceRefs separate semantic resources from locators?
- Can capabilities stay small and deterministic while skills compose them?
- Can a Fabric evolve locally and still take upstream improvements without a Git merge of machine-specific behaviour?

Explicitly deferred: completeness, resolver marketplaces, competing resolvers, planning, sandboxing, credential custody, polished UI, production security.

Run `pytest` from the repo root after `pip install -e '.[dev]'`.
