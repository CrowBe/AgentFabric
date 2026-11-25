# AgentFabric

Read [`STRATEGY.md`](STRATEGY.md) before proposing architecture, designs, or code changes.

The `## Vision` section in `STRATEGY.md` is the single alignment surface for this repository. Evaluate every design decision and change against its principles, non-goals, and align/resist criteria.

## Working rules

- Keep shared repository code generic and operator-agnostic. Personal registries, credentials, profiles, and telemetry stay outside git.
- Hold contracts to behavioral tests covering invalid inputs, broken upstreams, and fail-closed boundaries.
- Keep every `.ts`, `.tsx`, `.mjs`, `.js`, `.cjs`, and `.css` file under `src/`, `web/src/`, and `tests/` free of code comments (`//`, `/* ... */`, JSDoc); make naming, types, and structure carry intent. `tests/core/repo-hygiene.test.ts` enforces this.
- Keep repository documentation strictly in the root-level tidy set (`README.md`, `STRATEGY.md`, `AGENTS.md`); do not add docs directories or any other `.md` or `.txt` files (`.claude/skills/**` is exempt as executable agent skills). The same hygiene test enforces this.
