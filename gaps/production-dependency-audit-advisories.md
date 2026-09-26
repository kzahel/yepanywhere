# Production dependency audit reports two ignored advisories

`pnpm audit --prod` currently reports two ignored advisories:

- high, `react-router@7.18.0`, GHSA-qwww-vcr4-c8h2. The affected behavior is
  React Server Components action handling; YA uses client-side
  `BrowserRouter`, not RSC mode.
- moderate, transitive `uuid@9.0.1`, GHSA-w5hq-g745-h8pq. The affected API is
  caller-provided buffers for name-based UUID generation; YA does not call the
  transitive package directly.
Re-audit the exact consuming paths when their triggers fire, then update the
corresponding dependencies with their own compatibility tests.
`pnpm-workspace.yaml` `auditConfig.ignoreGhsas` and
[Known-unreachable advisories](../docs/development/dependencies.md#known-unreachable-advisories)
carry the current justification and revisit triggers. The former `body-parser`
advisory is no longer present, and the `@hono/node-server` serve-static
advisory (GHSA-frvp-7c67-39w9) was fixed by the 1.19.15 backport; a prior,
distinct direct `sanitize-html` finding was patched in place because that
dependency owns the renderer's output boundary.

Found 2026-08-02 while replacing Marked with markdown-it and auditing the
production renderer dependency graph.
