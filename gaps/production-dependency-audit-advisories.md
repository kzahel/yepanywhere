# Dependency audit retains documented unreachable advisories

CI now audits the complete pnpm workspace graph, including native provider test
executables. Three advisory exceptions remain; the canonical table linked below
owns their current paths and revisit triggers.

- moderate, `glob` and `minimatch`, GHSA-3g3m-2fjr-6pw4 and
  GHSA-g3hv-75wg-m249. Production reaches unused GAX cleanup tooling;
  Pi's development-only minimatch calls use default optimization options.
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

2026-11-04: React Router 7.18.2 includes the advisory backport, so its exception
is removed. Vite and Pi are patched; Gemini CLI is removed from installation.
The separate Hono Node adapter 2.1.6 migration removes GHSA-rmxm-3fg6-px4f
and the deprecated WebSocket adapter.
Contributing-model: 6-astra

2026-09-30: four newly reported, non-ignored findings blocked the unchanged
CI campaign lockfile. Compatible patches move `fast-uri` 3.1.7 to 3.1.8 and
`brace-expansion` 2.1.4 to 2.1.7; the latter needs no override. The production
audit again exits zero with only the two then-documented suppressions.
