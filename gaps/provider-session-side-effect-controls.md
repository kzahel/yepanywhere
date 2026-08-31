# Provider session side-effect controls remain partly unverified

YA now defaults provider-owned automatic titles, native recap turns, periodic
subagent progress summaries, and prompt suggestions off at the provider/session
boundary. Adapters return a per-option result instead of assuming an omitted or
unknown upstream control worked. The bounded audit found:

| Provider | Current belief and located mechanism |
| --- | --- |
| Claude, Claude Gateway, Claude Ollama | Automatic title generation is present and suppressed with the Agent SDK `title` initialization option. Prompt suggestions and subagent progress summaries are present and controlled by public initialization booleans. Native away-summary generation exists in the Claude TUI but is believed absent from Agent SDK print mode; no public SDK recap control was located. These controls are initialization-only in the current adapter. |
| OpenCode | Automatic title behavior is believed present; the session-create API accepts a concrete `title`, which YA uses to suppress generation. No post-create title-policy control was located. Native recaps, progress-summary generation, and prompt suggestions are believed absent from the inspected adapter/API surface, but were not verified against complete upstream source. |
| Codex | The pinned `0.151.0` app-server source has explicit `thread.name`, `thread/list`, `thread/name/set`, and `thread/name/updated`; YA now uses those surfaces for user-confirmed title reads and writes. No automatic title, away-recap, progress-summary, or prompt-suggestion generator was found. The legacy rollout/database `title` preview remains distinct from the optional native name. |
| Codex OSS | The CLI adapter exposes no corresponding controls or generated metadata rows. The four features are believed absent, without a separate upstream OSS-mode audit. |
| Gemini CLI | No controls or generated rows were located in the adapter. The features are believed absent, but upstream CLI configuration was not exhaustively audited. |
| Gemini ACP | No corresponding Agent Client Protocol capability or adapter control was located. The features are believed absent, but upstream agent behavior was not exhaustively audited. |
| Grok ACP | No corresponding Agent Client Protocol capability or adapter control was located. The features are believed absent, but upstream agent behavior was not exhaustively audited. |
| Pi | No controls or generated rows were located in the adapter. The features are believed absent, but upstream provider source was not exhaustively audited. |
| Future/unknown adapters | Functionality and controls are unknown. YA returns `unknown` for every requested option until the adapter classifies it; omission still requests all options off. |

Existing sessions retain provider state chosen at their original launch. Where
the upstream control is initialization-only, YA can report
`restart-required` but cannot retroactively erase an already persisted title
or other provider output. Closing this gap requires a bounded upstream audit per
provider, adapter tests for every located control, and an update from `unknown`
or "believed absent" to a verified status.

Found 2026-08-12 while making provider-owned session side effects explicitly
default-off.
