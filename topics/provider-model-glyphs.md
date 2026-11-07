# Provider and model compact glyphs (top-right status)

> Compact provider and model glyphs preserve recognizable provider/model
> identity on status surfaces where full names are too wide.

Topic: provider-model-glyphs

## Goal

Replace the verbose provider + model text in the composer header badge with
something that still communicates provider identity at a glance without
occupying as much horizontal space.

`ProviderBadge` surfaces have grown beyond the session header: the New
Session model picker options and its below-composer chip render the same
badge, so the compactness
constraints here apply to all of them. (A session-composer top-right float
shipped briefly and was removed as redundant with the header badge —
2026-07-03.)

The below-composer model chip and the full Model field must also open the same
model-picker layout. On desktop, both use the model picker's wider panel and
top-aligned badge, name/description, and usage columns; the compact trigger
must not fall back to the generic narrow filter-dropdown layout.

## Current implementation (unicode symbols) — not good enough

The current approach assigns abstract unicode symbols (◉, ⌬, ✦, etc.) to
each provider and model family. The symbols were chosen to avoid visual
similarity, but in practice:

- **None are recognizable** without memorization. Users see a random glyph
  and have no intuition for what it maps to.
- **They look alike**. Every candidate in the "geometric shapes" and
  "miscellaneous symbols" unicode blocks is either a filled/hollow circle,
  a star, or a diamond. A user scanning the header cannot distinguish
  `◉` (Claude) from `✦` (Gemini) from `⌬` (Codex) at small sizes.
- Color alone distinguishes nothing in the current glyph approach — the
  glyph is in `color: var(--provider-X)`, but the color is already carried
  by the dot and badge border, so the glyph adds zero signal.

**Exception**: Gemini's `✦` (U+2726 BLACK FOUR POINTED STAR) *is* their
actual brand mark and may be recognized by Gemini-familiar users. Worth
keeping for that provider at least.

## Recognizability analysis

The signals available, roughly ranked by how much identity they carry:

1. **Color** — already used (border, dot). Orange = Anthropic/Claude, green
   = OpenAI/Codex, blue = Gemini, purple = OpenCode.
2. **Text abbreviation** — 2–3 letter labels (`Cl`, `Cd`, `Gm`, `OC`) are
   immediately readable, language-independent, and require zero learning.
3. **Brand-matched shape** — Gemini `✦` is an actual brand icon. Nothing
   comparable exists in unicode for Claude, Codex, or OpenCode.
4. **Abstract symbol** — carries no identity. This is what the current set
   uses and why it fails.

## Recommended approach: short text abbreviations + provider color

Replace the unicode glyphs with 2–3 letter provider abbreviations rendered
in `color: var(--provider-X)`. The color carries the brand; the text
disambiguates within-color cases.

Provider hues are theme-dependent. Dark and light themes keep the same
provider identity but may shift lightness (and hue if needed) so badge
text meets 4.5:1 contrast against that theme's `--bg-surface`. A single
mid-gray for every provider is not the contract. Grok on dark themes is
warm stone, not near-black: `#111827` on `#2f2f2f` is why `Gk 4.6` was
highlightable but looked like only the thinking-colored status dot.

| Provider       | Abbrev | Color var              | Notes |
|----------------|--------|------------------------|-------|
| `claude`       | `Cl`   | `--provider-claude`    | Anthropic orange |
| `claude-ollama`| `Cl↓`  | `--provider-claude`    | `↓` = local download |
| `codex`        | `Cd`   | `--provider-codex`     | OpenAI green |
| `codex-oss`    | `Cd↓`  | `--provider-codex`     | OSS / local |
| `gemini`       | `✦`    | `--provider-gemini`    | Keep brand mark |
| `gemini-acp`   | `✦↓`   | `--provider-gemini`    | ACP = local transport |
| `antigravity`  | `Agy`  | `--provider-gemini`    | Unknown model only; known models show their own family |
| `grok`         | `Gk`   | `--provider-grok`      | xAI Grok |
| `opencode`     | `OC`   | `--provider-opencode`  | OpenCode purple |

Model sub-family abbreviations (appended after provider abbrev):

