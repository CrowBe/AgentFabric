# AgentFabric Strategy

## Vision

<!-- vision: author-approved 2026-11-24 -->

`AgentFabric` exists so that an individual operator can maintain one managed pool of agent capabilities and connect any harness to it in a single configuration step.
It serves a single developer working across changing harnesses and environments, turning disparate MCP servers, CLIs, prompts, resources, and skills into one consistent, centrally authenticated MCP gateway.
It owns exactly one thing: the persistent single-operator gateway that pools, normalises, scopes, authenticates, and routes agent capabilities behind one endpoint.

### One persistent pool, every harness

Connecting a new agent harness requires pointing it at one persistent gateway rather than spawning duplicate servers or re-wiring credentials per harness.
The gateway speaks standard remote MCP over HTTPS with MCP-compliant client authentication so local, web, and cloud harnesses such as Claude on web connect with one endpoint.
The pool unifies tools alongside MCP prompts, resources, and reusable agent skills so switching harnesses carries over both capabilities and context.
Capabilities and skills are served over MCP rather than written into harness-specific local config folders, keeping harness filesystem conventions outside the core.
Named profiles let the operator scope visibility and permissions per harness, workspace, or task without fragmenting the underlying pool.
The gateway is local-first by default for simplicity and secret safety, yet deploys cleanly as a personal remote self-hosted service such as on Cloudflare or exposes a local instance through existing tunnels such as Tailscale Funnel or Cloudflare Tunnel without building custom relay infrastructure.
Remote deployments never tunnel back into local client CLI execution, and instead use explicit server-to-client file or folder sharing where local workspace context is needed.
A broken upstream degrades only its own capabilities while the rest of the pool remains usable.

### Operator-driven, LLM-assisted curation

Adding, normalising, exposing, and governing capabilities is an operator-driven workflow assisted by LLMs, never silent under-the-hood magic.
A built-in web UI gives the operator a clear surface for onboarding sources, editing LLM-drafted normalisations, reviewing telemetry, managing authentication, and answering approval gates.
Newly attached upstream sources can pass through directly under operator-chosen policies such as refresh rules, with normalisation applied as an opt-in overlay drafted by an LLM and finalised by the operator.
Normalisation preserves natural domain identifiers and familiar ergonomics so pooling never breaks schemas or agent UX that models already reason over well.
When agents hit recurring gaps, the gateway offers a path to draft new CLI wrappers or bounded composite tools, blocked behind a human-in-the-loop activation gate by default.

### Balanced discovery guided by deterministic telemetry

Pooling many sources must never dump hundreds of raw definitions into an agent's context window, nor force every routine call through an extra discovery turn.
The gateway balances directly exposed capabilities with search, filtering, and semantic grouping so context stays lean without penalising common workflows.
Built-in telemetry records deterministic facts - calls, latency, errors, and observable session metadata - and surfaces them smoothly to inform operator curation rather than turning into a benchmarking suite or automatically reshuffling exposed tools.
Discovery exposes honest schemas, live availability, and truthful failure codes, rejects unexpected fields instead of ignoring them, and never advertises guarantees an upstream cannot uphold.

### Central authentication and operator-defined safety

Credentials, tokens, and auth lifecycles live centrally in the operator-owned gateway so agents never handle raw secrets or improvise login flows.
When interactive user authentication or re-authentication is required, the gateway fails cleanly and hands back a direct gateway auth URL, falling back to a runnable terminal command only when a local CLI flow requires one.
Gateway-level approval gates for sensitive or destructive actions are configured by the operator with LLM assistance so safety policy survives every harness swap.
Authentication and authorisation fail closed before touching upstream state, never leak secrets or foreign payloads, and never allow observability failures to erase a completed result.

### Scope

`AgentFabric` is a personal MCP capability gateway, not an agent harness, not a planner, not an intra-session code-execution sandbox, not an evaluation benchmark, not a custom tunneling relay, and not a multi-user team platform.
Composite tools may combine pooled sources into clean semantic operations, while arbitrary ad-hoc code execution remains the responsibility of the harness.
Starter adapter recipes are welcome when built on reusable open-source foundations such as OpenConnector rather than hand-maintained bespoke catalogues.
Shared repository code stays operator-agnostic while personal registries, credentials, profiles, and telemetry live outside git, moving across machines and users via configuration export, import, and secret-free sharing.
The repository holds its own contracts to behavioral tests covering invalid inputs, broken upstreams, and fail-closed boundaries.

A change aligns when it makes local, web, or cloud harness swaps closer to a single config step, strengthens operator-driven and LLM-assisted curation or the operator UI, balances context cost against discovery turns with deterministic telemetry, centralises authentication and safety policy across harnesses, makes single-operator setup or config portability smoother, closes capability gaps behind explicit approval, or isolates upstream failures.
A change should be resisted when it couples the pool to one harness or writes into harness-specific config directories, automatically reshuffles exposed tools without operator consent, undermines agent reasoning over familiar schemas, activates agent-authored tools silently without a human gate, exposes raw credentials to agents, fakes guarantees an upstream cannot honour, builds custom relay infrastructure or tunnels remote gateways into local CLI execution, adds an embedded code-mode sandbox or benchmarking suite, introduces multi-user tenancy, commits bespoke service adapter sprawl into core, or leaks personal state into the shared repository.
