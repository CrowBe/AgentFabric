# Folding into Weave

AgentFabric is moving into the Weave repository as `packages/agentfabric`, with
the Experimental 0.1 contract separating out as `packages/agentsop`. This is a
package boundary, not a subsystem merge: the runtime keeps its own CLI, MCP
binding, `.fabric/` state, and tests, and stays usable by a harness that has
never heard of Weave.

The plan lives with the destination:

- `ARCHITECTURE.md` §1 and §11 in Weave — package boundaries, what enforces
  them, and the order of operations.
- `docs/PACKAGE-SPLIT.md` in Weave — the symbol-level move map between the
  contract package and the runtime package.

One change lands here first, before the move, because everything else waits on
it: `ResolverContext` exposes `locator(ref) -> Path` and `workspace -> Path`,
which keeps the resolver shape out of `agentsop` and forces every resolver to be
trusted in-process code. Narrowing it to contract vocabulary — `invoke`, `read`,
`write`, `create`, `discover` over ResourceRefs — is behaviour-preserving
against the current suite, and it is what later allows an untrusted resolver to
run out of process with the fabric answering its context calls.

This repository stops taking changes at the merge commit.
