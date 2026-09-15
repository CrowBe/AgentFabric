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
contracts, crystallised resolvers, grants, workspace). **Upstream is the
git-tracked repository**, not a pair of directories: contracts and runtime
(`agentsop/`, `src/agentfabric/`) are the semantic core, but skills, docs,
tests, packaging, and config are shipped too. Git updates that checkout;
`agentfabric sync` reconciles the Fabric.

## Steps

1. Run `git status --short --branch`, then
   `python3 -m agentfabric sync --check`. The repo-owned path patterns in
   [`.agentfabric-sync.json`](../../../../.agentfabric-sync.json) classify
   untracked paths; tracked paths are already repo-owned. Resolve every item
   under **Ownership feedback** before syncing. Commit deliberate upstream
   contributions. Move machine-specific capabilities and resolvers into their
   `.fabric/` directories. Local harness state outside the include patterns may
   remain untracked.
2. Fetch `main` only after the checkout is clean: `git fetch origin main`.
   On `main`, fast-forward with `git merge --ff-only origin/main`. On a feature
   branch, integrate `origin/main` using the repository's delivery policy.
   Finish when `git merge-base --is-ancestor origin/main HEAD` succeeds. A Git
   content conflict and an AgentFabric catalogue conflict are separate: do not
   use a merge strategy to dismiss the latter.
3. Reinstall if the runtime changed: `python3 -m pip install -e '.[dev]'`.
4. `python3 -m agentfabric sync` (or `--check` first). Read the report.
   Unresolved conflicts must still be present if you run sync again.
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

- Do not edit git-tracked files (contracts, runtime, skills, docs, tests,
  packaging) to express a machine-specific variant.
- Do not `git merge -X ours/theirs` to hide a catalogue collision.
- Do not treat a dirty `.fabric/` as a problem; it is the local Fabric.
