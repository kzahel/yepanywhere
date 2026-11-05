# GitHub Copilot as a YA backend via the official Copilot SDK

> GitHub ships an **official Copilot SDK** for embedding Copilot in third-party
> apps/services using each user's own subscription. That makes "use my Copilot
> entitlement (including Claude/GPT/Opus models) from YA" a *sanctioned* path,
> not a reverse-engineered one. This topic is the shared legitimacy + SDK-facts
> hub for the Copilot integration family, and scopes **Architecture C: a direct
> YA Copilot provider** built on the SDK/CLI. Sibling architectures:
> [`opencode-copilot.md`](opencode-copilot.md) (A: via OpenCode) and
> [`copilot-oauth-claude.md`](copilot-oauth-claude.md) (B: Claude Code through
> the copilot-api gateway). C is the recommended next build.

Topic: copilot-provider

The [ACP topic](acp.md) records the separate native Copilot CLI option via
`copilot --acp --stdio`, T3's implementation and a recommendation for sharing
YA's ACP machinery. Architecture C below remains the SDK/CLI proposal; neither
a native Copilot provider nor a generic ACP Registry provider is implemented
in YA. Existing Pi/OpenCode/Gateway routes use other harnesses.

See also: [`opencode-copilot.md`](opencode-copilot.md),
[`copilot-oauth-claude.md`](copilot-oauth-claude.md),
[`provider-abstraction.md`](provider-abstraction.md) /
[`provider-state-machine.md`](provider-state-machine.md) (the `AgentProvider` /
`AgentSession` contract any new provider implements),
[`grok.md`](grok.md) (the isolated-additive provider template to copy),
[`cost-efficiency.md`](cost-efficiency.md).

## Correction recorded (2026-06-21)

Earlier drafts in this family called the Copilot path "probably inferior" and
"TOS-questionable," and one claimed there was no sanctioned way to drive a
non-Copilot client. That was wrong — built on a comparison blog and search
paraphrases rather than the governing terms and GitHub's official SDK. The
primary-source position below supersedes it. Credit to the user for pushing back
with specifics.

## The three architectures (all sanctioned)

```
A. OpenCode → Copilot            opencode is the harness; YA drives opencode.
B. Claude Code → copilot-api →   Claude Code is the harness, billed to Copilot
   Copilot                        through the copilot-api translating gateway.
C. YA → Copilot SDK runtime →    the Copilot runtime is the harness; a first-class
   Copilot                        YA `copilot` provider supervises it via the SDK.
```

A is [`opencode-copilot.md`](opencode-copilot.md); B is
[`copilot-oauth-claude.md`](copilot-oauth-claude.md); C is this topic.

## Why this is allowed (primary sources)

- **GitHub Copilot SDK is for third-party embedding.** Its
  [authentication docs](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)
  target "Web applications where users sign in via GitHub" and "SaaS applications
  building on top of Copilot," and "make Copilot API requests on behalf of users
  who authorize your app" — i.e. each user's own Copilot subscription/entitlement.
- **Auth inputs the SDK accepts:** stored OAuth credentials (from a prior
  `copilot` CLI login, in the system keychain); GitHub OAuth user tokens
  (`gho_`, `ghu_`, `github_pat_`); and env vars in priority order
  **`COPILOT_GITHUB_TOKEN`** (recommended), `GH_TOKEN`, `GITHUB_TOKEN`.
- **Terms:** individual Copilot subscribers are governed by **Section J (AI
  Features)** of the GitHub ToS (Business/Enterprise → Copilot Product Specific
  Terms); GitHub's API terms expressly cover "use of the API through a third
  party product that accesses GitHub" (Section H). So a third-party app using a
  user's own Copilot OAuth is contemplated, not prohibited.

### Still to verify by reading

- **Exact Section J text.** Confirmed individuals fall under Section J and that
  API-via-third-party is contemplated; did not read Section J line-by-line for
  the absence of any relevant restriction. Treat "no client restriction" as the
  user's reading, well-corroborated but worth a direct read before relying on it
  in a public doc.

## Verified SDK surface (2026-11-05)

Read from the published package `@github/copilot-sdk` 1.0.28 (MIT; README and
type declarations), which pins Copilot CLI 1.0.105, the CLI installed on the
maintainer host. No session has yet been driven through the SDK; these are
documented contracts, not observed behavior.

