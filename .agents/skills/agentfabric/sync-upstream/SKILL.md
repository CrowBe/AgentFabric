---
name: sync-upstream
description: >
  Bring upstream AgentFabric changes into a locally evolved Fabric without
  losing machine-specific behaviour or silently merging semantic conflicts.
  Use after git pull/merge, when inspect shows sync conflicts, or when local
  extensions must not be pinned to an old upstream.
---

# Sync a locally evolved Fabric with upstream

This is an agent *skill* — a workflow — not an AgentSOP capability.

Local Fabric evolution is a feature. It belongs in `.fabric/` (overlay
contracts, crystallised resolvers, grants, workspace). Upstream owns
`agentsop/` and `src/agentfabric/`. Git updates the latter; `agentfabric sync`
reconciles the former.

## Steps

1. Inspect the git working tree for **upstream-owned** paths (`agentsop/`,
   `src/agentfabric/`). Dirt there is an ownership leak, not a merge to finish.
   Move machine-specific documents into `.fabric/capabilities/` and resolvers
   into `.fabric/resolvers/` before updating git.
2. Update the implementation tree only once those paths are clean:
   `git pull` / merge of upstream. Do not run a merge tool just to get a
   clean index if the conflict is a local capability vs a shipped one.
3. Reinstall if the runtime changed: `python3 -m pip install -e '.[dev]'`.
4. `python3 -m agentfabric sync` (or `--check` first). Read the report.
5. `python3 -m agentfabric inspect`. The Fabric must remain inspectable.

## Conflicts that need a semantic decision

Do **not** resolve these by producing a clean Git state.

| Kind | Meaning | Typical decision |
| --- | --- | --- |
| `id_collision` | Local overlay and upstream both claim the same id | **Keep local:** rename the overlay to a new id. **Adopt upstream:** delete `.fabric/capabilities/<id>.json`. |
| `stale_local_resolver` | Upstream changed a contract this Fabric crystallised | Re-crystallise after confirming the resolver still matches, or drop the local resolver and use the builtin. |
| `capability_removed` | Upstream dropped an id still used locally | Copy the contract into the overlay to keep it, or drop the local resolver/grant. |

User involvement is for those decisions. Recurring friction of the same kind
means the extension is still happening on the wrong side of the boundary.

## What not to do

- Do not edit shipped capability documents in `agentsop/capabilities/` to
  express a machine-specific variant.
- Do not `git merge -X ours/theirs` to hide a catalogue collision.
- Do not treat a dirty `.fabric/` as a problem; it is the local Fabric.
