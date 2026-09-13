# Extending the semantic library

This is how AgentFabric grows. Read it before adding a capability or resolver.

The first-run **example** library is small on purpose: discovery, read, write, a pure transform, an effect, and one composition. `journal.*` is an example domain, not an AgentSOP primitive. Everything else should appear because it recurred, not because we anticipated it.

```
clone → /set-up → example resolvers live
                 ↓
        work proceeds semantically
                 ↓
     fallback / shell for novel work
                 ↓
      notice a recurring deterministic job
                 ↓
         name it (AgentSOP document)
                 ↓
         crystallise a resolver
                 ↓
        later agents invoke the name
```

---

## Capability vs skill vs fallback

| Kind | What it is | When to add |
| --- | --- | --- |
| **Capability** | Fine-grained, deterministic, typed. Same semantic input, same kind of output. No judgement. | The operation will recur and can be backed by ordinary code. |
| **Skill** | Agentic workflow. Chooses *whether* and *when* to call capabilities, talks to the user, handles exceptions. | The pattern is a recipe, not a function. |
| **Fallback / shell** | Broader execution the Fabric does not name. | Novel work, one-offs, investigation. Not a destination for recurring jobs. |

If you need a paragraph of reasoning to decide the output, it is not a capability. If another agent would have to rediscover the same `python -c` or flags, it should become one.

---

## Conventions for a new capability

1. **Prefer an existing name.** `agentfabric inspect` / `agentsop_list`. Invoke that rather than adding a near-duplicate.
2. **Name the operation, not the implementation.** `text.word_count` is a capability. `run_wc_dash_w` is not.
3. **Keep I/O small and strict.** `additionalProperties: false`. Resource handles are ResourceRefs (`$ref: "#/$defs/ResourceRef"`), never paths.
4. **Declare effects honestly.** Pure transforms use `effects: []`. Do not hide writes.
5. **Composition does not widen authority.** `depends_on` is the allow-list a resolver may `ctx.invoke`. Undeclared nested invokes fail. Inner invokes are authorized as the same Principal. Do not mint refs inside a resolver to skip discovery.
6. **Contracts are durable; resolvers are disposable.** Change a resolver freely. Change a document only when the *meaning* changed. If you must break a document, give it a new id.

### Two ways to land a resolver

**Catalogue first** (gap is already named, e.g. `text.word_count`):

```bash
agentfabric invoke text.word_count '{"text":"one two three"}'   # UNRESOLVED
# learn a working implementation via fallback/shell
agentfabric crystallise text.word_count --source-file path/to/resolver.py
```

**New name** (no document yet):

```bash
agentfabric scaffold text.hash --title "Hash text" --description "SHA-256 of a text value."
# edit agentsop/capabilities/text.hash.json — fill input/output
# then either:
#   a) crystallise into .fabric/resolvers/  (environment-specific)
#   b) add src/agentfabric/resolvers/text_hash.py and register it in
#      agentfabric.fabric.BUILTIN_RESOLVERS  (ships with the repo)
```

A resolver is trusted local Python:

```python
def resolve(ctx, input):
    # ctx.invoke(capability_id, input)  — same Principal, grants still apply
    # ctx.locator(ref)                  — implementation locator, resolvers only
    # ctx.issue_ref(kind=..., locator=..., label=...)   # discover/get-or-create; never restamps kind
    # ctx.create_ref(kind=..., locator=..., label=...)  # mint a new resource; refuses collisions
    return {"count": 3}
```

Do not give agents locators. Do not accept locators in capability input.

### Grants

`operator` has `capability=*`. New capabilities are available to the operator immediately.

`guest` is allowlisted per capability. Do not grant `guest` writes, crystallise, or fallback unless the owner of this Fabric says so.

### Tests

If the capability ships in-repo, add a test that:

- invokes it through the Fabric (not by importing the resolver alone),
- rejects extra input fields / locators,
- covers DENIED for a principal without a grant, when authority matters.

---

## What hooks and skills will nag about

This is harness behaviour, not AgentSOP. This repo's Cursor adapter (`.cursor/hooks.json`) notices `fallback.exec`, unresolved catalogue entries, and shell that looks like a deterministic transform (`python -c`, `wc`, `jq`, checksums, …). Other harnesses can ignore those files. Hooks do not block the escape hatch.

When they fire, follow this file rather than repeating the implementation.