- **Transport.** `CopilotClient` speaks JSON-RPC to the Copilot runtime,
  spawned over stdio by default (TCP, an existing URL, or experimental
  in-process FFI are alternatives). Platform packages bundle the runtime, or
  `COPILOT_CLI_PATH` selects an installed CLI. This is the TUI-independent
  host; the CLI's `--acp` mode and `-p --output-format json` are thinner
  alternatives that YA does not need.
- **Sessions.** `createSession`/`resumeSession` with caller-chosen ids,
  `listSessions` (cwd, git root, branch, summary), `getEvents`,
  `deleteSession`, `abort`, `setModel`. Runtime state lives under
  `~/.copilot` (`session-state/`, `session-store.db`); `baseDirectory`
  relocates it. `mode: "copilot-cli"` (default) reuses the user's CLI
  configuration; `"empty"` is the multi-user server mode.
- **Events.** About 100 typed events, including `assistant.message_delta`,
  `assistant.reasoning_delta`, `tool.execution_*`, `permission.requested`,
  `subagent.*`, `assistant.usage`, `session.quota_observation`,
  `session.compaction_*`, `session.title_changed` and `session.todos_changed`.
- **Permissions and input.** `onPermissionRequest` approves or denies each
  tool call; omitted, requests stay pending as events. `onUserInputRequest`
  and `onElicitationRequest` carry `ask_user`. Managed enterprise settings
  make `approveAll` throw, so YA's approval UI must be real there.
- **Model catalog.** `listModels()` returns per model: policy state
  (`enabled`/`disabled`/`unconfigured`, reflecting admin choices), billing
  multiplier and token prices, context and output limits, vision, whether
  effort is supported, `supportedReasoningEfforts` and
  `defaultReasoningEffort`. Effort levels are per model, not fixed; the
  SDK's effort union is `low`…`max`. `allowedModels` restricts a session to
  exact ids.
- **Copilot additions and their switches.**

  | Addition | Switch |
  |---|---|
  | Subagents (the built-in `task` tool) | `excludedTools: ["task"]`; `customAgents` with per-agent model/effort; `includeSubAgentStreamingEvents` |
  | Auto model routing | only when `model: "auto"`, tiered by `capi.autoTier` / `setAutoTier`; a concrete model never routes |
  | Autopilot continuation | `autopilot: { continuationEnabled, maxContinues }` (default five) |
  | Memory | `memory` configuration |
  | Cross-session store | `enableSessionStore` |
  | Automatic compaction | `infiniteSessions` (enabled, 0.80/0.95 thresholds) |
  | Built-in GitHub MCP servers | `mcpServers`, tool filters |
  | Custom instructions (`AGENTS.md` etc.) | loaded by default; `skipCustomInstructions`, `instructionDirectories` |
  | System prompt | `systemMessage` append, per-section customize, or replace |

  The README also mentions a multi-model "fusion" routing feature, which a
  plain concrete-model session should not engage; confirm empirically.

## Observed runtime wire and the gateway hop (2026-11-05)

Captured by pointing Copilot CLI 1.0.105 at a logging pass-through proxy
with `COPILOT_API_URL` and running one-shot `copilot -p` turns that made one
shell tool call, on `claude-sonnet-5.5` and `gpt-5.6-terra`. These are
observed behavior on the maintainer's individual account.

- **Server/TUI split.** The interactive TUI spawns its runtime as
  `copilot --server --port 0 --managed-server` (plus `--model`, `--agent`,
  `--name`, `--log-dir`, `--yolo` when set), discovers it through a local
  managed-server registry, and `--connect [sessionId]` attaches to a
  session. `--headless`, `--server` and `--acp` all select the non-TUI
  entry. That headless runtime is what the SDK spawns, so Architecture C
  supervises the same process the TUI uses.
- **The runtime calls the Copilot API itself.** Its API base is
  `copilotUrl || COPILOT_API_URL || <account endpoints.api>`. Mission
  Control and cloud-session URLs derive from the same base, so a redirect
  must pass `/agents/*` and `/mcp/readonly` through too. Nothing in
  Architecture C needs `copilot-api`. The gateway exists only because
  Claude Code (Architecture B) speaks Anthropic Messages to a configurable
  base URL and needs Copilot's token exchange done for it.
