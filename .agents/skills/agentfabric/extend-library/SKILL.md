---
name: extend-library
description: >
  Add or crystallise an AgentSOP capability the right way. Use when a
  capability is UNRESOLVED, when fallback/shell solved a recurring
  deterministic job, when scaffolding a new capability document, or when
  the user asks to extend the semantic library.
---

# Extend the semantic library

Read `agentsop/CONVENTIONS.md` and follow it. Do not skip to writing a script that agents will have to rediscover.

## Decide the layer

- **Capability** — deterministic, typed, no judgement. Fine-grained.
- **Skill** — workflow and judgement that *calls* capabilities. Put new skills in `.agents/skills/agentfabric/<name>/SKILL.md`.
- **Fallback** — leave it, if this is truly a one-off.

If you are unsure, inspect first:

```bash
python3 -m agentfabric inspect
python3 -m agentfabric opportunities
```

## Path A — the name already exists (`UNRESOLVED`)

1. Reproduce with `agentfabric invoke <id> '<json>'` (expect `UNRESOLVED`).
2. Learn a working implementation with `fallback` / shell **once**.
3. Write `def resolve(ctx, input): ...` returning the documented output. No locators in the result.
4. `python3 -m agentfabric crystallise <id> --source-file <resolver.py>`
5. Invoke the capability again. It must succeed without the shell.
6. If it should ship in git, also add a builtin resolver under `src/agentfabric/resolvers/` and register it in `BUILTIN_RESOLVERS`. Crystallised `.fabric/resolvers/` are local and disposable.

## Path B — no name yet

1. `python3 -m agentfabric scaffold <dotted.id> --title "..." --description "..."`
   (writes `.fabric/capabilities/<dotted.id>.json`, not the git tree)
2. Edit that overlay document:
   - strict input/output (`additionalProperties: false`)
   - ResourceRefs for resources, never paths
   - honest `effects` and `authority`
   - `depends_on` only if the resolver will `ctx.invoke` those ids
3. Implement a resolver (`crystallise` into `.fabric/resolvers/`).
4. Grant `guest` only if the owner wants that; `operator` already has `*`.
5. Only if it should **ship upstream**: `scaffold --ship`, add a builtin resolver, and a Fabric-level test. That is a contribution, not local evolution.

## Hard rules

- Knowing a path ≠ possessing a ResourceRef ≠ having a grant.
- Composition must `ctx.invoke` dependencies; do not bypass grants.
- Do not treat fallback as the long-term interface for a job you just figured out.
