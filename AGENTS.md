# AgentFabric

Read [`STRATEGY.md`](STRATEGY.md) before proposing architecture, designs, or code changes.

The `## Vision` section in `STRATEGY.md` is the single alignment surface for this repository. Evaluate every design decision and change against its principles, non-goals, and align/resist criteria.

## Working rules

- Keep shared repository code generic and operator-agnostic. Personal registries, credentials, profiles, and telemetry stay outside git.
- Hold contracts to behavioral tests covering invalid inputs, broken upstreams, and fail-closed boundaries.