- **Endpoint per model family** (`/models` `supported_endpoints`):
  Anthropic models serve `/v1/messages` and `/chat/completions`; GPT-5.x/6.x
  and MAI serve `/responses` plus `ws:/responses`; Grok serves
  `/responses`; Gemini and Kimi serve only `/chat/completions`;
  `gpt-6-luna-decisions` serves a new `/v1/decisions`. The CLI opened the
  WebSocket `/responses` first, then used HTTP POST.
- **Headers the CLI sends.** `copilot-integration-id: copilot-developer-cli`,
  `x-github-api-version: 2026-08-01`, `copilot-harness-id: copilot-sdk`,
  `x-initiator` plus `x-interaction-type`
  (`conversation-user` on the first request of a prompt,
  `conversation-agent` on tool continuations), and stable
  `x-interaction-id`, `x-agent-task-id` and `x-client-session-id` across
  a prompt's requests. Claude requests add
  `anthropic-beta: thinking-binding-controls-2026-08-01,fallback-credit-2026-07-01`.
  `copilot-api` still sends `vscode-chat` and `2025-04-01`. Its catalog
  differed from the CLI's by one row (CLI-only `gpt-5.6-luna-utility`).
- **Request bodies.** Claude: `thinking: {type: "adaptive", display:
  "summarized", block_binding: …}` and `output_config`. Responses:
  `reasoning: {effort, summary: "auto"}`,
  `include: ["reasoning.encrypted_content"]`, `text.verbosity`, and a
  `custom` (freeform) tool next to `function` tools.
- **Per-call billing in the reply.** Both `/v1/messages` and `/responses`
  replies carry a `copilot_usage` object (per token type: count,
  `cost_per_batch`, `batch_size`; plus `total_nano_aiu`). It survives any
  route that passes the reply through unchanged. A translating adapter
  drops it (`copilot-api`'s Anthropic-to-Responses and Chat Completions
  paths). The SDK surfaces the same information as `assistant.usage` and
  `session.quota_observation`.

**Gateway initiator divergence.** `copilot-api`'s `/v1/messages` route marks
a request `agent` whenever the conversation contains any assistant message,
so every Claude Gateway prompt after the first is sent as agent-initiated,
where the official client sends `user`. If premium requests are charged on
user-initiated requests, as is commonly understood but not verified here,
the gateway under-bills relative to the official client. Changing it is
therefore a billing decision, not a fidelity cleanup. The fork's
`/v1/responses` pass-through (added 2026-11-05) follows the official rule.

## Architecture C — a direct YA `copilot` provider

YA registers a new `copilot` provider (the [`grok.md`](grok.md) isolated-additive
template): new `ProviderName`, a new
`packages/server/src/sdk/providers/copilot*.ts`, additive registration +
`ENABLED_PROVIDERS` gating, no edits to `Process`/`Supervisor`/event bus/other
providers. It drives the Copilot SDK, authenticates from the user's stored
Copilot CLI login / `COPILOT_GITHUB_TOKEN`, exposes the account's Copilot model
set as the SDK reports it, and normalizes SDK events to YA `SDKMessage`s.

Trade-offs vs Architecture A (OpenCode) and B (Claude Gateway):
- **Pro:** no opencode or copilot-api dependency, and no translation of one
  vendor's wire format into another's (the class of defect in
  [`copilot-oauth-claude.md`](copilot-oauth-claude.md) § Known gateway
  failure: mid-conversation system message). The model catalog arrives with
  policy, billing and effort metadata instead of being inferred. The runtime
  talks to the Copilot API with the official client's integration id,
  headers, per-prompt initiator, WebSocket Responses transport and
  per-call `copilot_usage` (see § Observed runtime wire). A gateway must
  reproduce each of these and lags whenever the CLI moves.
- **Harness:** the Copilot runtime is itself the agent harness (its own tool
  loop, compaction, instructions, skills, subagents), so YA is a supervisor,
  as with Codex. Claude Code's own features (its system prompt, hooks, Tool
  Search) are not present; users who want Claude Code on Copilot models keep
  Architecture B.
- **Con:** a new event vocabulary to normalize, and a young SDK whose
  protocol may move; pin the SDK version and record the pinned CLI.

## Implementation / operational considerations (not legitimacy blockers)

