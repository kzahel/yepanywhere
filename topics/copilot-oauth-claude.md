# Claude fronting a Copilot gateway (Architecture B)

> **The SDK-built reference architecture is allowed.** Driving the first-party
> Claude Code harness through a local Anthropic-compatible gateway built on the
> official GitHub Copilot SDK uses officially-supported surfaces on both ends.
> YA now accepts a general operator-supplied gateway URL; that transport
> compatibility does not make a claim about how every third-party gateway
> authenticates upstream. Earlier drafts of this topic contained incorrect
> "must not break ToS" caution about the SDK path; that was wrong and is
> retracted (see the correction note below). This topic scopes Architecture B
> and catalogs the harness gaps that distinguish a Copilot-served model from
> first-party Claude Code.

Topic: copilot-oauth-claude

See also: [`copilot-provider.md`](copilot-provider.md) (the shared "Copilot SDK
is sanctioned for third-party embedding" basis + Architecture C),
[`opencode-copilot.md`](opencode-copilot.md) (Architecture A, near-term plan),
[`claude.md`](claude.md) (the Claude provider contract),
[`prompt-cache-keepalive.md`](prompt-cache-keepalive.md) (the one harness feature
this path still loses).

## Correction (2026-06-21): we are free to do this

Earlier versions of this and sibling topics asserted a "dual terms-of-service
risk" and "no legitimate path," built on a comparison blog and search-result
paraphrases. **That was incorrect.** Verified against primary sources, the
architecture below is sanctioned on both ends; nothing here is a ToS workaround.
Details and citations live in [`copilot-provider.md`](copilot-provider.md) §
"Why this is allowed"; the short version:

- **GitHub:** the official Copilot SDK is *for* embedding Copilot in third-party
  apps/services using each user's own subscription (`COPILOT_GITHUB_TOKEN` / OAuth).
  Individual subscribers fall under Section J; API access "through a third party
  product" is contemplated by the terms.
- **Anthropic:** Claude Code officially documents running against a custom
  `ANTHROPIC_BASE_URL` LLM gateway (Anthropic Messages format), including model
  routing across providers. Using the Claude TUI as the front end is supported.

## Architecture B

```
Claude Code (the harness)
    ↓  Anthropic Messages API  (ANTHROPIC_BASE_URL → localhost; ANTHROPIC_AUTH_TOKEN)
Local Anthropic-compatible gateway, implemented on the GitHub Copilot SDK
    ↓  authenticated Copilot SDK/CLI protocol  (user's COPILOT_GITHUB_TOKEN / OAuth)
GitHub Copilot  →  Opus (and other plan-permitted models)   — allowed
```

The translating component is an operator-supplied gateway. The architecture
originally proposed building that gateway on the **official** Copilot SDK; YA's
provider boundary does not require or inspect a particular implementation, and
the current deployment can instead point at a separately operated compatible
server such as `copilot-api`. YA owns only the Claude Code launch and
Anthropic-compatible boundary, not the gateway's GitHub authentication.

Claude Code requirements the gateway must meet (from the LLM-gateway docs):
expose `/v1/messages` (+ `/v1/messages/count_tokens`), forward
`anthropic-beta` / `anthropic-version` headers, and optionally `/v1/models` for
model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`).

## YA implementation (2026-07-27)

YA now exposes this path as the separately selected **Claude Gateway** provider.
Its URL is configured under the regular Claude provider settings, but regular
Claude is never rerouted:

- Every Claude Gateway process receives a per-launch SDK settings overlay
  (Claude Code's `--settings`/flag layer) plus matching child-only environment
  variables. YA never temporarily edits the user's
  `~/.claude/settings.json`, so manual TUIs and concurrent normal-Claude
  sessions cannot race with gateway selection.
- Gateway implementation remains generic unless the catalog endpoint
  explicitly identifies itself. The focused `copilot-api` fork returns
  `X-Copilot-API: 1` from `/v1/models`; after YA observes it, matching child
  launches receive `YEP_COPILOT_API=1`. This supports backend-specific
  instructions without guessing from port 4141, model names, or vendor rows.
- The gateway's `/v1/models` response is authoritative. Claude Code's own
  `supportedModels()` result is deliberately ignored for this provider because
  a gateway launch still reports first-party Claude choices such as Opus/Fable
  that the gateway may not expose. YA omits disabled, non-chat, and utility
  rows, and does not add regular Claude fallbacks.
- The focused `copilot-api` gateway routes each advertised model through an
  endpoint it advertises: native Anthropic Messages when available, an
  Anthropic-to-Responses adapter for Responses-only models, and the existing
  chat-completions adapter otherwise. Explicit endpoint metadata is preserved
  through `/v1/models`; a known unsupported endpoint set is rejected.
  Metadata-less legacy catalogs retain the pre-existing Chat Completions
  fallback as an explicit compatibility exception. Model-specific gateway
  failures remain on the Gateway transport rather than falling through to
  regular Claude.
- YA projects per-model context windows and reasoning levels from the gateway
  catalog. When a model advertises reasoning levels, Claude Gateway exposes
  adaptive thinking and the corresponding effort selector; a model with no
  reasoning metadata gets no invented effort control. The focused gateway maps
  Claude's effort request to the chosen upstream endpoint.
- A live end-to-end check on 2026-07-27 launched Claude Code from YA with
  `gpt-5.6-terra` at low effort through the local Responses adapter. The
  completed transcript contains Claude Code `WebSearch` and `WebFetch` tool
  calls plus a sourced final answer, while YA retained
  `provider=claude-gateway` and the Terra model id in canonical session
  metadata.
- Claude Code still owns its transcript compaction and tool-definition
  compaction on this route. Anthropic first-party prompt caching and YA's
  prompt-cache keepalive are not advertised on this provider. The stated
  reason — that the Copilot backend does not implement Anthropic's cache
  contract — was measured false on 2026-08-06; see *Prompt caching through the
  gateway* below. Whether to advertise the capability is a separate, still-open
  decision.
- The older `claude-ollama` provider is retained only for compatibility. It is
  hidden when it has never been configured or recorded in session metadata,
  and there is no automatic migration during the deprecation grace period.
  Existing users see a dismissible notice directing them to Claude Gateway.

## Known gateway failure: 10s idle cut on large tool calls (fixed in fork)

Diagnosed 2026-08-05 on the `copilot-api` deployment. Symptom: Claude Code
sessions through Claude Gateway abort with "API Error: Connection closed
mid-response" whenever the model emits a *large* tool call (e.g. a big
`Edit`); small edits succeed. Root cause is a stack of two behaviors:

- Copilot's `/v1/messages` sends **no bytes while a `tool_use` input is
  being generated** — all `input_json_delta` events arrive in one burst at
  the end (observed: 41s of silence, then ~1900 deltas at once). Long
  time-to-first-byte responses behave the same way.
- `copilot-api` serves via srvx on Bun, and `Bun.serve` defaults
  `idleTimeout` to 10 seconds of socket silence. Any generation whose
  silent stretch exceeds 10s gets its client connection killed
  mid-stream.

So the operative limit is *seconds of upstream silence*, not message or
context length; output size only correlates because bigger tool inputs take
longer than 10s to generate. Fixed in the `graehl/copilot-api` fork
(`fix: disable Bun idle timeout that cut long generations`) by passing
`bun: { idleTimeout: 0 }` to srvx's `serve()`; a gateway restart is needed
to pick it up. Distinct transient failure with a different signature:
Copilot occasionally 503s Opus requests with "upstream model provider is
currently experiencing high demand", which surfaces as an HTTP error, not a
mid-stream cut.

## Known gateway failure: mid-conversation system message (fixed in fork)

Diagnosed 2026-11-05. Symptom: a Gemini model (`gemini-4-argon`) through
Claude Gateway fails on the opening prompt with `400 invalid_message_role`:
"The last message in a Gemini request must not be from the assistant."

- Claude Code (Agent SDK 0.3.318) now sends its `# Environment` block as a
  `role: "system"` entry in `messages`, after the user turn, so a first
  request's roles are `[user, system]`. Observed through a logging proxy
  for Claude, GPT and Gemini model ids alike.
- `copilot-api`'s Chat Completions and Responses translators mapped every
  non-`user` role to assistant, turning that block into a trailing
  assistant message. Gemini rejects it; GPT models accepted it as an
  assistant prefill, so they saw the environment block as their own partial
  reply. Claude models were unaffected, because `/v1/messages` forwards the
  Anthropic payload unchanged.
- Copilot itself accepts a `system` message in any position for Gemini, so
  no reordering is needed. The `graehl/copilot-api` fork (`Translate
  mid-conversation system messages as system`) now translates the role
  faithfully on both paths; a gateway restart is needed to pick it up.

## Prompt caching through the gateway

Measured 2026-08-06 against `~/copilot-api` on `127.0.0.1:4141` (a ~8.4k-token
system prefix, two calls, reading the returned `usage`). **All three routes
cache; none of them needs the gateway to track anything.**

| model / route | first call | second call |
|---|---|---|
| `claude-sonnet-4.6` → `/v1/messages` | `cache_creation_input_tokens` 8412 | `cache_read_input_tokens` 8412 |
| `gpt-5.6-sol` → `/responses` | `cache_creation_input_tokens` 7617 | `cache_read_input_tokens` 7610 |
| `gemini-3.1-pro-preview` → `/chat/completions` | 9683 fresh input | 4079 cached read |

The mechanism is prefix matching upstream, not state in the gateway:

- `copilot-api` is a stateless translator. It holds no conversation store, no
  parent-turn or response id, and no cache key. `/responses` requests are sent
  with `store: false` and never carry `previous_response_id`; nothing sets
  OpenAI's `prompt_cache_key`.
- On `/v1/messages` the Anthropic payload is forwarded byte-for-byte
  (`src/services/copilot/create-anthropic-messages.ts`), so Claude Code's
  `cache_control` breakpoints survive, and the handler forwards every
  `anthropic-*` request header — including the 1-hour-TTL beta header behind
  `ENABLE_PROMPT_CACHING_1H`.
- On the OpenAI-shaped routes the Anthropic→OpenAI translation has nowhere to
  put `cache_control` and drops it. Caching there is the provider's automatic
  prefix cache, which needs no marker.

**Session prefix caching and forks both work.** Measured with a four-call
sequence that mimics Claude Code — a cached system prefix, a breakpoint on each
turn's last user block, then a fork branching off turn 2 under a *different*
`metadata.user_id` (the field Claude Code varies per session, and the only
per-caller value copilot-api forwards: as `user` on `/chat/completions`, as
`metadata.user_id` on `/responses`):

| call | `claude-sonnet-4.6` → `/v1/messages` | `gpt-5.6-sol` → `/responses` |
|---|---|---|
| turn 1, cold | write 15219, read 0 | write 12417, read 0 |
| turn 2, extends turn 1 | write 15216, **read 15219** | write 12816, **read 12417** |
| fork off turn 2, new session id | write 7623, **read 30435** | write 6421, **read 25233** |
| parent turn 3, after the fork | write 7618, **read 30435** | write 6419, **read 25233** |

Three facts fall out. A growing session re-reads its whole prior prefix and
writes only the new turn, so cost per turn tracks the increment rather than the
transcript. A fork reads the *entire* parent prefix — 30435 = 15219 + 15216,
every token the parent had cached through turn 2 — and pays only for its own
diverging tail; the new session id costs nothing. And the parent's next turn
still reads the same 30435, so the fork neither evicts nor displaces the
branch it came from: both live in the cache at once.

Use a Sonnet-class model for this probe. Haiku's minimum cacheable prefix and
subagent structure differ enough from the Opus-class models these sessions
actually run that a Haiku result would not transfer.

**The 1-hour tier works too.** A fresh prefix sent with
`cache_control: {"type":"ephemeral","ttl":"1h"}` came back as
`ephemeral_1h_input_tokens: 9009, ephemeral_5m_input_tokens: 0` — with or
without the `anthropic-beta: extended-cache-ttl-2025-04-11` header; the same
prefix with a default `cache_control` landed in the 5-minute bucket instead.
The tier follows the request, so `ENABLE_PROMPT_CACHING_1H=1` reaches Copilot
intact.

This also disposes of a worry imported from Claude Code issue #45381, where
turning telemetry off reportedly demoted sessions from the 1-hour tier to the
5-minute one. Gateway sessions here run with
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` set by YA, and their transcripts
show 1-hour cache creation and **zero** 5-minute creation (e.g. 572,847 and
252,798 `ephemeral_1h_input_tokens` against 0 `ephemeral_5m_input_tokens`).
Whatever that issue described is not reproducible on 2.1.220 through this
route.

What remains unmeasured: whether a fork *interleaved* with continued parent
turns still matches once Claude Code has moved its `cache_control` breakpoints
several turns further along. The measured fork branched from a settled prefix.

## Why you'd choose B over A/C

Architecture B is the only one where **Claude Code itself is the harness**, so it
recovers the first-party harness features that OpenCode (A) and a direct YA
Copilot provider (C) lack: Claude Code's modular system prompt, hooks, skills,
Tool Search/tool-definition compaction, effort awareness. You spend the Copilot
budget but keep the Claude Code experience.

**The one feature B still loses: Anthropic first-party prompt caching.** Caching
lives between Claude Code and Anthropic's own endpoint; with a Copilot backend
there is no Anthropic cache. A sophisticated gateway *could* implement its own
cache keyed on the request body (the docs even mention `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
for that), but Copilot's backend is unlikely to honor Anthropic cache-control. So
budget for higher token/latency cost on long sessions. See
[`prompt-cache-keepalive.md`](prompt-cache-keepalive.md).

