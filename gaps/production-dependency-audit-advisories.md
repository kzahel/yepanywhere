# Production dependency audit reports five ignored advisories

`pnpm audit --prod` currently reports five ignored advisories:

- high, `react-router@7.18.0`, GHSA-qwww-vcr4-c8h2. The affected behavior is
  React Server Components action handling; YA uses client-side
  `BrowserRouter`, not RSC mode.
- moderate, `@hono/node-server@1.19.14`, GHSA-frvp-7c67-39w9. The affected
  helper is Windows `serve-static` path handling; YA does not import that
  helper, although the vulnerable package version remains in the graph.
- moderate, transitive `uuid@9.0.1`, GHSA-w5hq-g745-h8pq. The affected API is
  caller-provided buffers for name-based UUID generation; YA does not call the
  transitive package directly.
- moderate, direct `sanitize-html@2.17.5`, GHSA-g8qq-57p8-ggw5. The exploit
  requires allowed SVG animation markup targeting a link; YA permits neither
  the tags nor their attributes and escapes disallowed embedded HTML. The first
  patched release requires Node 22.12, beyond YA's current Node 20 contract.
- moderate, direct `sanitize-html@2.17.5`, GHSA-jxwj-j7wr-gfrw. The exploit
  requires `textarea` or `xmp` in the allowed-tag set; YA permits neither and
  has a regression that rejects both raw-text tags and the escaped event
  handler. The first patched release requires Node 22.12, beyond YA's current
  Node 20 contract.

Re-audit the exact consuming paths when their triggers fire, then update the
corresponding dependencies with their own compatibility tests.
`pnpm-workspace.yaml` `auditConfig.ignoreGhsas` and `CLAUDE.md`
**Known-unreachable advisories** carry the current justification and revisit
triggers. The former `body-parser` advisory is no longer present; a prior,
distinct direct `sanitize-html` finding was patched in place because that
dependency owns the renderer's output boundary.

Found 2026-08-02 while replacing Marked with markdown-it and auditing the
production renderer dependency graph.