| Model family | Short | Compact rendering |
|--------------|-------|---------------------------|
| sonnet       | `S`   | `Cl S4.6`                 |
| opus         | `Op`  | `Cl Op4`                  |
| haiku        | `Hk`  | `Cl Hk3`                  |
| (unknown)    | —     | `Cl 4.6` (version only)   |
| gpt-6-astra  | `As`  | `Cd As`                   |
| gpt-6-sol    | `So`  | `Cd So`                   |
| gpt-6-luna   | `Lu`  | `Cd Lu`                   |
| gpt-6.1-sol  | `So 6.1` | `Cd So 6.1`           |
| gpt-6.1-terra| `Te 6.1` | `Cd Te 6.1`           |
| gpt-5.6-sol  | `☀`   | `Cd ☀`                    |
| gpt-5.6-terra| `♁`   | `Cd ♁`                    |
| gpt-5.6-luna | `☾`   | `Cd ☾`                    |
| gpt-daybreak-blue-latest | `Db` | `Cd Db` (blue model text) |
| gpt-5.4-spark | `⚡`   | `Cd ⚡`                    |
| gpt-5.4-codex-spark | `⚡`   | `Cd ⚡`                |
| gpt-5.3-codex-spark | `⚡`   | `Cd ⚡`                |
| gpt-5.4-mini | `5.4m`| `Cd 5.4m`                 |
| gpt-5.4      | `5.4` | `Cd 5.4`                  |
| gpt-4        | `4`   | `Cd 4`                    |
| 2.5-flash    | `2.5f`| `✦ 2.5f`                  |
| 2.5-pro      | `2.5p`| `✦ 2.5p`                  |
| grok-4.6     | `4.6` | `Gk 4.6`                  |
| grok-4.5     | `4.5` | `Gk 4.5`                  |
| grok-build   | —     | `Gk`                      |
| Antigravity / gemini-3.8-flash-high | `Gem 3.8F` | Same model label in normal and condensed headers |

Antigravity names the agent runtime, so its known-model pill identifies the
model family instead: `Gem 3.8F`, `Gem 3.1P`, or the existing Claude/GPT model
abbreviation. The full native model ID and Antigravity remain in the tooltip
and accessible label. Before the runtime reports a model, the fallback is
`Agy`; YA does not guess which model a native default will select.

The pattern is: provider abbrev + space + model short. Fits in ~6–8 chars
for all common cases. Tooltip shows the raw full model ID (already wired).
Named variants use a recognizable semantic glyph where the name supplies one;
the GPT-5.6 Sol/Terra/Luna family is the current example. Sol's `☀` is
deliberately a sun-with-rays glyph that remains legible at status-badge size.
The GPT-6 family uses two-letter names instead (`As`, `So`, `Te`, `Lu`) so
GPT-6 Sol, Terra and Luna stay distinct from their GPT-5.6 namesakes.
Named Astra, Sol, Terra, and Luna models from GPT-6 onward match across numeric
versions, including future minor and major versions. The original GPT-6
labels remain `As`, `So`, and `Lu`; newer versions retain their number
(`Cd So 6.1`, `Cd As 6.1`, `Cd Lu 6.2`). Qualifiers remain visible, such as
`Cd So 6.1-preview`, and unknown family names retain the raw-name fallback.
This also applies to Codex aliases, Codex OSS, and routed model labels. The
full model name stays in the tooltip, accessible label, and model panel;
effort labels such as `High` remain readable alongside the compact name.
Daybreak uses `Db` rather than another sun glyph, and colors that model token
blue independently of the Codex-green provider text, dot, and outline.

## SVG option (medium effort, higher quality)

The project already renders inline `<svg>` elements for toolbar icons. A
`ProviderIcon` component with one `<path>` per provider is consistent with
the existing style and adds no dependencies.

**What we can do without copyright concerns:**
- Simple geometric approximations of brand shapes (not traced from official
  assets): a rounded-square "A" for Anthropic, a circle-spiral for OpenAI,
  a four-star for Gemini, an open-square for OpenCode.
- Size: 14×14px, `fill="currentColor"` so it inherits provider color
  automatically from the surrounding `color` CSS.

**What to avoid:**
- Importing official SVG logo files — licensing is ambiguous for
  reproduction in UI.
- Icon libraries (lucide, heroicons, etc.) — the project avoids adding
  general-purpose icon packages.

SVG is the right long-term answer for recognition but requires someone
to draw the shapes. Text abbreviations are the right short-term fix because
they can be done immediately and are actually *more* recognizable than any
non-brand unicode glyph.

## Bitmap/image option (not recommended)

`<img src="...">` with small PNGs adds asset-hosting concerns, doesn't
scale with the provider color theming, and is not simpler than inline SVG.

## Implementation note

The current `modelIndicatorText.ts` uses short provider abbreviations
(`Cl`, `Cd`, `OC`) with selected symbolic model-family glyphs for certain
cases (for example spark).
Switching to text abbreviations is a pure data change in that file:
replace `providerGlyphMap` values with strings like `"Cl"`, `"Cd"`, etc.
The rest of the rendering pipeline (density negotiation, tooltip wiring)
stays unchanged.

For Gemini keep `"✦"` — it is brand-recognizable and renders well at small
sizes. Consider keeping it even if other providers move to text.

## Matching contract (unchanged)

See the original contract section: normalize provider key and model string,
apply provider abbreviation, then model suffix rules (longest match first),
keep numeric version segments as plain text, full model ID in tooltip.