## Related finding: OAuth into the Claude TUI via env var

Separately useful (and unrelated to Copilot): the Claude TUI accepts a long-lived
OAuth token from **`CLAUDE_CODE_OAUTH_TOKEN`** (generated by `claude
setup-token`, one-year, inference-only), precedence #5 in
[Claude Code's auth order](https://code.claude.com/docs/en/authentication). It
authenticates the user's own **Claude (Anthropic) subscription** — not Copilot —
so it's the clean way to headlessly/remotely auth YA's `claude` provider with a
subscription (no API key, no interactive `/login`). Parked YA idea (belongs in
[`claude.md`](claude.md) if pursued): support `CLAUDE_CODE_OAUTH_TOKEN` /
`apiKeyHelper` for the `claude` provider; `env-filter.ts` already keeps both vars,
so they reach the child today if set — verify and document.

## Harness gaps: OpenCode/Copilot Opus vs first-party Claude Code Opus

Per the user's earlier request — the *quality/feature* differences (not ToS) when
a Copilot-served Opus is reached through OpenCode (A) or a YA Copilot provider (C)
instead of first-party Claude Code. Architecture B closes most of these because
Claude Code is the harness; the model weights are identical in all cases.

- **Prompt caching** — Claude Code's 1-hour TTL + tool-definition caching; absent
  on any Copilot-backed path (the biggest practical gap).
  ([XDA](https://www.xda-developers.com/anthropic-quietly-nerfed-claude-code-hour-cache-token-budget/),
  [morphllm](https://www.morphllm.com/comparisons/opencode-vs-claude-code))
- **System-prompt fidelity** — Claude Code's modular 40+ component prompt vs
  OpenCode's own. ([morphllm](https://www.morphllm.com/comparisons/opencode-vs-claude-code))
- **Tool Search / tool-schema bloat** — Claude Code auto-compacts tool defs;
  OpenCode reloads every MCP schema each turn.
  ([morphllm](https://www.morphllm.com/comparisons/opencode-vs-claude-code))
- **Hooks / skills / plugin ecosystem** — richer and faster-moving on Claude Code.
  ([firecrawl](https://www.firecrawl.dev/blog/claude-code-vs-opencode))
- **Copilot-routing specifics** — premium-request quotas; GitHub-controlled model
  versions (note `*-fast` variants); plan/policy gating of Opus.
- **Sentiment caveat** — much 2026 "Claude Code got worse" talk was Claude Code's
  own resolved March–April regressions, not OpenCode superiority.
  ([InfoQ](https://www.infoq.com/news/2026/05/anthropic-claude-code-postmortem/))

## Bottom line

- **Architecture B is now available in YA** through a configured,
  operator-supplied Claude Gateway.
- It keeps the Claude Code harness while isolating gateway traffic from regular
  Claude sessions, at the cost of gateway operation and the loss of Anthropic
  prompt caching.

## Sources

- [Claude Code Authentication](https://code.claude.com/docs/en/authentication)
  and [LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect)
- [GitHub Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)
- [OpenCode vs Claude Code — morphllm](https://www.morphllm.com/comparisons/opencode-vs-claude-code),
  [firecrawl](https://www.firecrawl.dev/blog/claude-code-vs-opencode)
- [Anthropic Claude Code quality postmortem — InfoQ](https://www.infoq.com/news/2026/05/anthropic-claude-code-postmortem/),
  [cache TTL change — XDA](https://www.xda-developers.com/anthropic-quietly-nerfed-claude-code-hour-cache-token-budget/)

<!-- epistemic status: primary-source verified 2026-06-21 (Claude Code auth +
LLM-gateway docs; GitHub Copilot SDK auth docs). Earlier "dual ToS / no legitimate
path" framing was incorrect and is retracted: Architecture B is sanctioned on both
ends. Remaining caveats are technical (prompt caching) and empirical (confirm Opus
via the SDK), not ToS. -->
</content>
