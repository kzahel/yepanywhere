# Client banners style themselves with `--bg-primary`, which no client theme defines

`ProviderHostDegradedBanner.module.css:9` sets `color: var(--bg-primary, #111)`,
and several client rules reach for the same variable
(`packages/client/src/styles/index.css:2467`, `:3360`, `:5604`, `:6723`,
`:7782`, `:7954`, `:8012`). No client theme block declares it: the only
definitions in the repository are in `site/src/index.css:2` and `:14`, which
belong to the marketing site and are never loaded by the app.

So every one of those rules silently takes its fallback, and the ones with no
fallback — the `color-mix` and gradient uses in `index.css` — resolve to an
invalid value and drop the declaration. The degraded-provider banner happens to
stay legible because `#111` on the red error color is fine, which is why this
has gone unnoticed.

The fix is a decision, not a rename: either declare `--bg-primary` in each
theme block beside `--bg-surface` and friends, or sweep the seven call sites
onto the variable each one actually wanted. Both need a look at the rendered
result in every theme, so this did not belong inside an unrelated change.

The visible failure is worst where a fallback assumes a dark theme: a
`color-mix(… var(--bg-primary, #1a1a1a) …)` box turns opaque grey in the light
theme and hides the muted text inside it. On 2026-11-02 the Monitor-event log
body (`.task-notification-event`) and the system-message detail
(`RenderItemComponent.module.css` `.systemDetail`) were moved onto
`--bg-code`, the variable those log blocks actually wanted. The remaining use
has grown to roughly 70 sites across `index.css`, `renderers.css` and CSS
Modules (`rg 'var\(--bg-primary'`), so the line numbers above are stale.

Found 2026-09-10 while styling the network-filesystem storage banner, which
copied the neighboring banner's colors before the variable turned out to be
undefined.

On 2026-11-08 `pnpm css:check` began freezing every undefined custom property
at its recorded read count (68 for `--bg-primary`, 65 without a fallback), so
the use can no longer grow. The design playground's token page
(`/design.html#/tokens--undefined` on the dev server) lists each name with its
sites, and is the place to compare themes when settling them;
[plan 182](../docs/tactical/182-design-playground-and-shared-controls.md)
step 13 owns that work.
