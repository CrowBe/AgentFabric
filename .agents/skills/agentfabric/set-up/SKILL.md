---
name: set-up
description: >
  First command after cloning AgentFabric. Installs the package, initialises
  a local Fabric, and verifies the example resolved catalogue is live. Invoke
  explicitly with /set-up after clone or when the fabric is missing.
disable-model-invocation: true
---

# AgentFabric /set-up

This is the clone-path command. Do not start improvising with the shell until it has succeeded.

## Goal

A working Fabric whose **example resolved catalogue** is bound. These are demo capabilities, not AgentSOP primitives. `journal.*` is an example domain.

- `workspace.discover`
- `blob.read`
- `blob.write`
- `text.normalize`
- `journal.append` (example domain)
- `journal.digest` (example composition)

`text.word_count` is *supposed* to remain unresolved until someone crystallises it.

## Steps

Run from the repository root.

1. If `python3 -c "import agentfabric"` fails:

   ```bash
   python3 -m pip install -e '.[dev]'
   ```

2. Initialise and verify:

   ```bash
   python3 -m agentfabric set-up
   ```

   Idempotent. Creates `.fabric/` if needed, binds core resolvers, prints unresolved names and any noticed opportunities.

3. Confirm the output lists every example resolved capability as `resolved`. If any of those items is not resolved, stop and fix that before doing product work.

4. Do **not** invent extra capabilities during set-up. The library grows later, when work recurs, via `/extend-library` and `agentsop/CONVENTIONS.md`.

5. Optional smoke:

   ```bash
   python3 -m agentfabric invoke workspace.discover '{}'
   python3 -m pytest
   ```

## After set-up

- Prefer named capabilities over Bash.
- Skills under `.agents/skills/agentfabric/` teach journal review, noticing gaps, and extending the library.
- Cursor hooks in `.cursor/hooks.json` are a harness adapter (not AgentSOP). They observe fallback/shell and inject a reminder; they must not block general-purpose execution.
