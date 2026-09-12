# AgentSOP Experimental 0.1

AgentSOP is a semantic contract for operations an agent may request.

It names **what** is being done, **to which resource**, with **which effects**, and **what success looks like**. It does not name filesystems, APIs, programming languages, or other implementation locators.

AgentFabric is one runtime that honours this contract. The contract is deliberately independent of any particular harness, protocol, or resolver language.

0.1 is small on purpose. It should be extended, not completed.

---

## Why a contract

Without a shared vocabulary, each agent rediscovers how to perform recurring work: which path to read, which command to run, which flags are safe. That is expensive, hard to authorize, and unstable.

With AgentSOP, a useful operation can be named once. A resolver — ordinary trusted code — satisfies the name. Later agents invoke the name.

```
capability document   →  durable
resolver              →  disposable
```

---

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Capability** | A named semantic operation with typed input and output. |
| **Resource** | A thing in the environment that an operation may act on. |
| **ResourceRef** | An opaque, fabric-managed handle to a Resource. Not a path, URL, or bearer token. |
| **Principal** | An identity that may be granted authority. |
| **Effect** | A declared consequence of invocation (`discover`, `read`, `create`, `write`, `append`). |
| **Grant** | Authority for a Principal to invoke a Capability, optionally limited to Resources and Effects. |
| **Resolution** | Binding a Capability to a Resolver. A capability may exist and still be unresolved. |
| **Resolver** | Trusted implementation that satisfies a Capability. |
| **Invocation** | A Principal requesting a Capability with an input. |
| **Result** | Typed success, or a failure with a stable code. |
| **Dependency** | A Capability another Capability's resolver may invoke. Used for small composition, not planning. |

Knowing a locator is not possessing a ResourceRef. Possessing a ResourceRef is not having authority to act on it. Discovery, reference, and authority are distinct.

---

## Capability document

A capability is a JSON document matching `schema/capability.schema.json`.

```json
{
  "agentsop": "0.1",
  "id": "blob.read",
  "title": "Read blob",
  "description": "Read the text of a blob or journal resource.",
  "input": {
    "type": "object",
    "properties": {
      "resource": { "$ref": "#/$defs/ResourceRef" }
    },
    "required": ["resource"],
    "additionalProperties": false
  },
  "output": {
    "type": "object",
    "properties": {
      "text": { "type": "string" },
      "bytes": { "type": "integer" }
    },
    "required": ["text", "bytes"],
    "additionalProperties": false
  },
  "effects": ["read"],
  "idempotent": true,
  "authority": {
    "resources": ["input.resource"],
    "effects": ["read"]
  },
  "depends_on": []
}
```

### Fields

- **`id`** — stable name, dotted, lowercase. Example: `journal.append`.
- **`input` / `output`** — JSON Schema objects. 0.1 uses a small subset: `object`, `string`, `integer`, `array`, `boolean`, `required`, `additionalProperties`, `enum`, and `$ref` to `ResourceRef`.
- **`effects`** — declared consequences. Empty for pure transformations.
- **`idempotent`** — if true, a caller may supply an `idempotency_key` and a runtime may replay a prior Result.
- **`authority.resources`** — input paths that are ResourceRefs the caller must be allowed to act on. Empty when the operation does not consume a reference (discovery, creation, pure data).
- **`authority.effects`** — effects that must be granted. Usually the same as `effects`.
- **`depends_on`** — capability ids a resolver may invoke. Composition reuses resolvers; it does not widen authority or mint references.

Resolution status is **not** part of the document. Contracts are durable; whether a resolver currently exists is a runtime fact.

---

## ResourceRef

```json
{ "ref": "rf_ab12cd34ef56", "kind": "blob" }
```

- `ref` is issued by a fabric. Callers cannot manufacture a valid handle from a path or URL.
- `kind` is a coarse semantic class (`blob`, `journal`, …). It is not a locator.
- Additional properties are forbidden, so locators cannot be smuggled in.

Discovery may return a human `label` *alongside* a ResourceRef. The label is not an implementation locator and cannot be substituted for a ref.

A fabric may store an implementation locator internally. Agents are not given it.

---

## Effects

0.1 defines five effects. New ones can be added later.

| Effect | Typical meaning |
| --- | --- |
| `discover` | Observe that resources exist. |
| `read` | Observe content. |
| `create` | Introduce a new resource. |
| `write` | Replace content. |
| `append` | Add to existing content. |

Pure transformations declare `effects: []`.

---

## Success and failure

Every invocation yields one Result:

```json
{ "ok": true, "capability": "blob.read", "invocation_id": "inv_…", "output": { "text": "…", "bytes": 12 } }
```

```json
{ "ok": false, "capability": "text.word_count", "invocation_id": "inv_…", "error": { "code": "UNRESOLVED", "message": "…" } }
```

### Failure codes

| Code | Meaning |
| --- | --- |
| `UNKNOWN_CAPABILITY` | No such capability document. |
| `UNRESOLVED` | Capability exists; no resolver is bound. |
| `DENIED` | Principal lacks a matching grant. |
| `UNKNOWN_RESOURCE` | ResourceRef is not one this fabric issued. |
| `INVALID_INPUT` | Input failed the capability schema. |
| `INVALID_REF` | Value was not a well-formed ResourceRef. |
| `KIND_MISMATCH` | Resource kind did not match what the capability requires. |
| `DEPENDENCY_FAILED` | A composed invocation failed. |
| `RESOLVER_ERROR` | Trusted resolver raised or returned an invalid output. |

These codes are part of the contract. Messages are not.

---

## Resolution and crystallisation

A capability may be present in the catalogue and still be **unresolved**. That is a valid, useful state: the semantic name exists before anyone has crystallised an implementation.

Crystallisation is the act of binding ordinary code as a resolver:

```
UNRESOLVED capability
        ↓
working implementation discovered (often via a broader fallback)
        ↓
resolver registered
        ↓
future invocations use the name, not the implementation
```

AgentSOP does not say who is allowed to register a resolver. That is a fabric trust policy.

---

## Composition

A capability may `depends_on` others. A resolver may invoke those capabilities through the same fabric, so audit, typing, and grants still apply.

0.1 does not include a planner. If a dependency is unresolved or denied, the invocation fails. Derivation must not bypass ResourceRef discovery or authority checks.

---

## What 0.1 is not

- Not a complete catalogue of agent operations.
- Not a wire protocol. Bindings (MCP, CLI, …) sit beside AgentSOP, not inside it.
- Not a security proof. Grants express authority; they do not harden resolvers.
- Not a marketplace, conformance suite, or sandbox.

Extend the contract when a new *kind* of thing appears (a new effect, a new typed handle). Do not extend it merely because a new file format or CLI flag appeared — that belongs in a resolver.
