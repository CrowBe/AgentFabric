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
| **Binding** | [`src/agentfabric/bindings/mcp.py`](src/agentfabric/bindings/mcp.py) and the CLI | How an existing agent harness talks to the Fabric. Not part of AgentSOP. |
| **Skill example** | [`skills/journal-review.md`](skills/journal-review.md) | An agentic workflow that *uses* capabilities. Skills are not capabilities. |

AgentSOP does not know about MCP, shells, or Python. The MCP server is one adapter. A second harness should bind to the same capability documents.

---

## Quick start

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e '.[dev]'

agentfabric init --force
agentfabric inspect
agentfabric demo
```

`agentfabric demo` walks the MVP script: semantic work, authority, ResourceRef boundaries, crystallisation, reuse, and the fallback escape hatch.

### Invoke a capability

```bash
agentfabric invoke workspace.discover '{}'
agentfabric invoke -p guest journal.append '{"resource":{"ref":"rf_…","kind":"journal"},"entry":"nope"}'
```

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

A Cursor-style snippet lives in [`examples/mcp.json`](examples/mcp.json). Tools:

| Tool | What it is |
| --- | --- |
| `agentsop_list` / `agentsop_invoke` | Semantic catalogue and invocation |
| `fabric_inspect` / `fabric_crystallise` | Control plane (privileged) |
| `fallback_exec` | **Not** AgentSOP. Broader execution for novel work the Fabric does not yet name. |

The configured principal is a binding concern. Agents do not choose their own identity on each call.

---

## Capability set

Enough to exercise different parts of the model, small enough to hold in your head.

| Capability | Why it is here | Ships resolved? |
| --- | --- | --- |
| `workspace.discover` | Resource discovery; issues ResourceRefs | yes |
| `blob.read` | Resource consumption | yes |
| `blob.write` | Resource creation; fabric chooses the locator | yes |
| `text.normalize` | Pure transformation, no resource | yes |
| `journal.append` | Effectful operation | yes |
| `journal.digest` | Composition via `depends_on` → `blob.read` + `text.normalize` | yes |
| `text.word_count` | Crystallisation target | **no** |

Composition reuses resolvers. It does not mint ResourceRefs and it does not widen authority: inner invocations are authorized as the same Principal.

---

## Authority and ResourceRefs

A fresh Fabric has two principals:

- **`operator`** — all capabilities, plus privileges `inspect`, `crystallise`, `fallback`
- **`guest`** — discover, read, normalize, digest, and (once crystallised) word count. Cannot write, append, crystallise, or use the fallback.

```
knowing a locator  ≠  possessing a ResourceRef  ≠  having authority to act on it
```

`blob.write` accepts a *label*, not a path. Labels such as `../../etc/passwd` are reduced to a safe basename inside the fabric workspace. Passing `{ "ref": "rf_deadbeef", "kind": "blob" }` that the fabric never issued fails with `UNKNOWN_RESOURCE`. Extra fields such as `path` fail with `INVALID_INPUT`.

The owner of the Fabric chooses the trust model. AgentFabric only provides the mechanism.

---

## Inspect

```bash
agentfabric inspect
```

answers:

- What capabilities exist, and which are resolvable?
- Which resolver backs each one?
- Which principals exist, and what has been granted?
- Which resources are known (as refs and labels, not locators)?
- What was recently invoked?

---

## Design stance

The MVP is trying to learn whether this shape is useful:

- Does the contract feel natural without leaking implementation?
- Is crystallising a working implementation actually better than running Bash again?
- Can grants sit around capabilities and resources without collapsing into ambient access?
- Do ResourceRefs separate semantic resources from locators?
- Can capabilities stay small and deterministic while skills compose them?

Explicitly deferred: completeness, resolver marketplaces, competing resolvers, planning, sandboxing, credential custody, polished UI, production security.

Run `pytest` from the repo root after `pip install -e '.[dev]'`.
