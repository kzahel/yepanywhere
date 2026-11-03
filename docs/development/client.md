# Client development

[Contributor guide](../../DEVELOPMENT.md) · [Development docs](README.md)

Commands and code paths below are relative to the repository root unless stated
otherwise.

For client styles or React components using legacy global classes, read
[CSS architecture](../../topics/css-architecture.md). For proposed UI appearance
or interaction, read [UI design](../../topics/ui-design.md); for UI tweaks and
browser verification, read [UI testing](../../topics/ui-testing.md). These
topics own the detailed procedures, including user-owned visual verification.

For React state ownership, effects that publish state, external-store snapshots,
or subscriptions, read [React state patterns](../../topics/react-state-patterns.md).

## Settings Documentation Links

When adding or changing a setting whose effect is not evident from its title
and caption, give its section or row a brief **See _document_** link to the
user guide or owning topic, using the shared `doc` prop. The rules for choosing
and placing the target are in
[settings placement](../../topics/settings-ui-placement.md#documentation-links).

## Client I18n

When adding or changing client UI copy, add English entries in
`packages/client/src/i18n/en.json` and render them through `useI18n().t(...)`
for user-facing sentences, labels, headings, placeholders, tooltips, and aria
text. Do not force brand names, provider names, keyboard keys, terminal commands,
code tokens, protocol values, or source-like renderer text into i18n keys unless
the surrounding copy needs translation.

Add new strings to `en.json` only. Missing keys in the other locale files
fall back to English at runtime, and non-English locales are batch-updated
before a release (a maintainer step). Do not hand-translate per-locale
entries during feature work.

Non-English locales are sparse overlays; maintainer translation updates add
locale values only when an actual translation is available.

Run `pnpm i18n:scan` for a permissive advisory scan of likely raw English prose
in client TSX. It hides low-priority technical labels by default; inspect those
with `pnpm i18n:scan -- --include-info`. Use
`--max-warnings <n>` only when intentionally ratcheting it toward a blocking
check.

To review untranslated sparse-locale backlog without enforcing it on ordinary
code changes, run:

```bash
pnpm i18n:missing
pnpm i18n:missing -- --markdown --limit all > reports/i18n-missing-$(date +%F).md
```

`i18n:missing` reports English keys absent from non-English locale overlays and
always treats missing translations as advisory. Use this for daily or weekly
translation planning rather than as a blocking lint rule.

## Client Console Chatter Budget

When a change touches `packages/client`, or a client console looks
chatty, run `pnpm console:scan` with the pre-commit checks and read
[`topics/console-chatter.md`](../../topics/console-chatter.md) — it carries
the budget policy, the remediation preference order, the measurement
tools, and the ratcheting baseline.