- **Single-user local YA:** simplest auth is reuse the `copilot` CLI's stored
  credential or set `COPILOT_GITHUB_TOKEN`. **Multi-user/hosted YA:** register a
  GitHub App and have each user authorize (per-user `gho_`/`ghu_` tokens).
- **Quotas/policy:** Copilot premium-request limits and org policy still apply;
  Opus may require a higher Copilot tier. Surface plan/policy errors clearly.
- **Cost boundary:** as with opencode, ensure ambient model-provider API keys
  don't silently switch billing off the Copilot entitlement (see
  [`opencode-copilot.md`](opencode-copilot.md) P1.3 and
  [`cost-efficiency.md`](cost-efficiency.md)).

## Status / recommendation

Recommendation (2026-11-05): build Architecture C. The SDK now supplies the
TUI-independent host, the policy-aware catalog and the switches below that
the earlier "stay on OpenCode" recommendation lacked. A and B stay available.
Keep B for its one distinct value, running Claude Code as the harness on
Copilot models. Do not route new YA Copilot needs through `copilot-api`;
the runtime already reaches the Copilot API directly with the official
client's wire behavior.

### Plan

1. **Spike (no YA code).** Drive the SDK on the maintainer host: `listModels`
   (policy states, multipliers, per-model efforts), one turn with a tool
   permission round-trip, abort, warm and cold resume, `excludedTools:
   ["task"]` actually removing subagents, a concrete model not engaging auto
   or fusion routing. Record observed event sequences here; they decide the
   event mapping and whether reload reads `getEvents` or the on-disk state.
2. **Provider skeleton.** `copilot` provider per the
   [`provider-abstraction.md`](provider-abstraction.md) contract and the
   [`grok.md`](grok.md) template; runtime lifetime and reload behavior per
   [`reload-safe-provider-runtimes.md`](reload-safe-provider-runtimes.md)
   (one runtime child can host many sessions; decide shared versus
   per-session from the spike). Gate the provider with a server capability
   ([`server-capabilities.md`](server-capabilities.md)).
3. **Catalog and effort.** Models from `listModels`; hide `disabled`, mark
   `unconfigured`, show the billing multiplier. The effort picker offers
   exactly the model's `supportedReasoningEfforts`, defaulting to its
   `defaultReasoningEffort`, and none when unsupported. `auto` appears as an
   explicit model choice with its tier, never as a silent default.
4. **Session options and defaults.** A Copilot options group on the New
   Session form, persisted through the existing New Session defaults ("Set as
   default", Model settings). Subagents follow the server-wide **Subagent
   nesting limit** ([`vanilla-defaults.md`](vanilla-defaults.md) § Known
   Exceptions): `0` excludes `task`. Autopilot continuation, memory, the
   cross-session store and auto routing start off and are per-session
   opt-ins (user-directed 2026-11-05). This departs from Copilot CLI's own
   defaults, so it lands as a recorded exception in `vanilla-defaults.md`
   with the implementation.
5. **Interaction surfaces.** Permission requests to YA approvals,
   `ask_user`/elicitation to YA's question UI, `subagent.*` to
   [`provider-child-sessions.md`](provider-child-sessions.md),
   `assistant.usage` and `session.quota_observation` to
   [`session-usage-accounting.md`](session-usage-accounting.md).

Hosted multi-user YA needs per-user GitHub App tokens
(`gitHubTokenProvider`); out of scope until that deployment exists.

## Sources

- [GitHub Copilot SDK authentication](https://docs.github.com/en/copilot/how-tos/copilot-sdk/authenticate-copilot-sdk/authenticate-copilot-sdk)
- `@github/copilot-sdk` 1.0.28 on npm: README and `dist/types.d.ts`
  (source repository `github/copilot-agent-runtime`, `src/sdk/nodejs`)
- [GitHub Terms for Additional Products and Features (Section H, API via third-party)](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)
- [GitHub Terms of Service — Section J (AI Features)](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service)

<!-- epistemic status: GitHub Copilot SDK auth docs + GitHub ToS direction,
verified 2026-06-21; SDK surface read from the published 1.0.28 package on
2026-11-05, not yet exercised. Runtime wire behavior captured 2026-11-05
from Copilot CLI 1.0.105 through a logging proxy (two one-shot turns).
Full Section J text not directly verified.
Supersedes earlier "probably inferior / TOS-questionable" framing. -->
</content>
